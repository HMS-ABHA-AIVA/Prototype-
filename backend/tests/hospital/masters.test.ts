import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { newPatient, seedBasics, startTestApi, strongPassword, tokenFor, type TestApi, stopServer } from './helpers.js'

// One application per test file, shared by its describe blocks: stop it when they are all done.
after(stopServer)

const api = '/api/v1'
const masters = `${api}/masters`

describe('Hospital settings', () => {
  let t: TestApi
  before(async () => { t = await startTestApi() })
  after(() => t.close())

  it('start at the built-in defaults and are changed by an administrator', async () => {
    const before = (await t.get(`${masters}/settings`)).body
    assert.deepEqual(
      [before.opdDefaultFee, before.erFee, before.unlistedTestPrice, before.unlistedMedicinePrice, before.medicineGstPct, before.bedDayCheckoutHour],
      [600, 900, 450, 120, 12, 12],
    )
    const saved = await t.call('PUT', `${masters}/settings`, { erFee: 1100, gstin: '27abcde1234f1z5', billFooter: 'Thank you' })
    assert.equal(saved.status, 200, JSON.stringify(saved.body))
    assert.equal(saved.body.erFee, 1100)
    assert.equal(saved.body.gstin, '27ABCDE1234F1Z5', 'the GSTIN is stored in capitals')
    assert.equal(saved.body.opdDefaultFee, 600, 'what was not changed stays')
  })

  it('refuse a malformed GSTIN or an hour that does not exist', async () => {
    assert.equal((await t.call('PUT', `${masters}/settings`, { gstin: 'NOT-A-GSTIN' })).status, 400)
    assert.equal((await t.call('PUT', `${masters}/settings`, { bedDayCheckoutHour: 25 })).status, 400)
    assert.equal((await t.call('PUT', `${masters}/settings`, { erFee: -1 })).status, 400)
  })

  it('may be read by anyone signed in but changed only by an administrator', async () => {
    const nurse = await t.as('nurse')
    assert.equal((await nurse.get(`${masters}/settings`)).status, 200)
    assert.equal((await nurse.call('PUT', `${masters}/settings`, { erFee: 1 })).status, 403)
  })

  it('set the fee of a doctor who has none of their own', async () => {
    await t.call('PUT', `${masters}/settings`, { opdDefaultFee: 750 })
    const doctor = (await t.post(`${api}/staff`, { name: 'Dr. Default', role: 'doctor', department: 'General Medicine' })).body
    assert.equal(doctor.opdFee, 750)
    const own = (await t.post(`${api}/staff`, { name: 'Dr. Own Fee', role: 'doctor', department: 'Orthopedics', consultationFee: 400 })).body
    assert.equal(own.opdFee, 400)
  })
})

describe('Services and ward bed charges', () => {
  let t: TestApi
  before(async () => { t = await startTestApi() })
  after(() => t.close())

  it('lists, adds, edits and switches off services', async () => {
    const created = await t.post(`${masters}/services`, { code: 'nur-iv', name: 'IV cannulation', category: 'nursing', price: 250, gstPct: 0 })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    assert.equal(created.body.code, 'NUR-IV', 'codes are kept in capitals')
    assert.equal((await t.post(`${masters}/services`, { code: 'NUR-IV', name: 'Another', category: 'nursing', price: 1 })).status, 409, 'a code is used once')
    assert.equal((await t.post(`${masters}/services`, { code: 'X-1', name: 'iv cannulation', category: 'nursing', price: 1 })).status, 409, 'and so is a name')

    const edited = await t.call('PATCH', `${masters}/services/${created.body.id}`, { price: 300 })
    assert.equal(edited.body.price, 300)

    await t.call('PATCH', `${masters}/services/${created.body.id}`, { active: false })
    assert.equal(((await t.get(`${masters}/services`)).body as unknown[]).length, 0, 'a switched-off service is hidden from the people who charge it')
    assert.equal(((await t.get(`${masters}/services?all=true`)).body as unknown[]).length, 1, 'an administrator still sees it')
  })

  it('keeps one daily bed charge per ward and lists the wards with their beds', async () => {
    await seedBasics(t)
    const set = await t.call('PUT', `${masters}/wards`, { ward: 'Ward A', price: 2000, gstPct: 5 })
    assert.equal(set.status, 200, JSON.stringify(set.body))
    assert.equal(set.body.category, 'bed')
    const again = await t.call('PUT', `${masters}/wards`, { ward: 'Ward A', price: 2200 })
    assert.equal(again.body.id, set.body.id, 'setting it again changes the same charge')
    const wards = (await t.get(`${masters}/wards`)).body as { ward: string; beds: number; dailyRate: number | null }[]
    assert.deepEqual(wards.map((w) => [w.ward, w.beds, w.dailyRate]), [['Ward A', 2, 2200]])
  })

  it('refuses a bed charge entered as an ordinary service, and a bad price', async () => {
    assert.equal((await t.post(`${masters}/services`, { code: 'BED-X', name: 'Bed', category: 'bed', price: 1 })).status, 409)
    assert.equal((await t.post(`${masters}/services`, { code: 'NEG-1', name: 'Negative', category: 'other', price: -5 })).status, 400)
    assert.equal((await (await t.as('nurse')).post(`${masters}/services`, { code: 'NUR-2', name: 'Nurse made', category: 'other', price: 5 })).status, 403)
  })
})

describe('Investigations and their normal ranges', () => {
  let t: TestApi
  before(async () => { t = await startTestApi() })
  after(() => t.close())

  it('keeps a lab test with the parameters it measures', async () => {
    const cbc = await t.post(`${masters}/investigations`, {
      code: 'cbc', name: 'Complete Blood Count', kind: 'lab', section: 'Haematology', sample: 'EDTA blood', tatHours: 4, price: 350, gstPct: 0,
      parameters: [
        { name: 'Haemoglobin', unit: 'g/dL', refLow: 12, refHigh: 16 },
        { name: 'WBC', unit: '/uL', refLow: 4000, refHigh: 11000 },
        { name: 'Blood group', refText: 'Reported as A / B / AB / O' },
      ],
    })
    assert.equal(cbc.status, 201, JSON.stringify(cbc.body))
    assert.equal(cbc.body.parameters.length, 3)
    assert.deepEqual(cbc.body.parameters.map((p: any) => p.name), ['Haemoglobin', 'WBC', 'Blood group'], 'in the order given')
    assert.equal(cbc.body.parameters[0].refLow, 12)

    const edited = await t.call('PATCH', `${masters}/investigations/${cbc.body.id}`, { price: 400, parameters: [{ name: 'Haemoglobin', unit: 'g/dL', refLow: 12, refHigh: 17 }] })
    assert.equal(edited.body.price, 400)
    assert.equal(edited.body.parameters.length, 1, 'the parameters are replaced as a set')
  })

  it('refuses a range the wrong way round, and parameters on an X-ray', async () => {
    const reversed = await t.post(`${masters}/investigations`, { code: 'BAD', name: 'Bad Range', kind: 'lab', price: 1, parameters: [{ name: 'X', refLow: 9, refHigh: 3 }] })
    assert.equal(reversed.status, 400)
    const xray = await t.post(`${masters}/investigations`, { code: 'XR', name: 'X-ray Chest', kind: 'radiology', price: 500, parameters: [{ name: 'Finding' }] })
    assert.equal(xray.status, 400)
    assert.equal((await t.post(`${masters}/investigations`, { code: 'XR', name: 'X-ray Chest', kind: 'radiology', price: 500 })).status, 201)
  })

  it('searches by name or code and filters by kind', async () => {
    const hits = (await t.get(`${masters}/investigations?search=blood`)).body as { code: string }[]
    assert.deepEqual(hits.map((h) => h.code), ['CBC'])
    assert.deepEqual(((await t.get(`${masters}/investigations?kind=radiology`)).body as { code: string }[]).map((h) => h.code), ['XR'])
  })
})

describe('Orders and bills use the hospital lists', () => {
  let t: TestApi
  let doctorId: string
  before(async () => {
    t = await startTestApi()
    ;({ doctorId } = await seedBasics(t))
  })
  after(() => t.close())

  const visit = async (name: string) => {
    const patient = await newPatient(t, { name })
    const created = await t.post(`${api}/encounters/opd`, { patientId: patient.id, department: 'General Medicine', doctorId })
    const fee = ((await t.get(`${api}/opd-billing`)).body as { billId: string; encounterId: string }[]).find((a) => a.encounterId === created.body.id)!
    await t.post(`${api}/opd-billing/${fee.billId}/collect`, { paymentMode: 'cash' })
    return created.body.id as string
  }

  it('price a test from the list, naming it as the list does, and an unlisted one at the default', async () => {
    const lipid = (await t.post(`${masters}/investigations`, { code: 'LIPID', name: 'Lipid Profile', kind: 'lab', price: 800, gstPct: 18 })).body
    const id = await visit('Lab Patient')

    const typed = await t.post(`${api}/encounters/${id}/orders`, { type: 'lab', name: 'lipid profile' })
    assert.equal(typed.status, 201, JSON.stringify(typed.body))
    assert.equal(typed.body.name, 'Lipid Profile', 'the name becomes the list\'s')
    assert.equal(typed.body.investigationId, lipid.id)
    const odd = await t.post(`${api}/encounters/${id}/orders`, { type: 'lab', name: 'Some Rare Assay' })
    assert.equal(odd.body.investigationId, null)

    const bill = (await t.post(`${api}/encounters/${id}/close`)).body.bill
    const lipidLine = bill.items.find((i: any) => i.label === 'Lab Test: Lipid Profile')
    assert.deepEqual([lipidLine.rate, lipidLine.gstPct], [800, 18])
    assert.equal(bill.items.find((i: any) => i.label === 'Lab Test: Some Rare Assay').rate, 450, 'unlisted tests use the default price')
    assert.equal(bill.total, 944 + 450)
  })

  it('refuse a test of the wrong kind or one that is switched off', async () => {
    const xray = (await t.post(`${masters}/investigations`, { code: 'XRAY', name: 'X-ray Knee', kind: 'radiology', price: 600 })).body
    const id = await visit('Wrong Kind')
    assert.equal((await t.post(`${api}/encounters/${id}/orders`, { type: 'lab', name: 'X-ray Knee' })).status, 400)
    await t.call('PATCH', `${masters}/investigations/${xray.id}`, { active: false })
    assert.equal((await t.post(`${api}/encounters/${id}/orders`, { type: 'radiology', name: 'X-ray Knee', investigationId: xray.id })).status, 400)
  })

  it('charge a dispensed medicine at its price and GST, or the default when it is not in stock', async () => {
    await t.post(`${api}/pharmacy/drugs`, { name: 'Pantoprazole 40mg', batch: 'P1', expiry: '2030-01-01', stock: 50, reorderLevel: 5, unit: 'tab', mrp: 8 })
    const pharmacist = await t.as('pharmacist')
    const id = await visit('Medicine Patient')
    const rx = (await t.post(`${api}/encounters/${id}/prescriptions`, { drugName: 'Pantoprazole 40mg', dose: '1', frequency: 'OD', duration: '5 days' })).body
    const rare = (await t.post(`${api}/encounters/${id}/prescriptions`, { drugName: 'Unstocked Brand', dose: '1', frequency: 'OD', duration: '5 days' })).body
    await pharmacist.post(`${api}/pharmacy/prescriptions/${rx.id}/dispense`)
    await pharmacist.post(`${api}/pharmacy/prescriptions/${rare.id}/dispense`)
    const bill = (await t.post(`${api}/encounters/${id}/close`)).body.bill
    // A medicine's MRP includes its GST, so its line is entered at the taxable value and the bill comes back to the MRP.
    const stocked = bill.items.find((i: any) => i.label === 'Pharmacy: Pantoprazole 40mg x 1')
    assert.deepEqual([stocked.rate, stocked.gstPct, stocked.amount], [7.14, 12, 8])
    const unlisted = bill.items.find((i: any) => i.label === 'Pharmacy: Unstocked Brand x 1')
    assert.deepEqual([unlisted.rate, unlisted.amount], [107.14, 120])
  })
})

describe('Panel rates for services and tests', () => {
  let t: TestApi
  let panel: string
  let service: string
  let test: string
  before(async () => {
    t = await startTestApi()
    panel = (await t.post(`${api}/panels`, { code: 'CGHS', name: 'CGHS', discountPct: 10 })).body.id
    service = (await t.post(`${masters}/services`, { code: 'PROC-1', name: 'Dressing', category: 'procedure', price: 500 })).body.id
    test = (await t.post(`${masters}/investigations`, { code: 'T-1', name: 'Urine R/M', kind: 'lab', price: 200 })).body.id
  })
  after(() => t.close())

  it('start empty and are replaced as a set', async () => {
    const empty = (await t.get(`${masters}/panels/${panel}/item-rates`)).body
    assert.deepEqual([empty.services[0].rate, empty.investigations[0].rate], [null, null])
    const saved = await t.call('PUT', `${masters}/panels/${panel}/item-rates`, { rates: [{ kind: 'service', itemId: service, rate: 350 }, { kind: 'investigation', itemId: test, rate: 120 }] })
    assert.equal(saved.status, 200, JSON.stringify(saved.body))
    const now = (await t.get(`${masters}/panels/${panel}/item-rates`)).body
    assert.deepEqual([now.services[0].rate, now.investigations[0].rate], [350, 120])
    await t.call('PUT', `${masters}/panels/${panel}/item-rates`, { rates: [] })
    assert.equal((await t.get(`${masters}/panels/${panel}/item-rates`)).body.services[0].rate, null)
  })

  it('refuse an item that does not exist, and anyone but an administrator', async () => {
    const ghost = await t.call('PUT', `${masters}/panels/${panel}/item-rates`, { rates: [{ kind: 'service', itemId: '00000000-0000-4000-8000-000000000000', rate: 1 }] })
    assert.equal(ghost.status, 404)
    assert.equal((await (await t.as('biller')).call('PUT', `${masters}/panels/${panel}/item-rates`, { rates: [] })).status, 403)
    assert.equal((await (await t.as('nurse')).get(`${masters}/panels/${panel}/item-rates`)).status, 403)
  })
})

describe('Prescription templates', () => {
  let t: TestApi
  const items = [{ drugName: 'Paracetamol 500mg', dose: '1 tab', frequency: 'TDS', duration: '3 days' }]
  before(async () => { t = await startTestApi() })
  after(() => t.close())

  it('keep a doctor\'s own sets, and administrators share one with every doctor', async () => {
    const doctor = await t.as('doctor')
    const mine = await doctor.post(`${masters}/rx-templates`, { name: 'Viral fever', diagnosis: 'Viral fever', items })
    assert.equal(mine.status, 201, JSON.stringify(mine.body))
    assert.equal(mine.body.shared, false)
    const shared = await t.post(`${masters}/rx-templates`, { name: 'Hospital standard', items, shared: true })
    assert.equal(shared.body.shared, true)
    const sneaky = await doctor.post(`${masters}/rx-templates`, { name: 'Tried to share', items, shared: true })
    assert.equal(sneaky.body.shared, false, 'only an administrator can share')

    assert.deepEqual(((await doctor.get(`${masters}/rx-templates`)).body as { name: string }[]).map((x) => x.name).sort(), ['Hospital standard', 'Tried to share', 'Viral fever'])
  })

  it('are private to their doctor, and cannot be changed by another', async () => {
    const mine = ((await (await t.as('doctor')).get(`${masters}/rx-templates`)).body as { id: string; name: string }[]).find((x) => x.name === 'Viral fever')!
    const other = (await t.post(`${api}/staff`, { name: 'Dr. Other', role: 'doctor', department: 'ENT' })).body
    const email = `dr-other-${other.id.slice(0, 8)}@example.test`
    const password = strongPassword()
    await t.call('PUT', `${api}/staff/${other.id}/login`, { email, password })
    const token = await tokenFor(t, email, password)
    const call = (method: string, path: string, body?: unknown) => fetch(`${t.api.url}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: method === 'GET' ? null : JSON.stringify(body ?? {}) })
    const seen = (await (await call('GET', `${masters}/rx-templates`)).json()) as { name: string }[]
    assert.ok(!seen.some((x) => x.name === 'Viral fever'), 'another doctor cannot see it')
    assert.equal((await call('DELETE', `${masters}/rx-templates/${mine.id}`)).status, 403)
    assert.equal((await t.call('DELETE', `${masters}/rx-templates/${mine.id}`)).status, 204, 'an administrator can')
  })

  it('need at least one medicine with every field', async () => {
    assert.equal((await t.post(`${masters}/rx-templates`, { name: 'Empty', items: [] })).status, 400)
    assert.equal((await t.post(`${masters}/rx-templates`, { name: 'Half', items: [{ drugName: 'X' }] })).status, 400)
  })
})
