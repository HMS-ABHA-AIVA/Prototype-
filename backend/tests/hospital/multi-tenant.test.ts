import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import { newPatient, startTestApi, strongPassword, type TestApi, stopServer } from './helpers.js'

// Several hospitals on one installation: one database, every row carrying its hospital (facilityId), the platform console
// setting hospitals up and switching them off, and both the M1 screens and the hospital modules keeping each hospital's data apart.
after(stopServer)

const api = '/api/v1'
const LOGIN = '/api/user/admin/login'
const tag = randomBytes(3).toString('hex')
const PLATFORM = { PLATFORM_ADMIN_USERNAME: `platform-${tag}`, PLATFORM_ADMIN_PASSWORD: `Platform-pass-${tag}-9` }

interface Answer { status: number; body: any; token: string | undefined }
const codeOf = (body: any) => body?.error?.code ?? body?.code ?? body?.errorCode

describe('Several hospitals on one installation', () => {
  let t: TestApi
  let base: string

  /** A bare HTTP client with an optional bearer token. */
  const call = async (token: string | null | undefined, method: string, path: string, body?: unknown): Promise<Answer> => {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: method === 'GET' ? null : JSON.stringify(body ?? {}),
    })
    const access = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]!).find((c) => c.startsWith('accessToken=') && c !== 'accessToken=')
    const text = await r.text()
    let parsed: any = null
    try { parsed = text ? JSON.parse(text) : null } catch { parsed = text }
    return { status: r.status, body: parsed, token: access?.slice('accessToken='.length) }
  }

  let platformToken: string
  let hospitalB: { id: string; code: string; hfrId: string; status: string }
  const adminB = { email: `sunrise-admin-${tag}@example.test`, password: strongPassword() }
  let tokenB: string

  before(async () => {
    t = await startTestApi(undefined, PLATFORM)
    base = t.api.url
    const { hospital } = await import('../../src/app.js')
    await hospital.start() // creates the platform administrator from the environment, as at server start
    const login = await call(null, 'POST', `${api}/platform/login`, { username: PLATFORM.PLATFORM_ADMIN_USERNAME, password: PLATFORM.PLATFORM_ADMIN_PASSWORD })
    assert.equal(login.status, 200, JSON.stringify(login.body))
    platformToken = login.body.token
    const created = await call(platformToken, 'POST', `${api}/platform/facilities`, {
      name: 'Sunrise Nursing Home', hfrId: `SUNRISE${tag}`, adminName: 'Dr. Sunrise Admin', adminEmail: adminB.email, adminPassword: adminB.password,
    })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    hospitalB = created.body
  })

  after(async () => {
    await t.close()
    const { removeQaHospital } = await import('../helpers.js')
    if (hospitalB) await removeQaHospital(hospitalB.id)
    const { prisma } = await import('../../src/config/db.js')
    await prisma.platformAudit.deleteMany({ where: { OR: [{ actor: PLATFORM.PLATFORM_ADMIN_USERNAME }, { detail: PLATFORM.PLATFORM_ADMIN_USERNAME }] } })
    await prisma.platformAdmin.deleteMany({ where: { username: PLATFORM.PLATFORM_ADMIN_USERNAME } })
  })

  describe('setting up a hospital', () => {
    it('gives it its HFR ID as its code, and an active status', () => {
      assert.equal(hospitalB.code, `SUNRISE${tag}`)
      assert.equal(hospitalB.status, 'active')
    })

    it('refuses an HFR ID that is taken or malformed, a weak password, and an e-mail that already has a login', async () => {
      const input = { name: 'Another Hospital', adminName: 'Admin Person', adminEmail: `another-${tag}@example.test`, adminPassword: strongPassword() }
      assert.equal((await call(platformToken, 'POST', `${api}/platform/facilities`, { ...input, hfrId: `SUNRISE${tag}` })).status, 409)
      assert.equal((await call(platformToken, 'POST', `${api}/platform/facilities`, { ...input, hfrId: 'bad code!' })).status, 400)
      assert.equal((await call(platformToken, 'POST', `${api}/platform/facilities`, { ...input, hfrId: `WEAK${tag}`, adminPassword: 'short' })).status, 400)
      assert.equal((await call(platformToken, 'POST', `${api}/platform/facilities`, { ...input, hfrId: `TAKEN${tag}`, adminEmail: t.email })).status, 409)
      const listed = (await call(platformToken, 'GET', `${api}/platform/facilities`)).body as { name: string }[]
      assert.equal(listed.filter((f) => f.name === 'Another Hospital').length, 0, 'a refused set-up leaves nothing behind')
    })

    it('can only be done by a platform administrator', async () => {
      assert.equal((await call(null, 'POST', `${api}/platform/facilities`, {})).status, 401)
      assert.equal((await call(t.token, 'GET', `${api}/platform/facilities`)).status, 401, 'a hospital administrator is not a platform administrator')
      assert.equal((await call(platformToken, 'GET', `${api}/patients`)).status, 401, 'a platform token never opens a hospital')
      assert.equal((await call(platformToken, 'GET', '/api/patient')).status, 401, 'nor the M1 screens')
    })

    it('rejects wrong platform credentials', async () => {
      assert.equal((await call(null, 'POST', `${api}/platform/login`, { username: PLATFORM.PLATFORM_ADMIN_USERNAME, password: 'wrong-pass-123' })).status, 401)
    })
  })

  describe('signing in', () => {
    it('makes a new hospital administrator choose their own password first', async () => {
      const first = await call(null, 'POST', LOGIN, { email: adminB.email, password: adminB.password })
      assert.equal(first.status, 200, JSON.stringify(first.body))
      assert.equal(first.body.data.mustChangePassword, true)
      assert.equal(codeOf((await call(first.token, 'GET', `${api}/patients`)).body), 'PASSWORD_CHANGE_REQUIRED')
      const changed = await call(first.token, 'POST', `${api}/auth/change-password`, { currentPassword: adminB.password, newPassword: (adminB.password = strongPassword()) })
      assert.equal(changed.status, 200, JSON.stringify(changed.body))
      tokenB = changed.token!
    })

    it('tells each person which hospital they are in', async () => {
      const me = (await call(tokenB, 'GET', `${api}/auth/me`)).body.user
      assert.equal(me.facilityId, hospitalB.id)
      assert.equal(me.facilityCode, `SUNRISE${tag}`)
      assert.equal(me.facilityName, 'Sunrise Nursing Home')
      assert.equal(me.mustChangePassword, false)
    })

    it('shows the new name everywhere when a hospital renames itself, but its HFR ID stays fixed', async () => {
      const original = (await t.get(`${api}/facility`)).body.name
      assert.equal((await t.call('PUT', `${api}/facility`, { name: 'Renamed Main Hospital' })).status, 200)
      assert.equal((await t.get(`${api}/auth/me`)).body.user.facilityName, 'Renamed Main Hospital')
      const listed = (await call(platformToken, 'GET', `${api}/platform/facilities`)).body as { id: string; name: string }[]
      assert.equal(listed.find((f) => f.id === t.facilityId)!.name, 'Renamed Main Hospital')
      await t.call('PUT', `${api}/facility`, { name: original })

      const fixed = await t.call('PUT', `${api}/facility`, { hfrId: `SUNRISE${tag}` })
      assert.equal(fixed.status, 400, 'the HFR ID is the ABDM HIP id, which routes Scan & Share: it cannot be changed or taken')
      assert.equal(codeOf(fixed.body), 'HFR_ID_FIXED')
    })

    it('shows each hospital its own profile', async () => {
      assert.equal((await call(tokenB, 'GET', `${api}/facility`)).body.name, 'Sunrise Nursing Home')
      assert.notEqual((await t.get(`${api}/facility`)).body.name, 'Sunrise Nursing Home')
    })
  })

  describe('keeping data apart', () => {
    let mine: { id: string }
    let theirs: { id: string }

    it("never shows one hospital's patients, beds or audit trail to another", async () => {
      mine = await newPatient(t, { name: 'Main Hospital Patient' })
      await t.post(`${api}/beds`, { ward: 'Ward A', bedNo: 'A-01' })
      theirs = (await call(tokenB, 'POST', `${api}/patients`, { name: 'Sunrise Patient', age: 40, gender: 'F', phone: '9876500002' })).body
      assert.ok(theirs.id)

      const listA = (await t.get(`${api}/patients`)).body as { name: string }[]
      const listB = (await call(tokenB, 'GET', `${api}/patients`)).body as { name: string }[]
      assert.deepEqual(listA.map((p) => p.name), ['Main Hospital Patient'])
      assert.deepEqual(listB.map((p) => p.name), ['Sunrise Patient'])

      assert.equal((await call(tokenB, 'GET', `${api}/patients/${mine.id}`)).status, 404, "another hospital's patient cannot be opened by id")
      assert.equal((await t.get(`${api}/patients/${theirs.id}`)).status, 404)
      assert.equal(((await call(tokenB, 'GET', `${api}/beds`)).body as unknown[]).length, 0)
      assert.equal(((await t.get(`${api}/beds`)).body as unknown[]).length, 1)

      const auditB = JSON.stringify((await call(tokenB, 'GET', `${api}/audit-log`)).body)
      assert.ok(!auditB.includes('Main Hospital Patient'), 'the audit trail holds only that hospital')
    })

    it('keeps the M1 registration screens apart too, and they share one patient list with the hospital modules', async () => {
      const m1A = (await t.get('/api/patient')).body.data as { id: string; name: string }[]
      const m1B = (await call(tokenB, 'GET', '/api/patient')).body.data as { id: string; name: string }[]
      assert.deepEqual(m1A.map((p) => p.name), ['Main Hospital Patient'])
      assert.deepEqual(m1B.map((p) => p.name), ['Sunrise Patient'])

      const walkIn = await call(tokenB, 'POST', '/api/patient/create', { name: 'Sunrise Walkin', phone: '9876500003', dateOfBirth: '1990-05-01', gender: 'F' })
      assert.equal(walkIn.status, 201, JSON.stringify(walkIn.body))
      const listB = (await call(tokenB, 'GET', `${api}/patients`)).body as { id: string; name: string; mrn: string; gender: string; age: number }[]
      const registered = listB.find((p) => p.id === walkIn.body.data.id)
      assert.ok(registered, 'a patient registered on the M1 screen is in the hospital modules')
      assert.match(registered.mrn, /^MRN-\d+$/, 'and gets its hospital number')
      assert.equal(registered.gender, 'F', 'with the gender chosen at registration')
      assert.ok(registered.age >= 35, 'and an age from the date of birth')
      assert.equal((await call(tokenB, 'POST', '/api/patient/create', { name: 'Bad Gender', phone: '9876500004', gender: 'Female' })).status, 400)
      assert.ok(!((await t.get(`${api}/patients`)).body as { id: string }[]).some((p) => p.id === walkIn.body.data.id))

      assert.notEqual((await call(tokenB, 'GET', `/api/patient/${mine.id}/transactions`)).status, 200)
      assert.notEqual((await call(tokenB, 'DELETE', `/api/patient/${mine.id}`)).status, 200)
      assert.equal((await t.get(`${api}/patients/${mine.id}`)).status, 200, 'still there')
    })

    it('numbers records from the start in each hospital', async () => {
      const a = (await t.get(`${api}/patients`)).body as { name: string; mrn: string }[]
      const b = (await call(tokenB, 'GET', `${api}/patients`)).body as { name: string; mrn: string }[]
      assert.equal(a.find((p) => p.name === 'Main Hospital Patient')!.mrn, b.find((p) => p.name === 'Sunrise Patient')!.mrn, 'MRN numbering starts afresh in every hospital')
    })

    it('keeps the dashboard and staff lists apart', async () => {
      const dashA = (await t.get(`${api}/dashboard`)).body
      const dashB = (await call(tokenB, 'GET', `${api}/dashboard`)).body
      assert.equal(dashA.bedsTotal, 1)
      assert.equal(dashB.bedsTotal, 0)
      const staffB = (await call(tokenB, 'GET', `${api}/staff`)).body as { name: string }[]
      assert.deepEqual(staffB.map((s) => s.name), ['Dr. Sunrise Admin'])
    })

    it('holds up when both hospitals are used at the same time', async () => {
      const results = await Promise.all(
        Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? t.get(`${api}/patients`) : call(tokenB, 'GET', `${api}/patients`))),
      )
      results.forEach((r, i) => {
        const names = (r.body as { name: string }[]).map((p) => p.name)
        assert.ok(i % 2 === 0 ? names.every((n) => n === 'Main Hospital Patient') : names.every((n) => n.startsWith('Sunrise')), `request ${i}: ${names.join(', ')}`)
      })
    })
  })

  describe('suspending a hospital', () => {
    it('switches its staff off at once, leaves the others alone, and can be undone', async () => {
      const suspended = await call(platformToken, 'PATCH', `${api}/platform/facilities/${hospitalB.id}`, { status: 'suspended' })
      assert.equal(suspended.status, 200)
      assert.equal(suspended.body.status, 'suspended')

      const blocked = await call(tokenB, 'GET', `${api}/patients`)
      assert.equal(blocked.status, 403)
      assert.equal(codeOf(blocked.body), 'HOSPITAL_SUSPENDED')
      assert.equal((await call(tokenB, 'GET', '/api/patient')).status, 403, 'the M1 screens too')
      const login = await call(null, 'POST', LOGIN, adminB)
      assert.equal(login.status, 403)
      assert.equal((await t.get(`${api}/patients`)).status, 200, 'the other hospital carries on')

      await call(platformToken, 'PATCH', `${api}/platform/facilities/${hospitalB.id}`, { status: 'active' })
      assert.equal((await call(tokenB, 'GET', `${api}/patients`)).status, 200)
    })
  })

  describe('support', () => {
    it("lets a platform administrator give a hospital's administrator a new login, and only there", async () => {
      const fresh = strongPassword()
      const reset = await call(platformToken, 'POST', `${api}/platform/facilities/${hospitalB.id}/admin-login`, { email: adminB.email, password: fresh })
      assert.equal(reset.status, 200, JSON.stringify(reset.body))
      assert.equal((await call(tokenB, 'GET', `${api}/patients`)).status, 401, 'the old session ended')
      const signedIn = await call(null, 'POST', LOGIN, { email: adminB.email, password: fresh })
      assert.equal(signedIn.status, 200)
      assert.equal(signedIn.body.data.mustChangePassword, true)

      const elsewhere = await call(platformToken, 'POST', `${api}/platform/facilities/${hospitalB.id}/admin-login`, { email: t.email, password: strongPassword() })
      assert.equal(elsewhere.status, 409, "another hospital's login cannot be taken over")
    })

    it('records what the platform did', async () => {
      const audit = (await call(platformToken, 'GET', `${api}/platform/audit`)).body as { action: string; actor: string }[]
      const actions = new Set(audit.filter((a) => a.actor === PLATFORM.PLATFORM_ADMIN_USERNAME).map((a) => a.action))
      for (const expected of ['Platform Sign-in', 'Hospital Set Up', 'Hospital Switched Off', 'Hospital Switched On', 'Hospital Administrator Login Set']) {
        assert.ok(actions.has(expected), expected)
      }
    })
  })
})
