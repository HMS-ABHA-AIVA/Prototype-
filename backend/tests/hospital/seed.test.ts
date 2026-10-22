import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { seedDemoHospital, seedMasters } from '../../src/hospital/seed.js'
import { startTestApi, strongPassword, tokenFor, type TestApi, stopServer } from './helpers.js'

// The demo hospital (scripts/seed_demo.ts) and the example price lists, in a throwaway hospital of their own.
after(stopServer)

const api = '/api/v1'

describe('demo hospital', () => {
  let t: TestApi
  const logins = { domain: `seed-${Date.now().toString(36)}.example.test`, password: strongPassword() }
  before(async () => { t = await startTestApi() })
  after(() => t.close())

  it('fills an empty hospital with staff, beds, stock, price lists, patients, visits and operations data', async () => {
    assert.equal(await t.inHospital(() => seedDemoHospital(t.api.ctx.db, logins)), true)
    const count = async (path: string) => ((await t.get(`${api}${path}`)).body as unknown[]).length
    assert.equal(await count('/beds'), 7)
    assert.equal(await count('/patients'), 6)
    assert.equal(await count('/supplies'), 13)
    assert.equal(await count('/waste'), 4)
    assert.ok((await count('/staff')) >= 9)
    assert.ok((await count('/masters/services')) >= 13)
    assert.ok((await count('/masters/investigations')) >= 13)
    const rows = async (table: string) => (await t.sql<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}" WHERE "facilityId" = :fid`))[0]?.n
    assert.equal(await rows('RosterEntry'), 10)
    assert.equal(await rows('Attendance'), 6)

    const visits = (await t.get(`${api}/encounters`)).body as { type: string; status: string; tokenNo: number | null }[]
    assert.equal(visits.filter((v) => v.type === 'OPD' && v.status === 'waiting').length, 3, 'the OPD visits are paid and in the queue')
    assert.ok(visits.every((v) => v.type !== 'OPD' || v.tokenNo), 'with a token')
    assert.equal(visits.filter((v) => v.type === 'ER').length, 2)
    assert.equal(visits.filter((v) => v.type === 'IPD').length, 1)
    assert.equal((await t.get(`${api}/dashboard`)).body.bedsOccupied, 1)
  })

  it('gives each demo person a working login with their role', async () => {
    const token = await tokenFor(t, `renu@${logins.domain}`, logins.password)
    const me = await fetch(`${t.api.url}${api}/auth/me`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json()) as any
    assert.equal(me.user.role, 'doctor')
    assert.equal(me.user.name, 'Dr. Renu Kapoor')
    assert.equal(me.user.mustChangePassword, false)
  })

  it('is added only once, and the price lists only to a hospital that has none', async () => {
    assert.equal(await t.inHospital(() => seedDemoHospital(t.api.ctx.db, logins)), false)
    assert.equal(await t.inHospital(() => seedMasters(t.api.ctx.db)), false)
    const other = await t.otherHospital()
    assert.equal(await other.inHospital(() => seedMasters(other.api.ctx.db)), true, 'a new hospital can take the example lists')
    assert.equal(((await other.get(`${api}/patients`)).body as unknown[]).length, 0, 'and nothing else')
  })
})
