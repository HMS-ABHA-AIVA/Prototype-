import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { newPatient, seedBasics, startTestApi, type TestApi, stopServer } from './helpers.js'

// One application per test file, shared by its describe blocks: stop it when they are all done.
after(stopServer)

const api = '/api/v1'
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n')
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)])

describe('Births', () => {
  let t: TestApi
  let doctorId: string
  let bedA: string
  let stayId: string
  before(async () => {
    t = await startTestApi()
    ;({ doctorId, bedA } = await seedBasics(t))
    const mother = await newPatient(t, { name: 'Sunita Verma', gender: 'F', age: 27 })
    stayId = (await t.post(`${api}/encounters/ipd`, { patientId: mother.id, department: 'Obstetrics', doctorId, bedId: bedA })).body.id
  })
  after(() => t.close())

  it('registers a newborn against the mother\'s admission, with a birth number', async () => {
    const nurse = await t.as('nurse')
    const born = await nurse.post(`${api}/ipd/${stayId}/births`, { gender: 'F', weightGrams: 3100, deliveryType: 'normal', fatherName: 'Rajesh Verma', attendedBy: 'Dr. Test' })
    assert.equal(born.status, 201, JSON.stringify(born.body))
    assert.match(born.body.birthNo, /^BR-\d+$/)
    assert.equal(born.body.motherName, 'Sunita Verma')
    assert.equal(born.body.recordedBy, 'Test nurse')

    const second = await nurse.post(`${api}/ipd/${stayId}/births`, { gender: 'M', babyName: 'Baby of Sunita', weightGrams: 2900, deliveryType: 'normal' })
    assert.notEqual(second.body.birthNo, born.body.birthNo, 'twins get their own numbers')
    assert.equal(((await nurse.get(`${api}/ipd/${stayId}/births`)).body as unknown[]).length, 2)
  })

  it('refuses a birth that cannot be right', async () => {
    const future = new Date(Date.now() + 5 * 3600_000).toISOString()
    assert.equal((await t.post(`${api}/ipd/${stayId}/births`, { gender: 'F', deliveryType: 'normal', bornAt: future })).status, 400, 'in the future')
    assert.equal((await t.post(`${api}/ipd/${stayId}/births`, { gender: 'F', deliveryType: 'normal', bornAt: '2020-01-01T00:00:00Z' })).status, 400, 'before the admission')
    assert.equal((await t.post(`${api}/ipd/${stayId}/births`, { gender: 'F', deliveryType: 'normal', weightGrams: 50 })).status, 400, 'an impossible weight')
    const father = await newPatient(t, { name: 'Male Patient', gender: 'M' })
    const bedB = (await t.post(`${api}/beds`, { ward: 'Ward A', bedNo: 'A-09' })).body.id
    const maleStay = (await t.post(`${api}/encounters/ipd`, { patientId: father.id, department: 'Medicine', doctorId, bedId: bedB })).body.id
    assert.equal((await t.post(`${api}/ipd/${maleStay}/births`, { gender: 'M', deliveryType: 'normal' })).status, 400, 'a male patient is not the mother')
  })

  it('is for the ward and the doctors, not the billing counter', async () => {
    assert.equal((await (await t.as('biller')).post(`${api}/ipd/${stayId}/births`, { gender: 'F', deliveryType: 'normal' })).status, 403)
  })
})

describe('Attached documents', () => {
  let t: TestApi
  let stayId: string
  before(async () => {
    t = await startTestApi()
    const { doctorId, bedA } = await seedBasics(t)
    const patient = await newPatient(t, { name: 'Document Patient' })
    stayId = (await t.post(`${api}/encounters/ipd`, { patientId: patient.id, department: 'Medicine', doctorId, bedId: bedA })).body.id
  })
  after(() => t.close())

  const upload = (body: Buffer, query: string, token = t.token, type = 'application/octet-stream') =>
    fetch(`${t.api.url}${api}/ipd/${stayId}/documents?${query}`, { method: 'POST', headers: { 'Content-Type': type, Authorization: `Bearer ${token}` }, body: new Uint8Array(body) })
  let documentId: string

  it('stores a PDF and gives it back unchanged', async () => {
    const uploaded = await upload(PDF, 'kind=consent&title=Surgical%20consent&fileName=consent%20form.pdf', t.token, 'application/pdf')
    const row = (await uploaded.json()) as any
    assert.equal(uploaded.status, 201, JSON.stringify(row))
    assert.deepEqual([row.kind, row.title, row.contentType, row.sizeBytes, row.fileName], ['consent', 'Surgical consent', 'application/pdf', PDF.length, 'consent form.pdf'])
    documentId = row.id

    const download = await fetch(`${t.api.url}${api}/ipd/documents/${documentId}/file`, { headers: { Authorization: `Bearer ${t.token}` } })
    assert.equal(download.status, 200)
    assert.equal(download.headers.get('content-type'), 'application/pdf')
    assert.equal(download.headers.get('cache-control'), 'private, no-store')
    assert.ok(Buffer.from(await download.arrayBuffer()).equals(PDF))
  })

  it('judges a file by what is in it, not what it is called or says it is', async () => {
    const fake = await upload(Buffer.from('<html><script>alert(1)</script></html>'), 'title=Looks%20like%20a%20pdf&fileName=report.pdf', t.token, 'application/pdf')
    assert.equal(fake.status, 400)
    assert.match(((await fake.json()) as any).error.message, /Only PDF, PNG, JPEG or WEBP/)
    const png = await upload(PNG, 'kind=scan&title=Chest%20scan&fileName=scan.exe', t.token, 'application/pdf')
    const row = (await png.json()) as any
    assert.equal(png.status, 201, JSON.stringify(row))
    assert.deepEqual([row.contentType, row.fileName], ['image/png', 'scan.png'], 'the type and the extension come from the content')
  })

  it('refuses an empty file, a missing title, and a file that is too large', async () => {
    assert.equal((await upload(Buffer.alloc(0), 'title=Empty')).status, 400)
    assert.equal((await upload(PDF, 'kind=consent')).status, 400)
    const big = Buffer.concat([PDF, Buffer.alloc(11 * 1024 * 1024)])
    assert.equal((await upload(big, 'title=Huge')).status, 413)
  })

  it('lists the documents of a stay, and removes one only with a reason (it stays on record)', async () => {
    const nurse = await t.as('nurse')
    const list = (await nurse.get(`${api}/ipd/${stayId}/documents`)).body as { id: string; title: string }[]
    assert.deepEqual(list.map((d) => d.title).sort(), ['Chest scan', 'Surgical consent'])

    assert.equal((await nurse.post(`${api}/ipd/documents/${documentId}/remove`, { reason: 'wrong patient' })).status, 403, 'removing is for doctors and administrators')
    assert.equal((await t.post(`${api}/ipd/documents/${documentId}/remove`, { reason: 'x' })).status, 400)
    const removed = await t.post(`${api}/ipd/documents/${documentId}/remove`, { reason: 'Uploaded to the wrong patient' })
    assert.equal(removed.status, 200, JSON.stringify(removed.body))
    assert.equal(removed.body.removed, true)

    assert.equal(((await nurse.get(`${api}/ipd/${stayId}/documents`)).body as unknown[]).length, 1, 'gone from the list')
    assert.equal(((await t.get(`${api}/ipd/${stayId}/documents?removed=true`)).body as unknown[]).length, 2, 'an administrator can still see it')
    assert.equal((await fetch(`${t.api.url}${api}/ipd/documents/${documentId}/file`, { headers: { Authorization: `Bearer ${nurse.token}` } })).status, 404)
    assert.equal((await t.post(`${api}/ipd/documents/${documentId}/remove`, { reason: 'again please' })).status, 409)
  })

  it('keeps each hospital\'s files under its own name and records who looked', async () => {
    const keys = await t.inHospital(() => t.api.ctx.db.query<{ storageKey: string }>('SELECT "storageKey" FROM "EncounterDocument"'))
    assert.ok(keys.every((k) => k.storageKey.startsWith(`${t.facilityId}/${stayId}/`)))
    const actions = ((await t.get(`${api}/audit-log?limit=100`)).body as { action: string }[]).map((a) => a.action)
    for (const expected of ['Document Attached', 'Document Viewed', 'Document Removed']) assert.ok(actions.includes(expected), expected)
  })

  it('is for clinical and billing staff only', async () => {
    assert.equal((await upload(PDF, 'title=Pharmacy%20try', (await t.as('pharmacist')).token)).status, 403)
    assert.equal((await (await t.as('housekeeping')).get(`${api}/ipd/${stayId}/documents`)).status, 403)
  })
})

describe('One-time codes and the SMS simulator', () => {
  let t: TestApi
  before(async () => { t = await startTestApi() })
  after(() => t.close())

  const issue = (phone: string, purpose = 'patient-login') => t.inHospital(() => t.api.ctx.otp.issue(t.api.ctx.db, { phone, purpose }))
  const verify = (id: string, code: string) => t.inHospital(() => t.api.ctx.otp.verify(t.api.ctx.db, id, code))

  it('"sends" a code to the outbox and accepts it once', async () => {
    const challenge = await issue('+91 98765 43210')
    assert.equal(challenge.expiresInSeconds, 300)
    const outbox = (await t.get(`${api}/messages/outbox`)).body
    assert.equal(outbox.provider, 'simulator')
    assert.equal(outbox.messages[0].toPhone, '9876543210', 'the number is normalised to its 10 digits')
    assert.match(outbox.messages[0].body, /^123456 is your verification code/)

    assert.deepEqual(await verify(challenge.challengeId, '123456'), { phone: '9876543210', purpose: 'patient-login' })
    await assert.rejects(verify(challenge.challengeId, '123456'), /not correct or has expired/, 'a code works once')
  })

  it('stops accepting a code after a few wrong tries', async () => {
    const challenge = await issue('9876543211')
    for (let i = 0; i < 5; i++) await assert.rejects(verify(challenge.challengeId, '000000'), /not correct/)
    await assert.rejects(verify(challenge.challengeId, '123456'), /not correct/, 'even the right code is refused now')
  })

  it('does not store the code and refuses numbers that are not Indian mobiles', async () => {
    const challenge = await issue('9876543212')
    const stored = await t.inHospital(() => t.api.ctx.db.query('SELECT * FROM "OtpChallenge" WHERE id = $1', [challenge.challengeId]))
    assert.ok(!JSON.stringify(stored).includes('123456'))
    await assert.rejects(issue('12345'), /valid 10-digit mobile/)
    await assert.rejects(issue('5876543210'), /valid 10-digit mobile/)
  })

  it('limits how many codes one number can ask for in an hour', async () => {
    for (let i = 0; i < 5; i++) await issue('9876543213')
    await assert.rejects(issue('9876543213'), /Too many codes/)
    await issue('9876543214') // another number is unaffected
  })

  it('shows the outbox to administrators only', async () => {
    assert.equal((await (await t.as('nurse')).get(`${api}/messages/outbox`)).status, 403)
  })
})
