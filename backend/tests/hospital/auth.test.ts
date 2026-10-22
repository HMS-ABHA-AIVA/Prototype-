import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { passwordProblem } from '../../src/hospital/auth/accounts.js'
import { ADMIN_PASSWORD, startTestApi, strongPassword, type TestApi, stopServer } from './helpers.js'

// Sign-in for the merged application: one login (POST /api/user/admin/login) for the M1 screens and the hospital modules.
after(stopServer)

const LOGIN = '/api/user/admin/login'

interface Answer { status: number; body: any; token: string | undefined }

/** A request from outside: no session unless a token is given (sent as "Authorization: Bearer"). */
const open = async (t: TestApi, method: string, path: string, body?: unknown, token?: string): Promise<Answer> => {
  const r = await fetch(`${t.api.url}${path}`, {
    method,
    headers: { ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: method === 'GET' ? null : JSON.stringify(body ?? {}),
  })
  const access = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]!).find((c) => c.startsWith('accessToken=') && c !== 'accessToken=')
  return { status: r.status, body: await r.json().catch(() => null), token: access?.slice('accessToken='.length) }
}

describe('passwords', () => {
  it('rejects weak passwords and accepts a strong one', () => {
    assert.ok(passwordProblem('nurse@example.test', 'short1'), 'too short')
    assert.ok(passwordProblem('nurse@example.test', 'onlyletterspassword'), 'no digit or symbol')
    assert.equal(passwordProblem('nurse@example.test', strongPassword()), null)
  })
})

describe('staff sign-in', () => {
  let t: TestApi
  before(async () => { t = await startTestApi() })
  after(() => t.close())

  it('keeps the API closed to anyone who has not signed in, except health and sign-in itself', async () => {
    assert.equal((await open(t, 'GET', '/api/v1/patients')).status, 401)
    assert.equal((await open(t, 'GET', '/api/v1/patients', undefined, 'garbage')).status, 401)
    assert.equal((await open(t, 'GET', '/api/patient')).status, 401, 'the M1 routes too')
    assert.equal((await open(t, 'GET', '/health')).status, 200)
    assert.equal((await open(t, 'POST', LOGIN, {})).status, 400)
  })

  it('signs in with the right password, in any letter case, and never reveals the hash', async () => {
    const response = await open(t, 'POST', LOGIN, { email: t.email.toUpperCase(), password: ADMIN_PASSWORD })
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(response.body.data.role, 'admin')
    assert.equal(response.body.data.staffId, t.staffId)
    assert.ok(response.token, 'the session is a cookie')
    assert.ok(!/\$2[aby]\$/.test(JSON.stringify(response.body)))
    const me = await open(t, 'GET', '/api/v1/auth/me', undefined, response.token)
    assert.equal(me.body.user.email, t.email)
    assert.equal(me.body.user.facilityId, t.facilityId)
  })

  it('gives the same answer for a wrong password and an unknown e-mail address', async () => {
    const wrong = await open(t, 'POST', LOGIN, { email: t.email, password: 'wrong-password-1' })
    const unknown = await open(t, 'POST', LOGIN, { email: 'nobody-here@example.test', password: 'wrong-password-1' })
    assert.equal(wrong.status, 401)
    assert.deepEqual(wrong.body, unknown.body)
  })

  it('locks a login after five wrong passwords, even for the right one, until an administrator resets it', async () => {
    const doctor = await t.as('doctor')
    const password = strongPassword()
    assert.equal((await t.call('PUT', `/api/v1/staff/${doctor.staffId}/login`, { email: doctor.email, password })).status, 200)
    for (let i = 0; i < 5; i++) {
      assert.equal((await open(t, 'POST', LOGIN, { email: doctor.email, password: `wrong-${i}-password` })).status, 401)
    }
    const locked = await open(t, 'POST', LOGIN, { email: doctor.email, password })
    assert.equal(locked.status, 429)
    assert.equal(locked.body.code ?? locked.body.errorCode ?? locked.body.error?.code, 'ACCOUNT_LOCKED')

    const fresh = strongPassword()
    assert.equal((await t.call('PUT', `/api/v1/staff/${doctor.staffId}/login`, { email: doctor.email, password: fresh })).status, 200)
    assert.equal((await open(t, 'POST', LOGIN, { email: doctor.email, password: fresh })).status, 200)
  })

  it('limits each role to its own areas, on the hospital modules and the M1 screens alike', async () => {
    const frontOffice = await t.as('front_office')
    const housekeeping = await t.as('housekeeping')
    const nurse = await t.as('nurse')
    const biller = await t.as('biller')
    const pharmacist = await t.as('pharmacist')

    assert.equal((await frontOffice.get('/api/v1/patients')).status, 200)
    assert.equal((await housekeeping.get('/api/v1/patients')).status, 403)
    assert.equal((await housekeeping.get('/api/v1/beds')).status, 200)
    assert.equal((await nurse.get('/api/v1/audit-log')).status, 403)
    assert.equal((await nurse.get('/api/v1/bills')).status, 403)
    assert.equal((await biller.get('/api/v1/bills')).status, 200)
    assert.equal((await biller.get('/api/v1/encounters')).status, 403)
    assert.equal((await pharmacist.get('/api/v1/pharmacy/queue')).status, 200)
    assert.equal((await nurse.get('/api/v1/pharmacy/queue')).status, 403)
    assert.equal((await frontOffice.post('/api/v1/staff', { name: 'X', role: 'nurse', department: 'Y' })).status, 403)
    assert.equal((await frontOffice.call('PUT', '/api/v1/facility', { name: 'Hacked' })).status, 403)
    assert.equal((await t.get('/api/v1/audit-log')).status, 200)

    // Registration and ABHA (the M1 screens) are for the front desk, clinicians, billing and administrators.
    assert.equal((await frontOffice.get('/api/patient')).status, 200)
    assert.equal((await housekeeping.get('/api/patient')).status, 403)
    assert.equal((await pharmacist.get('/api/patient')).status, 403)
    assert.equal((await housekeeping.get('/api/dashboard')).status, 200, 'the home screen works for everyone')
  })

  it('shows pay and login details to administrators only', async () => {
    const created = (await t.post('/api/v1/staff', { name: 'Paid Person', role: 'nurse', department: 'Ward A', monthlySalary: 31000 })).body
    const nurse = await t.as('nurse')
    const asAdmin = (await t.get(`/api/v1/staff/${created.id}`)).body
    const asNurse = (await nurse.get(`/api/v1/staff/${created.id}`)).body
    assert.equal(asAdmin.monthlySalary, 31000)
    assert.equal(asNurse.monthlySalary, null)
    assert.equal(asNurse.hasLogin, false)
    assert.ok(!/\$2[aby]\$|passwordHash/.test(JSON.stringify(asAdmin)))
  })

  it('records the signed-in person in the audit trail, not a name the caller supplies', async () => {
    const frontOffice = await t.as('front_office')
    await frontOffice.call('POST', '/api/v1/patients', { name: 'Audit Check', age: 40, gender: 'F', phone: '9876500099' }, { 'X-Actor': 'Someone Else' })
    const log = (await t.get('/api/v1/audit-log?limit=20')).body as { actor: string; action: string }[]
    const entry = log.find((row) => /patient/i.test(row.action))
    assert.equal(entry?.actor, 'Test front office')
  })

  it('makes a new or reset login choose its own password before anything else, and ends old sessions on a change', async () => {
    const person = (await t.post('/api/v1/staff', { name: 'New Joiner', role: 'nurse', department: 'Ward B' })).body
    const email = `new.joiner-${person.id.slice(0, 8)}@example.test`
    const first = strongPassword()
    assert.equal((await t.call('PUT', `/api/v1/staff/${person.id}/login`, { email, password: 'short' })).status, 400)
    assert.equal((await t.call('PUT', `/api/v1/staff/${person.id}/login`, { email, password: first })).status, 200)
    assert.equal((await t.call('PUT', `/api/v1/staff/${person.id}/login`, { email: t.email, password: first })).status, 409, 'an e-mail address has one login')

    const signedIn = await open(t, 'POST', LOGIN, { email, password: first })
    assert.equal(signedIn.body.data.mustChangePassword, true)
    const due = await open(t, 'GET', '/api/v1/patients', undefined, signedIn.token)
    assert.equal(due.status, 403)
    assert.equal(due.body.error.code, 'PASSWORD_CHANGE_REQUIRED')
    assert.equal((await open(t, 'GET', '/api/patient', undefined, signedIn.token)).status, 403, 'the M1 screens wait too')

    const second = strongPassword()
    assert.equal((await open(t, 'POST', '/api/v1/auth/change-password', { currentPassword: 'wrong-current-1', newPassword: second }, signedIn.token)).status, 400)
    assert.equal((await open(t, 'POST', '/api/v1/auth/change-password', { currentPassword: first, newPassword: 'weak' }, signedIn.token)).status, 400)
    const changed = await open(t, 'POST', '/api/v1/auth/change-password', { currentPassword: first, newPassword: second }, signedIn.token)
    assert.equal(changed.status, 200)
    assert.ok(changed.token, 'a new session comes with the new password')

    assert.equal((await open(t, 'GET', '/api/v1/auth/me', undefined, signedIn.token)).status, 401, 'the old session stops working')
    assert.equal((await open(t, 'GET', '/api/patient', undefined, signedIn.token)).status, 401, 'on the M1 screens too')
    const me = await open(t, 'GET', '/api/v1/auth/me', undefined, changed.token)
    assert.equal(me.body.user.mustChangePassword, false)
    assert.equal((await open(t, 'GET', '/api/v1/patients', undefined, changed.token)).status, 200)
    assert.equal((await open(t, 'POST', LOGIN, { email, password: first })).status, 401)
  })

  it('cuts access immediately when someone is deactivated or their login is removed', async () => {
    const person = (await t.post('/api/v1/staff', { name: 'Leaver', role: 'front_office', department: 'Reception' })).body
    const email = `leaver-${person.id.slice(0, 8)}@example.test`
    const password = strongPassword()
    await t.call('PUT', `/api/v1/staff/${person.id}/login`, { email, password })
    const signedIn = await open(t, 'POST', LOGIN, { email, password })
    const now = strongPassword()
    const token = (await open(t, 'POST', '/api/v1/auth/change-password', { currentPassword: password, newPassword: now }, signedIn.token)).token
    assert.equal((await open(t, 'GET', '/api/v1/auth/me', undefined, token)).status, 200)
    assert.equal((await open(t, 'GET', '/api/patient', undefined, token)).status, 200)

    await t.call('PATCH', `/api/v1/staff/${person.id}`, { active: false })
    assert.equal((await open(t, 'GET', '/api/v1/auth/me', undefined, token)).status, 401)
    assert.equal((await open(t, 'GET', '/api/patient', undefined, token)).status, 401)
    assert.equal((await open(t, 'POST', LOGIN, { email, password: now })).status, 401)

    await t.call('PATCH', `/api/v1/staff/${person.id}`, { active: true })
    assert.equal((await open(t, 'POST', LOGIN, { email, password: now })).status, 200, 'reactivated')
    assert.equal((await t.call('DELETE', `/api/v1/staff/${person.id}/login`)).status, 200)
    assert.equal((await open(t, 'POST', LOGIN, { email, password: now })).status, 401)
  })

  it('stops an administrator locking themselves out', async () => {
    const me = (await t.get('/api/v1/auth/me')).body.user
    assert.equal((await t.call('DELETE', `/api/v1/staff/${me.id}/login`)).status, 400)
    assert.equal((await t.call('PATCH', `/api/v1/staff/${me.id}`, { active: false })).status, 400)
    assert.equal((await t.call('PATCH', `/api/v1/staff/${me.id}`, { role: 'nurse' })).status, 400)
  })
})
