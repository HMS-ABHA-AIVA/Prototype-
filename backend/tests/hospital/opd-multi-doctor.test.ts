import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { newPatient, seedBasics, startTestApi, type TestApi, stopServer } from './helpers.js'

// One application per test file, shared by its describe blocks: stop it when they are all done.
after(stopServer)

const api = '/api/v1'

/** One patient, several doctors (one per speciality) in the same OPD visit: each with a fee, a token and an appointment slip. */
describe('OPD with several doctors for one patient', () => {
  let t: TestApi
  let general: string
  let ortho: string
  let cardio: string
  before(async () => {
    t = await startTestApi()
    ;({ doctorId: general } = await seedBasics(t)) // Dr. Test, General Medicine, standard fee
    ortho = (await t.post(`${api}/staff`, { name: 'Dr. Bones', role: 'doctor', department: 'Orthopedics', consultationFee: 900 })).body.id
    cardio = (await t.post(`${api}/staff`, { name: 'Dr. Heart', role: 'doctor', department: 'Cardiology' })).body.id
  })
  after(() => t.close())

  const GEN = 'General Medicine'
  const register = (patientId: string, consultations: { department: string; doctorId: string }[]) =>
    t.post(`${api}/opd-billing/visits`, { patientId, consultations })
  const awaiting = async () => (await t.get(`${api}/opd-billing`)).body as {
    billId: string; encounterId: string; patientId: string; patientName: string; department: string; doctorName: string; total: number; items: { label: string }[]
  }[]
  const awaitingFor = async (patientId: string) => (await awaiting()).filter((a) => a.patientId === patientId)

  it('each doctor has a patient fee: their own, or the hospital standard; only administrators change it', async () => {
    const staff = (await (await t.as('nurse')).get(`${api}/staff`)).body as { id: string; opdFee: number; consultationFee: number | null }[]
    assert.equal(staff.find((s) => s.id === general)!.opdFee, 600, 'no fee set: the standard OPD fee')
    assert.equal(staff.find((s) => s.id === ortho)!.opdFee, 900)
    assert.equal(staff.find((s) => s.id === ortho)!.consultationFee, 900)

    const updated = await t.call('PATCH', `${api}/staff/${cardio}`, { consultationFee: 750 })
    assert.equal(updated.status, 200, JSON.stringify(updated.body))
    assert.equal(updated.body.opdFee, 750)
    assert.equal((await t.call('PATCH', `${api}/staff/${cardio}`, { consultationFee: null })).body.opdFee, 600, 'cleared: back to the standard fee')
    assert.equal((await t.call('PATCH', `${api}/staff/${cardio}`, { consultationFee: -5 })).status, 400)
    assert.equal((await (await t.as('doctor')).call('PATCH', `${api}/staff/${cardio}`, { consultationFee: 1 })).status, 403)
  })

  it('registers a patient for several doctors at once, each with its own fee bill', async () => {
    const patient = await newPatient(t, { name: 'Multi Doctor One' })
    const r = await register(patient.id, [{ department: GEN, doctorId: general }, { department: 'Orthopedics', doctorId: ortho }])
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.deepEqual(r.body.encounters.map((e: any) => [e.department, e.status, e.tokenNo]), [[GEN, 'awaiting_payment', null], ['Orthopedics', 'awaiting_payment', null]])

    const rows = await awaitingFor(patient.id)
    assert.equal(rows.length, 2)
    assert.deepEqual(rows.map((x) => x.total).sort(), [600, 900], 'each at that doctor\'s own fee')
    assert.ok(rows.find((x) => x.department === 'Orthopedics')!.items[0]!.label.includes('Dr. Bones'), 'the bill names the doctor')
  })

  it('refuses a repeated speciality, and an open visit in one of them, without creating any of the others', async () => {
    const patient = await newPatient(t, { name: 'Multi Doctor Two' })
    const twice = await register(patient.id, [{ department: GEN, doctorId: general }, { department: GEN.toUpperCase(), doctorId: general }])
    assert.equal(twice.status, 400)
    assert.equal((await awaitingFor(patient.id)).length, 0)

    assert.equal((await register(patient.id, [{ department: GEN, doctorId: general }])).status, 201)
    const clash = await register(patient.id, [{ department: 'Orthopedics', doctorId: ortho }, { department: GEN, doctorId: general }])
    assert.equal(clash.status, 409)
    assert.deepEqual((await awaitingFor(patient.id)).map((x) => x.department), [GEN], 'the Orthopedics visit was not left behind')

    assert.equal((await register(patient.id, [])).status, 400)
    assert.equal((await register(patient.id, [{ department: 'X', doctorId: patient.id }])).status, 400, 'must be a real doctor')
  })

  it('one payment covers several doctors: one receipt, a token and an appointment slip for each, who collected it recorded', async () => {
    const patient = await newPatient(t, { name: 'Pays For Two', age: 41, gender: 'F' })
    await register(patient.id, [{ department: GEN, doctorId: general }, { department: 'Orthopedics', doctorId: ortho }])
    const fees = await awaitingFor(patient.id)

    const biller = await t.as('biller')
    const paid = await biller.post(`${api}/opd-billing/collect`, { billIds: fees.map((f) => f.billId), paymentMode: 'upi', reference: 'UPI-7731229' })
    assert.equal(paid.status, 200, JSON.stringify(paid.body))
    const { invoice: payment, encounters, bills } = paid.body
    assert.match(payment.invoiceNo, /^OPD-\d+$/)
    assert.equal(payment.amount, 1500)
    assert.equal(payment.mode, 'upi')
    assert.equal(payment.reference, 'UPI-7731229')
    assert.equal(payment.collectedByName, 'Test biller', 'the signed-in person who took the money')
    assert.ok(payment.collectedAt)
    assert.equal(payment.slips.length, 2)
    assert.deepEqual(encounters.map((e: any) => e.status), ['waiting', 'waiting'])
    assert.ok(bills.every((b: any) => b.status === 'paid' && b.paymentId === payment.id && b.paymentMode === 'upi'))

    const slips = payment.slips as any[]
    const generalSlip = slips.find((s) => s.department === GEN)
    const orthoSlip = slips.find((s) => s.department === 'Orthopedics')
    assert.equal(orthoSlip.doctorName, 'Dr. Bones')
    assert.equal(orthoSlip.fee, 900)
    assert.equal(generalSlip.fee, 600)
    assert.ok(generalSlip.tokenNo >= 1 && orthoSlip.tokenNo >= 1, 'a token for each doctor')
    assert.equal(orthoSlip.patientName, 'Pays For Two')
    assert.equal(orthoSlip.age, 41)
    assert.equal(orthoSlip.receiptNo, payment.invoiceNo)
    assert.notEqual(generalSlip.slipNo, orthoSlip.slipNo, 'each slip has its own number')

    const log = (await t.get(`${api}/audit-log?limit=20`)).body as { action: string; detail: string; user?: string }[]
    assert.ok(log.some((l) => l.action === 'OPD Payment Received' && l.detail.includes(payment.invoiceNo) && /2 consultation/.test(l.detail)))
    assert.equal(log.filter((l) => l.action === 'OPD Fee Collected' && l.detail.includes(payment.invoiceNo)).length, 2)

    // the patient can now be seen by both doctors, independently
    const [a, b] = encounters as { id: string }[]
    assert.equal((await t.post(`${api}/encounters/${a!.id}/start`)).body.status, 'in_consult')
    assert.equal((await t.post(`${api}/encounters/${b!.id}/start`)).body.status, 'in_consult')
    assert.equal((await t.post(`${api}/encounters/${a!.id}/close`)).status, 200)
    assert.equal((await t.get(`${api}/encounters/${b!.id}`)).body.status, 'in_consult', 'closing one doctor\'s consultation does not touch the other')
  })

  it('checks the payment details: a reference for UPI and card, enough cash, and change worked out', async () => {
    const patient = await newPatient(t, { name: 'Payment Rules' })
    await register(patient.id, [{ department: GEN, doctorId: general }, { department: 'Orthopedics', doctorId: ortho }])
    const ids = (await awaitingFor(patient.id)).map((f) => f.billId)
    const collect = (body: Record<string, unknown>) => t.post(`${api}/opd-billing/collect`, { billIds: ids, ...body })

    assert.equal((await collect({ paymentMode: 'upi' })).status, 400, 'UPI needs a transaction id')
    assert.equal((await collect({ paymentMode: 'card', reference: '12' })).status, 400, 'a card payment needs its slip or last digits')
    assert.equal((await collect({ paymentMode: 'cash', amountReceived: 1000 })).status, 400, 'less cash than due')
    assert.equal((await collect({ paymentMode: 'bitcoin' })).status, 400)
    assert.equal((await t.post(`${api}/opd-billing/collect`, { billIds: [ids[0], ids[0]], paymentMode: 'cash' })).status, 400, 'the same fee twice')
    assert.equal((await awaitingFor(patient.id)).length, 2, 'nothing was paid by the refusals')

    const cash = await collect({ paymentMode: 'cash', amountReceived: 2000 })
    assert.equal(cash.status, 200, JSON.stringify(cash.body))
    assert.equal(cash.body.invoice.amount, 1500)
    assert.equal(cash.body.invoice.amountReceived, 2000)
    assert.equal(cash.body.invoice.change, 500)
    assert.equal(cash.body.invoice.reference, null, 'cash needs no reference')
  })

  it('is all or nothing: one fee that cannot be paid stops the whole payment', async () => {
    const patient = await newPatient(t, { name: 'All Or Nothing' })
    await register(patient.id, [{ department: GEN, doctorId: general }, { department: 'Orthopedics', doctorId: ortho }])
    const [first, second] = await awaitingFor(patient.id)
    assert.equal((await t.post(`${api}/opd-billing/${first!.billId}/cancel`)).status, 200)

    const both = await t.post(`${api}/opd-billing/collect`, { billIds: [first!.billId, second!.billId], paymentMode: 'cash' })
    assert.equal(both.status, 409, 'one of them was cancelled')
    assert.deepEqual((await awaitingFor(patient.id)).map((f) => f.billId), [second!.billId], 'the other is still waiting, not half-paid')
    assert.equal((await t.post(`${api}/opd-billing/${second!.billId}/collect`, { paymentMode: 'cash' })).status, 200, 'and can be paid on its own')
  })

  it('one payment cannot mix two patients', async () => {
    const a = await newPatient(t, { name: 'Patient A' })
    const b = await newPatient(t, { name: 'Patient B' })
    await register(a.id, [{ department: GEN, doctorId: general }])
    await register(b.id, [{ department: GEN, doctorId: general }])
    const ids = [...(await awaitingFor(a.id)), ...(await awaitingFor(b.id))].map((f) => f.billId)
    const mixed = await t.post(`${api}/opd-billing/collect`, { billIds: ids, paymentMode: 'cash' })
    assert.equal(mixed.status, 400)
    assert.match(mixed.body.error.message, /one patient/i)
    assert.equal((await awaitingFor(a.id)).length + (await awaitingFor(b.id)).length, 2)
  })

  it('another doctor can be added later, even after the patient has paid for the first', async () => {
    const patient = await newPatient(t, { name: 'Adds A Doctor' })
    await register(patient.id, [{ department: GEN, doctorId: general }])
    const firstPaid = await t.post(`${api}/opd-billing/${(await awaitingFor(patient.id))[0]!.billId}/collect`, { paymentMode: 'cash' })
    assert.equal(firstPaid.status, 200)

    const later = await register(patient.id, [{ department: 'Cardiology', doctorId: cardio }])
    assert.equal(later.status, 201, JSON.stringify(later.body))
    const second = await t.post(`${api}/opd-billing/${(await awaitingFor(patient.id))[0]!.billId}/collect`, { paymentMode: 'cash' })
    assert.equal(second.status, 200)
    assert.equal(second.body.encounter.department, 'Cardiology')
    assert.equal(second.body.encounter.tokenNo, 1, 'Cardiology\'s own queue starts at 1')
    assert.notEqual(second.body.invoice.invoiceNo, firstPaid.body.invoice.invoiceNo, 'a separate payment, a separate receipt')
  })

  it('a doctor\'s fee changing later does not change a bill already raised', async () => {
    const patient = await newPatient(t, { name: 'Fee Change' })
    await register(patient.id, [{ department: 'Orthopedics', doctorId: ortho }])
    await t.call('PATCH', `${api}/staff/${ortho}`, { consultationFee: 1200 })
    assert.equal((await awaitingFor(patient.id))[0]!.total, 900, 'the bill keeps the fee it was raised at')

    const other = await newPatient(t, { name: 'Fee Change Two' })
    await register(other.id, [{ department: 'Orthopedics', doctorId: ortho }])
    assert.equal((await awaitingFor(other.id))[0]!.total, 1200, 'new registrations use the new fee')
    await t.call('PATCH', `${api}/staff/${ortho}`, { consultationFee: 900 })
  })

  it('lists the day\'s invoices with their slips, who collected them, and totals by payment mode', async () => {
    const day = (await t.get(`${api}/opd-billing/invoices`)).body
    assert.match(day.from, /^\d{4}-\d{2}-\d{2}$/)
    assert.ok(day.invoices.length >= 3)
    const upi = day.invoices.find((p: any) => p.reference === 'UPI-7731229')
    assert.ok(upi, 'the earlier UPI payment is listed')
    assert.equal(upi.patientName, 'Pays For Two')
    assert.equal(upi.collectedByName, 'Test biller')
    assert.equal(upi.slips.length, 2, 'slips can be printed again from here')
    assert.equal(upi.lines.length, 2, 'one line per doctor')

    const sum = day.invoices.reduce((s: number, p: any) => s + p.amount, 0)
    assert.equal(day.totals.count, day.invoices.length)
    assert.equal(Math.round(day.totals.collected * 100), Math.round(sum * 100))
    assert.equal(day.totals.refunded, 0)
    assert.equal(Math.round((day.totals.byMode.cash + day.totals.byMode.upi + day.totals.byMode.card + day.totals.byMode.other) * 100), Math.round(sum * 100))
    assert.ok(day.totals.byMode.upi >= 1500)

    const other = (await t.get(`${api}/opd-billing/invoices?from=2001-01-01`)).body
    assert.equal(other.invoices.length, 0)
    assert.equal(other.totals.collected, 0)
    assert.equal((await t.get(`${api}/opd-billing/invoices?from=yesterday`)).status, 400)
  })

  it('is for the front desk, the billing counter and administrators', async () => {
    const patient = await newPatient(t, { name: 'Role Check Multi' })
    for (const role of ['doctor', 'nurse', 'pharmacist']) {
      const client = await t.as(role)
      assert.equal((await client.post(`${api}/opd-billing/visits`, { patientId: patient.id, consultations: [{ department: GEN, doctorId: general }] })).status, 403, `${role} cannot register here`)
      assert.equal((await client.get(`${api}/opd-billing/invoices`)).status, 403, `${role} cannot see payments`)
    }
    const frontDesk = await t.as('front_office')
    assert.equal((await frontDesk.post(`${api}/opd-billing/visits`, { patientId: patient.id, consultations: [{ department: GEN, doctorId: general }] })).status, 201)
    assert.equal((await (await t.as('biller')).get(`${api}/opd-billing/invoices`)).status, 200)
  })
})
