import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { checkInOpdPaid, newPatient, seedBasics, startTestApi, type TestApi, stopServer } from './helpers.js'

// One application per test file, shared by its describe blocks: stop it when they are all done.
after(stopServer)

const api = '/api/v1'

describe('OPD consultation', () => {
  let t: TestApi
  let doctorId: string
  before(async () => {
    t = await startTestApi()
    ;({ doctorId } = await seedBasics(t))
  })
  after(() => t.close())

  it('numbers queue tokens per department', async () => {
    const a = await newPatient(t, { name: 'Anil Kumar' })
    const b = await newPatient(t, { name: 'Bina Shah' })
    const first = await checkInOpdPaid(t, { patientId: a.id, department: 'General Medicine', doctorId })
    const second = await checkInOpdPaid(t, { patientId: b.id, department: 'General Medicine', doctorId })
    const other = await checkInOpdPaid(t, { patientId: b.id, department: 'Orthopedics', doctorId })
    assert.equal(first.status, 201)
    assert.equal(first.body.tokenNo, 1)
    assert.equal(second.body.tokenNo, 2)
    assert.equal(other.body.tokenNo, 1, 'each department has its own queue')
    assert.equal(first.body.status, 'waiting')
  })

  it('runs a full consultation and bills it', async () => {
    const patient = await newPatient(t, { name: 'Full Consult' })
    const visit = (await checkInOpdPaid(t, { patientId: patient.id, department: 'General Medicine', doctorId })).body

    assert.equal((await t.post(`${api}/encounters/${visit.id}/start`)).body.status, 'in_consult')
    const soap = await t.call('PUT', `${api}/encounters/${visit.id}/soap`, { subjective: 'Cough', assessment: 'Viral URTI', plan: 'Rest' })
    assert.equal(soap.body.soap.assessment, 'Viral URTI')
    assert.equal((await t.post(`${api}/encounters/${visit.id}/vitals`, { tempF: 99.1, pulse: 82, bp: '120/80', spo2: 98 })).status, 201)
    const rx = (await t.post(`${api}/encounters/${visit.id}/prescriptions`, { drugName: 'Paracetamol 500mg', dose: '1 tab', frequency: 'TDS', duration: '3 days' })).body
    assert.equal((await t.post(`${api}/encounters/${visit.id}/orders`, { type: 'lab', name: 'CBC' })).status, 201)

    // The pharmacy hands over the medicine before the consultation is billed.
    const dispensed = await t.post(`${api}/pharmacy/prescriptions/${rx.id}/dispense`)
    assert.equal(dispensed.status, 200)
    assert.equal(dispensed.body.stockUpdated, false, 'drug is not in the stock list, so no stock changes')

    const closed = await t.post(`${api}/encounters/${visit.id}/close`)
    assert.equal(closed.status, 200, JSON.stringify(closed.body))
    assert.equal(closed.body.encounter.status, 'closed')
    // The 600 consultation fee was already collected at OPD billing; this bill is the rest: 450 lab + a medicine at the unlisted MRP of 120 (which includes its 12% GST)
    assert.equal(closed.body.bill.items.length, 2)
    assert.ok(!closed.body.bill.items.some((i: any) => /Consultation/.test(i.label)), 'the consultation fee is not charged twice')
    assert.equal(closed.body.bill.subtotal, 557.14, '450 + the medicine taxable value')
    assert.equal(closed.body.bill.gstTotal, 12.86)
    assert.equal(closed.body.bill.total, 570, 'the medicine comes back to its MRP')

    const detail = (await t.get(`${api}/encounters/${visit.id}`)).body
    assert.equal(detail.vitals.length, 1)
    assert.equal(detail.prescriptions[0].dispensed, true)
    assert.equal(detail.orders.length, 1)
  })

  it("puts a medicine handed over after the visit closed on the visit's bill", async () => {
    const rxFor = async (visitId: string) =>
      (await t.post(`${api}/encounters/${visitId}/prescriptions`, { drugName: 'Paracetamol 500mg', dose: '1 tab', frequency: 'TDS', duration: '3 days' })).body.id as string
    const visitFor = async (name: string) => {
      const patient = await newPatient(t, { name })
      const visit = (await checkInOpdPaid(t, { patientId: patient.id, department: 'General Medicine', doctorId })).body
      await t.post(`${api}/encounters/${visit.id}/start`)
      return { patientId: patient.id, visitId: visit.id as string }
    }

    // The usual order: the doctor closes the visit, then the patient goes to the pharmacy. The draft bill gets the medicine.
    const first = await visitFor('Late Pharmacy')
    const rx = await rxFor(first.visitId)
    await t.post(`${api}/encounters/${first.visitId}/orders`, { type: 'lab', name: 'CBC' })
    const closed = (await t.post(`${api}/encounters/${first.visitId}/close`)).body
    assert.equal(closed.bill.items.length, 1, 'only the test so far')
    const dispensed = (await t.post(`${api}/pharmacy/prescriptions/${rx}/dispense`)).body
    assert.equal(dispensed.billNo, closed.bill.billNo)
    const bill = ((await t.get(`${api}/bills?patientId=${first.patientId}`)).body as any[]).find((b) => b.billNo === closed.bill.billNo)
    assert.equal(bill.items.length, 2)
    assert.equal(bill.total, 570, 'the same as when the medicine is handed over before the visit closes')

    // A visit with nothing else to charge (its fee was collected up front): the medicine gets a draft bill of its own.
    const second = await visitFor('Medicine Only')
    const rx2 = await rxFor(second.visitId)
    assert.equal((await t.post(`${api}/encounters/${second.visitId}/close`)).body.bill, null)
    const made = (await t.post(`${api}/pharmacy/prescriptions/${rx2}/dispense`)).body
    assert.match(made.billNo, /^BILL-\d+$/)
    const own = ((await t.get(`${api}/bills?patientId=${second.patientId}`)).body as any[]).find((b) => b.billNo === made.billNo)
    assert.deepEqual([own.status, own.items.length], ['draft', 1])

    // Once the bill is finalised it cannot change: the counter is told, and it is in the audit log.
    const third = await visitFor('Billed Already')
    const rx3 = await rxFor(third.visitId)
    await t.post(`${api}/encounters/${third.visitId}/orders`, { type: 'lab', name: 'CBC' })
    const thirdBill = (await t.post(`${api}/encounters/${third.visitId}/close`)).body.bill
    assert.equal((await t.post(`${api}/bills/${thirdBill.id}/finalize`)).status, 200)
    const late = (await t.post(`${api}/pharmacy/prescriptions/${rx3}/dispense`)).body
    assert.equal(late.billFinalised, true)
    const log = (await t.get(`${api}/audit-log?limit=10`)).body as { action: string }[]
    assert.ok(log.some((l) => l.action === 'Medicine Dispensed After Billing'))
  })

  it('refuses further entries once the visit is closed', async () => {
    const patient = await newPatient(t, { name: 'Closed Visit' })
    const visit = (await checkInOpdPaid(t, { patientId: patient.id, department: 'General Medicine', doctorId })).body
    await t.post(`${api}/encounters/${visit.id}/close`)
    const late = await t.post(`${api}/encounters/${visit.id}/orders`, { type: 'lab', name: 'Late order' })
    assert.equal(late.status, 409)
    assert.match(late.body.error.message, /already closed/)
    assert.equal((await t.post(`${api}/encounters/${visit.id}/close`)).status, 409)
  })

  it('validates clinical input', async () => {
    const patient = await newPatient(t, { name: 'Validation' })
    const visit = (await checkInOpdPaid(t, { patientId: patient.id, department: 'General Medicine', doctorId })).body
    const badVitals = await t.post(`${api}/encounters/${visit.id}/vitals`, { bp: 'high' })
    assert.equal(badVitals.status, 400)
    const empty = await t.post(`${api}/encounters/${visit.id}/vitals`, {})
    assert.equal(empty.status, 400)
    const notADoctor = await checkInOpdPaid(t, { patientId: patient.id, department: 'X', doctorId: patient.id })
    assert.equal(notADoctor.status, 400)
    assert.equal((await t.get(`${api}/encounters/not-a-uuid`)).status, 400)
    assert.equal((await t.get(`${api}/encounters/00000000-0000-4000-8000-000000000000`)).status, 404)
  })
})

describe('Emergency care', () => {
  let t: TestApi
  let doctorId: string
  let bedA: string
  before(async () => {
    t = await startTestApi()
    ;({ doctorId, bedA } = await seedBasics(t))
  })
  after(() => t.close())

  async function erCase(overrides: Record<string, unknown> = {}) {
    const patient = await newPatient(t, { name: 'ER Patient' })
    const visit = await t.post(`${api}/encounters/er`, {
      patientId: patient.id, chiefComplaint: 'Chest pain', triageLevel: 'red', arrivalMode: 'ambulance', doctorId, ...overrides,
    })
    return { patient, visit: visit.body }
  }

  it('checks a patient into the ER with triage', async () => {
    const { visit } = await erCase()
    assert.equal(visit.type, 'ER')
    assert.equal(visit.status, 'in_er')
    assert.equal(visit.triageLevel, 'red')
    assert.equal(visit.department, 'Emergency')
  })

  it('re-triages as the patient\'s condition changes', async () => {
    const { visit } = await erCase({ triageLevel: 'yellow' })
    const changed = await t.call('PATCH', `${api}/encounters/${visit.id}/triage`, { triageLevel: 'red' })
    assert.equal(changed.body.triageLevel, 'red')
  })

  it('discharges from the ER and bills the visit', async () => {
    const { visit } = await erCase({ triageLevel: 'green' })
    const result = await t.post(`${api}/encounters/${visit.id}/er-disposition`, { disposition: 'discharged', note: 'Sprain only, advised RICE' })
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.equal(result.body.encounter.status, 'discharged')
    assert.equal(result.body.encounter.dispositionNote, 'Sprain only, advised RICE')
    assert.equal(result.body.bill.total, 900, 'emergency fee')
  })

  it('requires a facility when referring out', async () => {
    const { visit } = await erCase()
    const missing = await t.post(`${api}/encounters/${visit.id}/er-disposition`, { disposition: 'referred', note: 'Needs surgical ICU' })
    assert.equal(missing.status, 400)
    assert.equal(missing.body.error.details[0].field, 'referredTo')
    const ok = await t.post(`${api}/encounters/${visit.id}/er-disposition`, { disposition: 'referred', note: 'Needs surgical ICU', referredTo: 'City General Hospital' })
    assert.equal(ok.body.encounter.status, 'referred')
    assert.equal(ok.body.encounter.referredTo, 'City General Hospital')
  })

  it('records LAMA and a death', async () => {
    const lama = await erCase()
    assert.equal((await t.post(`${api}/encounters/${lama.visit.id}/er-disposition`, { disposition: 'lama', note: 'Left against advice' })).body.encounter.status, 'lama')
    const death = await erCase()
    assert.equal((await t.post(`${api}/encounters/${death.visit.id}/er-disposition`, { disposition: 'deceased', note: 'Cardiac arrest' })).body.encounter.status, 'deceased')
  })

  it('admits to a bed: links both visits, occupies the bed, bills the ER stay', async () => {
    const { patient, visit } = await erCase()
    await t.post(`${api}/encounters/${visit.id}/orders`, { type: 'lab', name: 'Troponin-I' })

    const admitted = await t.post(`${api}/encounters/${visit.id}/admit`, { department: 'Cardiology', doctorId, bedId: bedA })
    assert.equal(admitted.status, 201, JSON.stringify(admitted.body))
    assert.equal(admitted.body.admission.type, 'IPD')
    assert.equal(admitted.body.admission.status, 'admitted')
    assert.equal(admitted.body.admission.linkedEncounterId, visit.id)
    assert.equal(admitted.body.source.status, 'admitted')
    assert.equal(admitted.body.source.linkedEncounterId, admitted.body.admission.id)
    assert.equal(admitted.body.bill.total, 1350, 'ER fee 900 + troponin 450')

    const bed = (await t.get(`${api}/beds`)).body.find((b: any) => b.id === bedA)
    assert.equal(bed.status, 'occupied')
    assert.equal(bed.patientId, patient.id)
  })

  it('does not admit into an occupied bed', async () => {
    const { visit } = await erCase()
    const response = await t.post(`${api}/encounters/${visit.id}/admit`, { department: 'Cardiology', doctorId, bedId: bedA })
    assert.equal(response.status, 409)
    assert.match(response.body.error.message, /not vacant/)
  })
})

describe('Inpatient stay, discharge and housekeeping', () => {
  let t: TestApi
  let doctorId: string
  let bedA: string
  before(async () => {
    t = await startTestApi()
    ;({ doctorId, bedA } = await seedBasics(t))
    // The ward's daily bed charge: a stay is billed from the hospital's own rates, not a built-in price.
    assert.equal((await t.call('PUT', `${api}/masters/wards`, { ward: 'Ward A', price: 3500 })).status, 200)
  })
  after(() => t.close())

  it('discharge frees the bed for housekeeping, which turns it over step by step', async () => {
    const patient = await newPatient(t, { name: 'Inpatient' })
    const stay = (await t.post(`${api}/encounters/ipd`, { patientId: patient.id, department: 'Nephrology', doctorId, bedId: bedA })).body

    const discharged = await t.post(`${api}/encounters/${stay.id}/discharge`, { summary: 'Recovered well. Follow up in 7 days.' })
    assert.equal(discharged.status, 200, JSON.stringify(discharged.body))
    assert.equal(discharged.body.encounter.status, 'discharged')
    assert.equal(discharged.body.bill.total, 3500, 'one bed day at the ward rate')
    assert.match(discharged.body.bill.items[0].label, /^Bed charge: Ward A/)

    const bedState = async () => (await t.get(`${api}/beds`)).body.find((b: any) => b.id === bedA).status
    assert.equal(await bedState(), 'dirty')

    assert.equal((await t.post(`${api}/beds/${bedA}/complete-cleaning`)).status, 409, 'cannot finish cleaning a bed nobody started')
    assert.equal((await t.post(`${api}/beds/${bedA}/start-cleaning`)).body.status, 'cleaning')
    assert.equal((await t.post(`${api}/beds/${bedA}/complete-cleaning`)).body.status, 'vacant')
  })

  it('records the whole story in the audit log', async () => {
    const actions = ((await t.get(`${api}/audit-log?limit=100`)).body as { action: string }[]).map((a) => a.action)
    for (const expected of ['Patient Admitted', 'Discharge Summary Signed Off', 'Bed Released for Housekeeping', 'Bed Cleaning Started', 'Bed Cleaning Completed', 'Bill Generated']) {
      assert.ok(actions.includes(expected), `audit log should contain "${expected}"`)
    }
  })
})

describe('Pharmacy', () => {
  let t: TestApi
  let doctorId: string
  before(async () => {
    t = await startTestApi()
    ;({ doctorId } = await seedBasics(t))
  })
  after(() => t.close())

  it('takes stock off when a prescription is dispensed, and stops at zero', async () => {
    await t.post(`${api}/pharmacy/drugs`, { name: 'Amoxicillin 500mg', batch: 'B1', expiry: '2027-12-31', stock: 1, reorderLevel: 5, unit: 'cap', mrp: 6.2 })
    const patient = await newPatient(t, { name: 'Pharmacy Patient' })
    const visit = (await checkInOpdPaid(t, { patientId: patient.id, department: 'General Medicine', doctorId })).body
    const rx1 = (await t.post(`${api}/encounters/${visit.id}/prescriptions`, { drugName: 'amoxicillin 500MG', dose: '1 cap', frequency: 'BD', duration: '5 days' })).body
    const rx2 = (await t.post(`${api}/encounters/${visit.id}/prescriptions`, { drugName: 'Amoxicillin 500mg', dose: '1 cap', frequency: 'BD', duration: '5 days' })).body

    const first = await t.post(`${api}/pharmacy/prescriptions/${rx1.id}/dispense`)
    assert.equal(first.body.stockUpdated, true)
    assert.equal(first.body.remainingStock, 0)
    assert.equal((await t.post(`${api}/pharmacy/prescriptions/${rx1.id}/dispense`)).status, 409, 'cannot dispense twice')
    const outOfStock = await t.post(`${api}/pharmacy/prescriptions/${rx2.id}/dispense`)
    assert.equal(outOfStock.status, 409)
    assert.match(outOfStock.body.error.message, /out of stock/)
  })

  it('lists the dispense queue and stock alerts', async () => {
    const queue = (await t.get(`${api}/pharmacy/queue`)).body
    assert.ok(queue.some((q: any) => q.drugName === 'Amoxicillin 500mg' && q.patientName === 'Pharmacy Patient'))
    const alerts = (await t.get(`${api}/pharmacy/alerts`)).body
    assert.ok(alerts.lowStock.some((d: any) => d.name === 'Amoxicillin 500mg'))
  })
})

describe('Billing', () => {
  let t: TestApi
  let doctorId: string
  before(async () => {
    t = await startTestApi()
    ;({ doctorId } = await seedBasics(t))
  })
  after(() => t.close())

  it('moves a bill from draft to finalized to paid, and nothing else', async () => {
    const patient = await newPatient(t, { name: 'Payer' })
    const visit = (await checkInOpdPaid(t, { patientId: patient.id, department: 'General Medicine', doctorId })).body
    await t.post(`${api}/encounters/${visit.id}/orders`, { type: 'lab', name: 'CBC' }) // something beyond the consultation fee to bill
    const bill = (await t.post(`${api}/encounters/${visit.id}/close`)).body.bill
    assert.equal(bill.status, 'draft')

    assert.equal((await t.post(`${api}/bills/${bill.id}/pay`)).status, 409, 'cannot pay a draft')
    const finalized = await t.post(`${api}/bills/${bill.id}/finalize`)
    assert.equal(finalized.body.status, 'finalized')
    assert.equal((await t.get(`${api}/encounters/${visit.id}`)).body.billed, true)
    assert.equal((await t.post(`${api}/bills/${bill.id}/finalize`)).status, 409)
    assert.equal((await t.post(`${api}/bills/${bill.id}/pay`)).body.status, 'paid')
  })

  it('lists bills, optionally for one patient', async () => {
    const all = (await t.get(`${api}/bills`)).body
    assert.ok(all.length >= 1)
    const none = (await t.get(`${api}/bills?patientId=00000000-0000-4000-8000-000000000000`)).body
    assert.equal(none.length, 0)
  })
})
