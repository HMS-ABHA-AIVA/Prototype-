import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { loadHospitalEnv as loadEnv } from '../../src/hospital/config.js'
import { aiStatus } from '../../src/hospital/modules/ai/ai-client.js'
import { checkInOpdPaid, newPatient, seedBasics, startTestApi, type TestApi, stopServer } from './helpers.js'

// One application per test file, shared by its describe blocks: stop it when they are all done.
after(stopServer)

const api = '/api/v1'

describe('choosing the AI provider from the environment', () => {
  const env = (source: Record<string, string>) => loadEnv({ NODE_ENV: 'test', ...source })

  it('defaults to Claude, and uses Gemini only when asked or when it is the only key', () => {
    assert.equal(env({}).aiProvider, 'anthropic')
    assert.equal(env({ ANTHROPIC_API_KEY: 'a' }).aiProvider, 'anthropic')
    assert.equal(env({ GEMINI_API_KEY: 'g' }).aiProvider, 'gemini')
    assert.equal(env({ GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' }).aiProvider, 'anthropic', 'two keys: stay on Claude unless asked')
    assert.equal(env({ GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a', AI_PROVIDER: 'gemini' }).aiProvider, 'gemini')
    assert.equal(env({ AI_PROVIDER: 'nonsense', ANTHROPIC_API_KEY: 'a' }).aiProvider, 'anthropic')
  })

  it('has sensible model and address defaults for each, which can be overridden', () => {
    const gemini = env({ GEMINI_API_KEY: 'g' })
    assert.equal(gemini.aiModel, 'gemini-3.5-flash')
    assert.equal(gemini.aiBaseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai')
    assert.equal(gemini.aiReasoningEffort, 'low')
    const claude = env({ ANTHROPIC_API_KEY: 'a' })
    assert.equal(claude.aiModel, 'claude-sonnet-5-5')
    assert.equal(claude.aiBaseUrl, 'https://api.anthropic.com')
    assert.equal(env({ GEMINI_API_KEY: 'g', AI_MODEL: 'gemini-3.8-flash', AI_REASONING_EFFORT: '' }).aiModel, 'gemini-3.8-flash')
    assert.equal(env({ GEMINI_API_KEY: 'g', AI_REASONING_EFFORT: '' }).aiReasoningEffort, '', 'empty means "do not send it"')
  })

  it('marks free Gemini as demo-only, and Claude or a paid Gemini project as not', () => {
    assert.deepEqual(aiStatus(env({ GEMINI_API_KEY: 'g' })), { enabled: true, provider: 'gemini', demoOnly: true })
    assert.deepEqual(aiStatus(env({ GEMINI_API_KEY: 'g', AI_PAID_TIER: 'true' })), { enabled: true, provider: 'gemini', demoOnly: false })
    assert.deepEqual(aiStatus(env({ ANTHROPIC_API_KEY: 'a' })), { enabled: true, provider: 'anthropic', demoOnly: false })
    assert.deepEqual(aiStatus(env({})), { enabled: false, provider: 'anthropic', demoOnly: false })
  })
})

/** A stand-in for Gemini's OpenAI-compatible endpoint. */
function fakeGemini() {
  const requests: { url: string; headers: Record<string, unknown>; body: any }[] = []
  const answers: { status: number; body: unknown }[] = []
  const server: Server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      requests.push({ url: req.url ?? '', headers: req.headers, body: JSON.parse(raw || '{}') })
      const answer = answers.shift() ?? { status: 500, body: 'nothing queued' }
      res.writeHead(answer.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(answer.body))
    })
  })
  const text = (content: string | null, finish = 'stop') => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: finish }] })
  return {
    requests,
    reply: (content: string | null, finish?: string) => answers.push({ status: 200, body: text(content, finish) }),
    fail: (status: number) => answers.push({ status, body: { error: { message: 'quota' } } }),
    start: () => new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))),
    stop: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections() }),
  }
}

describe('the assistant on Gemini', () => {
  const gemini = fakeGemini()
  let t: TestApi
  let visitId: string
  before(async () => {
    const url = await gemini.start()
    t = await startTestApi(undefined, { GEMINI_API_KEY: 'g-test-key', AI_API_URL: url })
    const { doctorId } = await seedBasics(t)
    const patient = await newPatient(t, { name: 'Anita Verma', phone: '9811100033', age: 34, gender: 'F', allergies: ['Penicillin'] })
    visitId = (await checkInOpdPaid(t, { patientId: patient.id, department: 'General Medicine', doctorId })).body.id
  })
  after(async () => { await t.close(); await gemini.stop() })

  it('reports itself as on, and as demo-only, to any signed-in screen', async () => {
    const nurse = await t.as('nurse')
    assert.deepEqual((await nurse.get(`${api}/ai/status`)).body, { enabled: true, provider: 'gemini', demoOnly: true })
    const anonymous = await fetch(`${t.api.url}${api}/ai/status`)
    assert.equal(anonymous.status, 401, 'signing in is required')
  })

  it('sends Google\'s chat format: system message, bearer key, extra room for thinking, and no identity', async () => {
    gemini.reply('```json\n' + JSON.stringify({ subjective: 'Fever for two days.', objective: '', assessment: 'Viral fever.', plan: 'Rest.', vitals: {}, orders: [] }) + '\n```')
    const r = await t.post(`${api}/encounters/${visitId}/ai/dictation`, { transcript: 'Anita Verma 9811100033 has fever for two days viral fever rest' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.source, 'ai')
    assert.equal(r.body.sections.assessment, 'Viral fever.')

    const sent = gemini.requests.at(-1)!
    assert.equal(sent.url, '/chat/completions')
    assert.equal(sent.headers.authorization, 'Bearer g-test-key')
    assert.equal(sent.headers['x-api-key'], undefined, 'the Claude header is not used')
    assert.equal(sent.body.model, 'gemini-3.5-flash')
    assert.equal(sent.body.reasoning_effort, 'low')
    assert.ok(sent.body.max_tokens > 900, 'thinking tokens count against the limit, so there is headroom')
    assert.equal(sent.body.messages[0].role, 'system')
    assert.equal(sent.body.messages[1].role, 'user')
    const everything = JSON.stringify(sent.body)
    assert.ok(!everything.includes('Anita') && !everything.includes('Verma') && !everything.includes('9811100033'), 'no identity sent')
  })

  it('drafts prescriptions and still does the safety checks itself', async () => {
    gemini.reply(JSON.stringify({
      suggestions: [{ drugName: 'Augmentin 625 Duo Tablet', dose: '1 tab', frequency: 'BD', duration: '5 days', rationale: 'x' }],
      advice: '',
    }))
    const r = await t.post(`${api}/encounters/${visitId}/ai/prescription-suggestions`, { assessment: 'fever' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.match(r.body.suggestions[0].allergyWarning, /Penicillin/)
  })

  it('falls back or reports honestly when Gemini fails, answers nothing, or hits its free limit', async () => {
    gemini.reply(null, 'length') // thinking used up the allowance: no text
    assert.equal((await t.post(`${api}/encounters/${visitId}/ai/dictation`, { transcript: 'Subjective cough. Plan steam' })).body.source, 'rules')

    gemini.fail(429) // the free tier's daily limit
    assert.equal((await t.post(`${api}/encounters/${visitId}/ai/dictation`, { transcript: 'Subjective cough' })).body.source, 'rules')

    gemini.fail(429)
    const down = await t.post(`${api}/encounters/${visitId}/ai/prescription-suggestions`, { assessment: 'fever' })
    assert.equal(down.status, 502)
    assert.equal(down.body.error.code, 'AI_UNAVAILABLE')
  })

  it('also drafts discharge summaries through Gemini', async () => {
    const before = gemini.requests.length
    const patient = await newPatient(t, { name: 'Inpatient One' })
    const beds = (await t.get(`${api}/beds`)).body as { id: string; status: string }[]
    const doctorId = (await t.get(`${api}/staff`)).body.find((s: any) => s.role === 'doctor').id
    const admitted = await t.post(`${api}/encounters/ipd`, { patientId: patient.id, department: 'General Medicine', doctorId, bedId: beds.find((b) => b.status === 'vacant')!.id })
    assert.equal(admitted.status, 201, JSON.stringify(admitted.body))
    gemini.reply('Admitted with fever; improved on treatment; discharged in stable condition.')
    const draft = await t.post(`${api}/encounters/${admitted.body.id}/discharge-draft`, {})
    assert.equal(draft.status, 200, JSON.stringify(draft.body))
    assert.equal(draft.body.source, 'ai')
    assert.equal(gemini.requests.length, before + 1)
  })
})

describe('the assistant with no AI key', () => {
  let t: TestApi
  before(async () => { t = await startTestApi() })
  after(() => t.close())

  it('says it is off', async () => {
    assert.deepEqual((await t.get(`${api}/ai/status`)).body, { enabled: false, provider: 'anthropic', demoOnly: false })
  })
})
