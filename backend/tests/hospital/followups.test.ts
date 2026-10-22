import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { loadHospitalEnv as loadEnv } from '../../src/hospital/config.js'
import { draftDischargeSummary } from '../../src/hospital/modules/encounters/discharge-draft.js'
import { checkInOpdPaid, newPatient, seedBasics, startTestApi, strongPassword, type TestApi, stopServer } from './helpers.js'

// One application per test file, shared by its describe blocks: stop it when they are all done.
after(stopServer)

const api = '/api/v1'

const open = (t: TestApi, path: string, body: unknown) =>
  fetch(`${t.api.url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({
    status: r.status,
    body: await r.json().catch(() => null),
  }))

describe('password reset requests', () => {
  let t: TestApi
  before(async () => { t = await startTestApi() })
  after(() => t.close())

  it('answers the same whether or not the e-mail address has a login', async () => {
    const nurse = await t.as('nurse')
    const known = await open(t, `${api}/auth/forgot-password`, { email: nurse.email })
    const unknown = await open(t, `${api}/auth/forgot-password`, { email: 'nobody-at-all@example.test' })
    assert.equal(known.status, 202)
    assert.equal(unknown.status, 202)
    assert.deepEqual(known.body, unknown.body)
    assert.equal((await open(t, `${api}/auth/forgot-password`, {})).status, 400)
  })

  it('shows administrators who asked, hides it from others, and clears it when the password is reset', async () => {
    const nurse = await t.as('nurse')
    const staff = (await t.get(`${api}/staff`)).body as { id: string; email: string | null; resetRequestedAt: string | null }[]
    const row = staff.find((s) => s.email === nurse.email)!
    assert.ok(row.resetRequestedAt, 'the request is visible to the administrator')
    assert.equal(staff.filter((s) => s.resetRequestedAt).length, 1, 'the unknown address flagged nobody')

    const seenByNurse = (await nurse.get(`${api}/staff/${row.id}`)).body
    assert.equal(seenByNurse.resetRequestedAt, null)

    const log = (await t.get(`${api}/audit-log?limit=20`)).body as { action: string }[]
    assert.ok(log.some((l) => l.action === 'Password Reset Requested'))

    await t.call('PUT', `${api}/staff/${row.id}/login`, { email: nurse.email, password: strongPassword() })
    const after = (await t.get(`${api}/staff/${row.id}`)).body
    assert.equal(after.resetRequestedAt, null)
  })

  it('ignores people without a login and deactivated accounts', async () => {
    const noLogin = (await t.post(`${api}/staff`, { name: 'No Login', role: 'nurse', department: 'X' })).body
    await open(t, `${api}/auth/forgot-password`, { email: 'no-login@example.test' })
    const gone = (await t.post(`${api}/staff`, { name: 'Gone', role: 'nurse', department: 'X' })).body
    const goneEmail = `gone-${gone.id.slice(0, 8)}@example.test`
    assert.equal((await t.call('PUT', `${api}/staff/${gone.id}/login`, { email: goneEmail, password: strongPassword() })).status, 200)
    await t.call('PATCH', `${api}/staff/${gone.id}`, { active: false })
    await open(t, `${api}/auth/forgot-password`, { email: goneEmail })
    const staff = (await t.get(`${api}/staff`)).body as { id: string; resetRequestedAt: string | null }[]
    assert.equal(staff.find((s) => s.id === noLogin.id)!.resetRequestedAt, null)
    assert.equal(staff.find((s) => s.id === gone.id)!.resetRequestedAt, null)
  })
})

describe('AI discharge draft', () => {
  let t: TestApi
  let ids: Awaited<ReturnType<typeof seedBasics>>
  let stayId: string
  before(async () => {
    t = await startTestApi()
    ids = await seedBasics(t)
    const patient = await newPatient(t, { name: 'Confidential Person', phone: '9811100022', allergies: ['Penicillin'], problemList: ['Hypertension'] })
    stayId = (await t.post(`${api}/encounters/ipd`, { patientId: patient.id, department: 'General Medicine', doctorId: ids.doctorId, bedId: ids.bedA })).body.id
    await t.post(`${api}/encounters/${stayId}/vitals`, { tempF: 99.2, pulse: 88, bp: '130/85', spo2: 97 })
    await t.post(`${api}/encounters/${stayId}/orders`, { type: 'lab', name: 'Troponin' })
    await t.post(`${api}/encounters/${stayId}/prescriptions`, { drugName: 'Amlodipine 5mg', dose: '1 tab', frequency: 'OD', duration: '30 days' })
  })
  after(() => t.close())

  it('produces a template draft when no AI key is configured', async () => {
    const result = await t.post(`${api}/encounters/${stayId}/discharge-draft`)
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.equal(result.body.source, 'template')
    assert.match(result.body.draft, /AI DRAFT — requires clinician review/)
    assert.match(result.body.draft, /Patient: Confidential Person/)
    assert.match(result.body.draft, /Penicillin/)
    assert.match(result.body.draft, /Amlodipine 5mg 1 tab OD x 30 days/)
    assert.match(result.body.draft, /lab: Troponin/)
    const log = (await t.get(`${api}/audit-log?limit=10`)).body as { action: string; detail: string }[]
    assert.ok(log.some((l) => l.action === 'AI Discharge Draft Generated' && l.detail.includes('template')))
  })

  it('is only for inpatient stays', async () => {
    const patient = await newPatient(t, { name: 'Outpatient' })
    const visit = (await checkInOpdPaid(t, { patientId: patient.id, department: 'General Medicine', doctorId: ids.doctorId })).body
    assert.equal((await t.post(`${api}/encounters/${visit.id}/discharge-draft`)).status, 400)
    assert.equal((await t.post(`${api}/encounters/00000000-0000-4000-8000-000000000000/discharge-draft`)).status, 404)
  })

  it('asks the model with clinical facts only, and adds the identifying line afterwards', async () => {
    let sent = ''
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      sent = String(init.body)
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'Diagnosis / Problems: Hypertension.\nFollow-up: review in 1 week.' }] }), { status: 200 })
    }) as unknown as typeof fetch

    const env = loadEnv({ NODE_ENV: 'test', ANTHROPIC_API_KEY: 'test-key', AI_MODEL: 'test-model' })
    const result = await t.inHospital(() => draftDischargeSummary(t.api.ctx.db, env, t.api.ctx.log, stayId, 'Tester', fakeFetch))

    assert.equal(result.source, 'ai')
    assert.match(result.draft, /Follow-up: review in 1 week\./)
    assert.match(result.draft, /Patient: Confidential Person/, 'the name is added locally')

    const request = JSON.parse(sent)
    assert.equal(request.model, 'test-model')
    assert.ok(!sent.includes('Confidential'), 'no name sent')
    assert.ok(!sent.includes('9811100022'), 'no phone sent')
    assert.ok(!/MRN-\d+/.test(sent), 'no MRN sent')
    assert.match(sent, /Hypertension/)
    assert.match(sent, /Amlodipine/)
  })

  it('falls back to the template when the AI service fails', async () => {
    const failing = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    const env = loadEnv({ NODE_ENV: 'test', ANTHROPIC_API_KEY: 'test-key' })
    const result = await t.inHospital(() => draftDischargeSummary(t.api.ctx.db, env, t.api.ctx.log, stayId, 'Tester', failing))
    assert.equal(result.source, 'template')
    assert.match(result.draft, /Amlodipine/)
  })
})
