import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { insertEncounter } from '../../src/hospital/modules/encounters/encounters.repository.js'
import { newPatient, seedBasics, startTestApi, type TestApi, stopServer } from './helpers.js'

// One application per test file, shared by its describe blocks: stop it when they are all done.
after(stopServer)

const api = '/api/v1'

/** Registration -> OPD billing (collect the consultation fee) -> OPD queue. */
describe('OPD flow: registration, then OPD billing, then the queue', () => {
  let t: TestApi
  let doctorId: string
  before(async () => {
    t = await startTestApi()
    ;({ doctorId } = await seedBasics(t))
  })
  after(() => t.close())

  const register = async (name: string, department = 'General Medicine') => {
    const patient = await newPatient(t, { name })
    const visit = await t.post(`${api}/encounters/opd`, { patientId: patient.id, department, doctorId })
    return { patient, visit }
  }
  const awaiting = async () => (await t.get(`${api}/opd-billing`)).body as { billId: string; encounterId: string; patientName: string; total: number; items: any[]; department: string; mrn: string; billNo: string }[]
  const feeOf = async (encounterId: string) => {
    const row = (await awaiting()).find((a) => a.encounterId === encounterId)
    assert.ok(row, 'the visit is waiting at OPD billing')
    return row
  }

  it('registering sends the visit to OPD billing: no token yet, and not in the queue', async () => {
    const { patient, visit } = await register('Priya Counter')
    assert.equal(visit.status, 201, JSON.stringify(visit.body))
    assert.equal(visit.body.status, 'awaiting_payment')
    assert.equal(visit.body.tokenNo, null)

    const fee = await feeOf(visit.body.id)
    assert.equal(fee.patientName, 'Priya Counter')
    assert.equal(fee.mrn, patient.mrn)
    assert.equal(fee.total, 600)
    assert.deepEqual(fee.items.map((i) => i.label), ['OPD Consultation Fee: Dr. Test (General Medicine)'])
    assert.match(fee.billNo, /^BILL-/)

    const queue = (await t.get(`${api}/encounters?type=OPD&status=waiting&limit=200`)).body as { id: string }[]
    assert.ok(!queue.some((e) => e.id === visit.body.id), 'not in the OPD queue until paid')
    const dashboard = (await t.get(`${api}/dashboard`)).body
    assert.ok(dashboard.opdAwaitingPayment >= 1)
  })

  it('nothing clinical can happen before the fee is paid', async () => {
    const { visit } = await register('Too Early')
    const id = visit.body.id
    assert.equal((await t.post(`${api}/encounters/${id}/start`)).status, 409)
    assert.equal((await t.post(`${api}/encounters/${id}/vitals`, { pulse: 80 })).status, 409)
    assert.equal((await t.post(`${api}/encounters/${id}/prescriptions`, { drugName: 'X', dose: '1', frequency: 'OD', duration: '1 day' })).status, 409)
    assert.equal((await t.post(`${api}/encounters/${id}/close`)).status, 409)
  })

  it('collecting the fee issues the token and puts the visit in the queue; tokens follow payment order', async () => {
    const first = await register('Paid Second In Line')
    const second = await register('Paid First In Line')
    const feeSecond = await feeOf(second.visit.body.id)
    const feeFirst = await feeOf(first.visit.body.id)

    const paidFirst = await t.post(`${api}/opd-billing/${feeSecond.billId}/collect`, { paymentMode: 'upi', reference: 'UPI-8841' })
    assert.equal(paidFirst.status, 200, JSON.stringify(paidFirst.body))
    assert.equal(paidFirst.body.encounter.status, 'waiting')
    assert.equal(paidFirst.body.bill.status, 'paid')
    assert.equal(paidFirst.body.bill.paymentMode, 'upi')
    assert.ok(paidFirst.body.bill.paidAt)
    const tokenA = paidFirst.body.encounter.tokenNo as number

    const paidSecond = await t.post(`${api}/opd-billing/${feeFirst.billId}/collect`, { paymentMode: 'cash' })
    assert.equal(paidSecond.body.encounter.tokenNo, tokenA + 1, 'the next token goes to the next person to pay')

    const queue = (await t.get(`${api}/encounters?type=OPD&status=waiting&limit=200`)).body as { id: string }[]
    assert.ok(queue.some((e) => e.id === second.visit.body.id) && queue.some((e) => e.id === first.visit.body.id))
    assert.ok(!(await awaiting()).some((a) => a.encounterId === second.visit.body.id), 'no longer waiting at billing')

    const log = (await t.get(`${api}/audit-log?limit=20`)).body as { action: string; detail: string }[]
    assert.ok(log.some((l) => l.action === 'OPD Fee Collected' && /upi/.test(l.detail) && new RegExp(`token #${tokenA}`).test(l.detail)))

    // and the consultation can now begin
    assert.equal((await t.post(`${api}/encounters/${second.visit.body.id}/start`)).body.status, 'in_consult')
  })

  it('numbers tokens per department', async () => {
    const ortho = await register('Ortho Patient', 'Orthopedics')
    const paid = await t.post(`${api}/opd-billing/${(await feeOf(ortho.visit.body.id)).billId}/collect`, { paymentMode: 'card', reference: '4821' })
    assert.equal(paid.body.encounter.tokenNo, 1, 'Orthopedics starts at 1 even though General Medicine already has tokens today')
  })

  it('cannot be collected twice, with a bad mode, or as an ordinary bill', async () => {
    const { visit } = await register('Double Payer')
    const fee = await feeOf(visit.body.id)
    assert.equal((await t.post(`${api}/opd-billing/${fee.billId}/collect`, { paymentMode: 'bitcoin' })).status, 400)
    assert.equal((await t.post(`${api}/opd-billing/${fee.billId}/collect`, {})).status, 400, 'a payment mode is required')
    assert.equal((await t.post(`${api}/bills/${fee.billId}/finalize`)).status, 409, 'fee bills are collected at OPD billing, not finalized')
    assert.equal((await t.post(`${api}/bills/${fee.billId}/pay`)).status, 409)

    assert.equal((await t.post(`${api}/opd-billing/${fee.billId}/collect`, { paymentMode: 'cash' })).status, 200)
    const again = await t.post(`${api}/opd-billing/${fee.billId}/collect`, { paymentMode: 'cash' })
    assert.equal(again.status, 409)
    assert.equal((await t.post(`${api}/opd-billing/${fee.billId}/cancel`)).status, 409, 'a paid visit cannot be cancelled here')
  })

  it('a visit that is never paid can be cancelled: bill voided, no token, no queue', async () => {
    const { visit } = await register('Walked Away')
    const fee = await feeOf(visit.body.id)
    const cancelled = await t.post(`${api}/opd-billing/${fee.billId}/cancel`)
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body))
    assert.equal(cancelled.body.encounter.status, 'cancelled')
    assert.equal(cancelled.body.encounter.tokenNo, null)
    assert.equal((await t.get(`${api}/bills/${fee.billId}`)).body.status, 'void')
    assert.ok(!(await awaiting()).some((a) => a.encounterId === visit.body.id))
    assert.equal((await t.post(`${api}/opd-billing/${fee.billId}/collect`, { paymentMode: 'cash' })).status, 409, 'cannot pay a cancelled visit')
    assert.equal((await t.post(`${api}/encounters/${visit.body.id}/start`)).status, 409)
    const log = (await t.get(`${api}/audit-log?limit=20`)).body as { action: string }[]
    assert.ok(log.some((l) => l.action === 'OPD Visit Cancelled Before Payment'))
  })

  it('does not allow the same patient two open visits in one department, but allows another department, or a new try after cancelling', async () => {
    const patient = await newPatient(t, { name: 'Repeat Visitor' })
    const open = (body: Record<string, unknown>) => t.post(`${api}/encounters/opd`, body)
    const first = await open({ patientId: patient.id, department: 'General Medicine', doctorId })
    assert.equal(first.status, 201)
    const duplicate = await open({ patientId: patient.id, department: 'General Medicine', doctorId })
    assert.equal(duplicate.status, 409)
    assert.match(duplicate.body.error.message, /already has an open/)
    assert.equal((await open({ patientId: patient.id, department: 'Pediatrics', doctorId })).status, 201, 'a different department is a different visit')

    await t.post(`${api}/opd-billing/${(await feeOf(first.body.id)).billId}/cancel`)
    assert.equal((await open({ patientId: patient.id, department: 'General Medicine', doctorId })).status, 201)
  })

  it('closing a consultation does not charge the consultation fee again, and bills only what else was ordered', async () => {
    const { visit } = await register('Lab Patient')
    await t.post(`${api}/opd-billing/${(await feeOf(visit.body.id)).billId}/collect`, { paymentMode: 'cash' })
    await t.post(`${api}/encounters/${visit.body.id}/start`)
    await t.post(`${api}/encounters/${visit.body.id}/orders`, { type: 'lab', name: 'CBC' })
    const closed = await t.post(`${api}/encounters/${visit.body.id}/close`)
    assert.equal(closed.status, 200, JSON.stringify(closed.body))
    assert.deepEqual(closed.body.bill.items.map((i: any) => i.label), ['Lab Test: CBC'])
    assert.equal(closed.body.bill.total, 450)

    const bills = (await t.get(`${api}/bills?limit=200`)).body as { encounterId: string; kind: string; status: string }[]
    const mine = bills.filter((b) => b.encounterId === visit.body.id)
    assert.deepEqual(mine.map((b) => `${b.kind}:${b.status}`).sort(), ['final:draft', 'opd_fee:paid'])
  })

  it('a consultation with nothing more to charge simply completes, with no second bill', async () => {
    const { visit } = await register('Fee Only')
    await t.post(`${api}/opd-billing/${(await feeOf(visit.body.id)).billId}/collect`, { paymentMode: 'cash' })
    await t.post(`${api}/encounters/${visit.body.id}/start`)
    const closed = await t.post(`${api}/encounters/${visit.body.id}/close`)
    assert.equal(closed.status, 200, JSON.stringify(closed.body))
    assert.equal(closed.body.bill, null)
    assert.equal(closed.body.encounter.status, 'closed')
    assert.equal(closed.body.encounter.billed, true, 'the fee was the whole bill and it is paid')
    const bills = (await t.get(`${api}/bills?limit=200`)).body as { encounterId: string }[]
    assert.equal(bills.filter((b) => b.encounterId === visit.body.id).length, 1)
  })

  it('still bills the consultation fee on a visit that never went through OPD billing (older records)', async () => {
    const patient = await newPatient(t, { name: 'Older Record' })
    const old = (await t.inHospital(() => insertEncounter(t.api.ctx.db, { patientId: patient.id, type: 'OPD', status: 'in_consult', doctorId, department: 'General Medicine', tokenNo: 99 })))!
    const closed = await t.post(`${api}/encounters/${old.id}/close`)
    assert.equal(closed.status, 200, JSON.stringify(closed.body))
    assert.deepEqual(closed.body.bill.items.map((i: any) => i.label), ['OPD Consultation Fee'])
    assert.equal(closed.body.bill.total, 600)
  })

  it('an ordinary bill records how it was paid', async () => {
    const { visit } = await register('Pays By Card')
    await t.post(`${api}/opd-billing/${(await feeOf(visit.body.id)).billId}/collect`, { paymentMode: 'cash' })
    await t.post(`${api}/encounters/${visit.body.id}/orders`, { type: 'lab', name: 'Urine R/M' })
    const bill = (await t.post(`${api}/encounters/${visit.body.id}/close`)).body.bill
    await t.post(`${api}/bills/${bill.id}/finalize`)
    const paid = await t.post(`${api}/bills/${bill.id}/pay`, { paymentMode: 'card' })
    assert.equal(paid.status, 200, JSON.stringify(paid.body))
    assert.equal(paid.body.paymentMode, 'card')
    assert.equal((await t.post(`${api}/bills/${bill.id}/pay`, { paymentMode: 'nonsense' })).status, 400)
  })

  it('may be done by the front desk, the billing counter and administrators, but not by clinical staff', async () => {
    const { visit } = await register('Role Check')
    const fee = await feeOf(visit.body.id)

    for (const role of ['doctor', 'nurse', 'pharmacist', 'housekeeping']) {
      const client = await t.as(role)
      assert.equal((await client.get(`${api}/opd-billing`)).status, 403, `${role} cannot see OPD billing`)
      assert.equal((await client.post(`${api}/opd-billing/${fee.billId}/collect`, { paymentMode: 'cash' })).status, 403, `${role} cannot collect`)
    }
    const frontDesk = await t.as('front_office')
    assert.equal((await frontDesk.get(`${api}/opd-billing`)).status, 200)
    const biller = await t.as('biller')
    assert.equal((await biller.get(`${api}/opd-billing`)).status, 200)
    assert.equal((await frontDesk.post(`${api}/opd-billing/${fee.billId}/collect`, { paymentMode: 'cash' })).status, 200)
  })
})
