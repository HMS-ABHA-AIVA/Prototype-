import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { BedStayRow } from '../../src/hospital/modules/beds/beds.repository.js'
import { bedDaysFor } from '../../src/hospital/modules/ipd/running-bill.js'
import { newPatient, seedBasics, startTestApi, type TestApi, stopServer } from './helpers.js'

// One application per test file, shared by its describe blocks: stop it when they are all done.
after(stopServer)

const api = '/api/v1'
const stay = (ward: string, from: string, to: string | null): BedStayRow => ({ id: ward + from, encounterId: 'e', bedId: ward, ward, bedNo: '1', fromAt: from, toAt: to })

describe('Bed days', () => {
  // 10:00 on Monday 2 March 2026, Indian time, is 04:30 UTC.
  const admitted = new Date('2026-03-02T04:30:00Z')

  it('count the day of admission, and each later day the patient was still in at the checkout hour', () => {
    const stays = [stay('Ward A', '2026-03-02T04:30:00Z', null)]
    assert.deepEqual(bedDaysFor(stays, admitted, new Date('2026-03-02T11:00:00Z'), 12).map((d) => d.date), ['2026-03-02'], 'same day')
    assert.deepEqual(bedDaysFor(stays, admitted, new Date('2026-03-04T05:30:00Z'), 12).map((d) => d.date), ['2026-03-02', '2026-03-03'], 'out at 11:00 on the 4th: that day is not charged')
    assert.deepEqual(bedDaysFor(stays, admitted, new Date('2026-03-04T08:30:00Z'), 12).map((d) => d.date), ['2026-03-02', '2026-03-03', '2026-03-04'], 'out at 14:00 on the 4th: it is')
  })

  it('follow the hospital\'s checkout hour', () => {
    const stays = [stay('Ward A', '2026-03-02T04:30:00Z', null)]
    // Out at 11:00 on the 3rd: after a 10:00 checkout hour that is a second day.
    assert.equal(bedDaysFor(stays, admitted, new Date('2026-03-03T05:30:00Z'), 10).length, 2)
    assert.equal(bedDaysFor(stays, admitted, new Date('2026-03-03T05:30:00Z'), 12).length, 1)
  })

  it('charge the ward the patient was in at the checkout hour', () => {
    const stays = [
      stay('ICU', '2026-03-02T04:30:00Z', '2026-03-03T09:30:00Z'), // moved at 15:00 on the 3rd
      stay('Ward A', '2026-03-03T09:30:00Z', null),
    ]
    const days = bedDaysFor(stays, admitted, new Date('2026-03-04T07:30:00Z'), 12)
    assert.deepEqual(days.map((d) => [d.date, d.ward]), [['2026-03-02', 'ICU'], ['2026-03-03', 'ICU'], ['2026-03-04', 'Ward A']])
  })

  it('count nothing for a stay with no bed', () => {
    assert.deepEqual(bedDaysFor([], admitted, new Date('2026-03-05T00:00:00Z'), 12), [])
  })

  it('use the Indian calendar, not UTC', () => {
    // 23:30 IST on the 2nd is 18:00 UTC the same day; 00:30 IST on the 3rd is 19:00 UTC on the 2nd.
    const late = new Date('2026-03-02T18:00:00Z')
    const stays = [stay('Ward A', late.toISOString(), null)]
    assert.deepEqual(bedDaysFor(stays, late, new Date('2026-03-03T08:30:00Z'), 12).map((d) => d.date), ['2026-03-02', '2026-03-03'])
  })
})

describe('An admission, billed', () => {
  let t: TestApi
  let doctorId: string
  let bedA: string
  let bedB: string
  let wardService: string

  before(async () => {
    t = await startTestApi()
    ;({ doctorId, bedA, bedB } = await seedBasics(t))
    const ward = await t.call('PUT', `${api}/masters/wards`, { ward: 'Ward A', price: 2000, gstPct: 5 })
    wardService = ward.body.id
  })
  after(() => t.close())

  const admit = async (name: string, bedId = bedA) => {
    const patient = await newPatient(t, { name })
    const stay = await t.post(`${api}/encounters/ipd`, { patientId: patient.id, department: 'Medicine', doctorId, bedId })
    assert.equal(stay.status, 201, JSON.stringify(stay.body))
    return { patient, stayId: stay.body.id as string }
  }
  const bill = async (stayId: string, client: TestApi = t) => (await client.get(`${api}/ipd-billing/${stayId}`)).body
  const mark = async (stayId: string, path: string, body: unknown, client: TestApi = t) => client.post(`${api}/ipd-billing/${stayId}/${path}`, body)

  let service: string
  let stayId: string
  let patientId: string

  it('posts the first bed day when the running bill is opened, and never twice', async () => {
    service = (await t.post(`${api}/masters/services`, { code: 'NEB', name: 'Nebulisation', category: 'nursing', price: 300 })).body.id
    ;({ stayId, patient: { id: patientId } } = await admit('Running Bill'))
    const first = await bill(stayId)
    assert.equal(first.lines.length, 1)
    assert.deepEqual([first.lines[0].source, first.lines[0].description, first.lines[0].rate, first.lines[0].gstPct, first.lines[0].amount], ['bed', 'Bed charge: Ward A', 2000, 5, 2100])
    assert.equal((await bill(stayId)).lines.length, 1, 'opening it again posts nothing more')
    assert.deepEqual([first.subtotal, first.gstTotal, first.total, first.balance], [2000, 100, 2100, 2100])
    assert.equal(first.bed.ward, 'Ward A')
  })

  it('catches up the days that have passed', async () => {
    const { stayId: old } = await admit('Long Stay', bedB)
    const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString()
    await t.inHospital(async () => {
      await t.api.ctx.db.execute('UPDATE "Encounter" SET "admittedAt" = $2 WHERE id = $1', [old, threeDaysAgo])
      await t.api.ctx.db.execute('UPDATE "BedStay" SET "fromAt" = $2 WHERE "encounterId" = $1', [old, threeDaysAgo])
    })
    const running = await bill(old)
    const dates = running.lines.map((l: any) => l.date)
    assert.ok(dates.length >= 3 && dates.length <= 4, `three or four bed days (got ${dates.length})`)
    assert.equal(new Set(dates).size, dates.length, 'one line per day')
    assert.equal((await bill(old)).lines.length, dates.length, 'and nothing is added by looking again')
  })

  it('lets the ward add services from the list but not one-off items or changed rates', async () => {
    const nurse = await t.as('nurse')
    const added = await mark(stayId, 'charges', { serviceId: service, qty: 2 }, nurse)
    assert.equal(added.status, 201, JSON.stringify(added.body))
    const line = added.body.lines.find((l: any) => l.description === 'Nebulisation')
    assert.deepEqual([line.qty, line.rate, line.amount], [2, 300, 600])

    assert.equal((await mark(stayId, 'charges', { serviceId: service, qty: 1, rate: 100, rateNote: 'discount' }, nurse)).status, 400, 'a nurse cannot change a rate')
    assert.equal((await mark(stayId, 'charges', { description: 'Oxygen cylinder', rate: 800, qty: 1 }, nurse)).status, 400, 'or add an item that is not on the list')
    assert.equal((await mark(stayId, 'charges', { serviceId: wardService, qty: 1 }, nurse)).status, 400, 'bed days are posted by the system')
    assert.equal((await mark(stayId, 'charges', { serviceId: service, qty: 1, date: '2999-01-01' }, nurse)).status, 400, 'nothing is dated in the future')
  })

  it('lets the billing counter change a rate (with a reason), add one-off items, and void with a reason', async () => {
    const biller = await t.as('biller')
    assert.equal((await mark(stayId, 'charges', { serviceId: service, qty: 1, rate: 250 }, biller)).status, 400, 'a changed rate needs a reason')
    const changed = await mark(stayId, 'charges', { serviceId: service, qty: 1, rate: 250, rateNote: 'package rate agreed' }, biller)
    assert.equal(changed.status, 201, JSON.stringify(changed.body))
    const oxygen = await mark(stayId, 'charges', { description: 'Oxygen cylinder', rate: 800, qty: 1 }, biller)
    assert.equal(oxygen.status, 201)
    const line = oxygen.body.lines.find((l: any) => l.description === 'Oxygen cylinder')
    assert.equal(line.source, 'custom')

    assert.equal((await mark(stayId, `charges/${line.id}/void`, { reason: 'x' }, biller)).status, 400, 'a reason is needed')
    const voided = await mark(stayId, `charges/${line.id}/void`, { reason: 'Entered on the wrong patient' }, biller)
    assert.equal(voided.status, 200, JSON.stringify(voided.body))
    const kept = voided.body.lines.find((l: any) => l.id === line.id)
    assert.deepEqual([kept.voided, kept.voidReason], [true, 'Entered on the wrong patient'])
    assert.equal(voided.body.lines.filter((l: any) => !l.voided).length, 3, 'bed day, 2 x nebulisation, 1 x nebulisation at 250')
    assert.equal(voided.body.subtotal, 2000 + 600 + 250, 'the voided line is not in the total')
    assert.equal((await mark(stayId, `charges/${line.id}/void`, { reason: 'again please' }, biller)).status, 409)
    assert.equal((await mark(stayId, `charges/${line.id}/void`, { reason: 'ward trying' }, await t.as('nurse'))).status, 403)
  })

  it('prices stays under a panel and re-rates the charges when the category changes', async () => {
    const panel = (await t.post(`${api}/panels`, { code: 'CGHS', name: 'CGHS', discountPct: 0 })).body.id
    await t.call('PUT', `${api}/masters/panels/${panel}/item-rates`, { rates: [{ kind: 'service', itemId: wardService, rate: 1500 }, { kind: 'service', itemId: service, rate: 200 }] })
    const biller = await t.as('biller')
    const put = (body: unknown) => biller.call('PUT', `${api}/ipd-billing/${stayId}/billing`, body)

    assert.equal((await put({ panelId: panel })).status, 400, 'CGHS needs the beneficiary number')
    const set = await put({ panelId: panel, beneficiaryId: 'CGHS-5521', reprice: true })
    assert.equal(set.status, 200, JSON.stringify(set.body))
    assert.deepEqual([set.body.panel.code, set.body.beneficiaryId], ['CGHS', 'CGHS-5521'])
    const rates = Object.fromEntries(set.body.lines.filter((l: any) => !l.voided).map((l: any) => [l.description + l.qty, l.rate]))
    assert.equal(rates['Bed charge: Ward A1'], 1500, 'the bed charge is the panel\'s rate')
    assert.equal(rates['Nebulisation2'], 200, 'a service is re-rated')
    assert.equal(rates['Nebulisation1'], 250, 'a rate the counter changed on purpose is left alone')
    const standard = set.body.lines.find((l: any) => l.description === 'Bed charge: Ward A')
    assert.equal(standard.standardRate, 1500 >= 0 ? 2000 : 0, 'the standard price stays on record')

    const back = await put({ panelId: null, reprice: true })
    assert.equal(back.body.panel, null)
    assert.equal(back.body.lines.find((l: any) => l.description === 'Bed charge: Ward A').rate, 2000)
  })

  it('takes advances with receipts, and only gives back what is held', async () => {
    const frontDesk = await t.as('front_office')
    const biller = await t.as('biller')
    const upiNoRef = await mark(stayId, 'advances', { amount: 3000, mode: 'upi' }, frontDesk)
    assert.equal(upiNoRef.status, 400, 'UPI needs the transaction id')
    const first = await mark(stayId, 'advances', { amount: 3000, mode: 'upi', reference: 'UPI-8841-2211' }, frontDesk)
    assert.equal(first.status, 201, JSON.stringify(first.body))
    assert.match(first.body.receipt.receiptNo, /^ADV-\d+$/)
    const second = await mark(stayId, 'advances', { amount: 1000, mode: 'cash' }, frontDesk)
    assert.equal(second.body.bill.advancesHeld, 4000)

    assert.equal((await mark(stayId, 'refunds', { amount: 5000, mode: 'cash', reason: 'part refund' }, biller)).status, 400, 'more than held')
    assert.equal((await mark(stayId, 'refunds', { amount: 500, mode: 'cash', reason: 'part refund' }, frontDesk)).status, 403, 'the front desk cannot refund')
    const refund = await mark(stayId, 'refunds', { amount: 500, mode: 'cash', reason: 'Patient asked for part back' }, biller)
    assert.match(refund.body.receipt.receiptNo, /^RF-\d+$/)
    assert.equal(refund.body.bill.advancesHeld, 3500)

    assert.equal((await mark(stayId, `payments/${second.body.receipt.id}/cancel`, { reason: 'wrong patient' }, frontDesk)).status, 403)
    const cancelled = await mark(stayId, `payments/${second.body.receipt.id}/cancel`, { reason: 'Entered against the wrong patient' }, biller)
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body))
    assert.equal(cancelled.body.advancesHeld, 2500)
    assert.ok(cancelled.body.payments.find((p: any) => p.id === second.body.receipt.id).cancelled, 'it stays on record, marked cancelled')
    assert.equal((await mark(stayId, `payments/${second.body.receipt.id}/cancel`, { reason: 'again please' }, biller)).status, 409)
  })

  it('makes the final bill only after discharge, with a discount that keeps the GST right', async () => {
    const biller = await t.as('biller')
    assert.equal((await mark(stayId, 'final-bill', {}, biller)).status, 409, 'not while the patient is admitted')
    assert.equal((await t.post(`${api}/encounters/${stayId}/discharge`, { summary: 'Recovered.' })).status, 200)
    assert.ok((await bill(stayId)).bill, 'discharge raised the draft bill')

    const prepared = await mark(stayId, 'final-bill', { discount: { type: 'percent', value: 10, reason: 'Staff family' } }, biller)
    assert.equal(prepared.status, 201, JSON.stringify(prepared.body))
    const b = prepared.body
    assert.equal(b.status, 'draft')
    const base = b.items.filter((i: any) => !i.isDiscount)
    assert.equal(base.length, 3, 'the bed day and the two nebulisation lines; the voided oxygen is not on the bill')
    assert.equal(b.subtotal, 2850 - 285, 'the taxable value is after the 10% discount')
    assert.equal(b.discountAmount, 285)
    const discounts = b.items.filter((i: any) => i.isDiscount)
    assert.deepEqual(discounts.map((d: any) => [d.rate, d.gstPct]).sort(), [[-200, 5], [-85, 0]], 'shared across the GST rates in proportion')
    assert.equal(b.total, 2655, '2850 + 100 GST - 285 discount - 10 GST on it')
    assert.equal(b.advancesHeld, 2500)
    assert.equal(b.balance, 155)

    assert.equal((await t.as('nurse').then((n) => n.post(`${api}/bills/${b.id}/discount`, { type: 'amount', value: 50, reason: 'nope' }))).status, 403)
    assert.equal((await biller.post(`${api}/bills/${b.id}/discount`, { type: 'amount', value: 99999, reason: 'too much' })).status, 400, 'more than the bill')
    const cleared = await biller.post(`${api}/bills/${b.id}/discount`, { clear: true })
    assert.deepEqual([cleared.body.items.some((i: any) => i.isDiscount), cleared.body.total], [false, 2950])
    const again = await biller.post(`${api}/bills/${b.id}/discount`, { type: 'percent', value: 10, reason: 'Staff family' })
    assert.equal(again.body.total, 2655)
  })

  it('takes late charges until the bill is finalized, then locks', async () => {
    const biller = await t.as('biller')
    assert.equal((await mark(stayId, 'charges', { serviceId: service, qty: 1 }, await t.as('nurse'))).status, 409, 'the ward cannot add to a discharged patient')
    const late = await mark(stayId, 'charges', { description: 'Discharge medicines pack', rate: 100, qty: 1 }, biller)
    assert.equal(late.status, 201, JSON.stringify(late.body))
    const refreshed = (await mark(stayId, 'final-bill', {}, biller)).body
    assert.ok(refreshed.items.some((i: any) => i.label.startsWith('Discharge medicines pack')), 'the draft picks it up')
    assert.equal(refreshed.items.filter((i: any) => i.isDiscount).length, 2, 'and keeps the discount, recalculated')
    assert.equal(refreshed.subtotal, 2950 - 295, '2850 + 100, less the discount')
    assert.equal(refreshed.discountAmount, 295)
    assert.equal(refreshed.total, 2745, '3050 with GST, less 295 and the 10 of GST on the part of it at 5%')
    assert.equal(refreshed.balance, 245, 'after the 2500 of advances')
  })

  it('finalizes, takes the balance as one settlement receipt, and then cannot change', async () => {
    const biller = await t.as('biller')
    const billId = (await bill(stayId)).bill.id
    assert.equal((await biller.post(`${api}/bills/${billId}/pay`, { paymentMode: 'cash' })).status, 409, 'a draft cannot be paid')
    const finalized = await biller.post(`${api}/bills/${billId}/finalize`)
    assert.equal(finalized.status, 200, JSON.stringify(finalized.body))
    assert.equal(finalized.body.status, 'finalized')

    assert.equal((await mark(stayId, 'charges', { description: 'Too late', rate: 5, qty: 1 }, biller)).status, 409, 'locked once finalized')
    assert.equal((await biller.post(`${api}/bills/${billId}/discount`, { clear: true })).status, 409)

    assert.equal((await biller.post(`${api}/bills/${billId}/pay`, { paymentMode: 'upi' })).status, 400, 'UPI needs a transaction id')
    assert.equal((await biller.post(`${api}/bills/${billId}/pay`, { paymentMode: 'cash', amountReceived: 100 })).status, 400, 'cash received is less than due')
    const paid = await biller.post(`${api}/bills/${billId}/pay`, { paymentMode: 'cash', amountReceived: 300 })
    assert.equal(paid.status, 200, JSON.stringify(paid.body))
    assert.equal(paid.body.status, 'paid')
    assert.equal(paid.body.balance, 0)
    assert.equal(paid.body.settlement.length, 1)
    assert.deepEqual([paid.body.settlement[0].kind, paid.body.settlement[0].amount], ['settlement', 245])
    assert.match(paid.body.settlement[0].receiptNo, /^IPD-\d+$/)
    assert.equal((await biller.post(`${api}/bills/${billId}/pay`, { paymentMode: 'cash' })).status, 409, 'paid once')
    assert.equal((await mark(stayId, `payments/${(await bill(stayId)).payments[0].id}/cancel`, { reason: 'too late now' }, biller)).status, 409, 'advances cannot be cancelled after the bill is paid')
  })

  it('gives back the difference when the advances were more than the bill', async () => {
    const biller = await t.as('biller')
    const bedC = (await t.post(`${api}/beds`, { ward: 'Ward A', bedNo: 'A-03' })).body.id
    const { stayId: id } = await admit('Over Advance', bedC)
    await mark(id, 'advances', { amount: 5000, mode: 'cash' })
    assert.equal((await t.post(`${api}/encounters/${id}/discharge`, { summary: 'Fine.' })).status, 200)
    const final = (await mark(id, 'final-bill', {}, biller)).body
    assert.equal(final.total, 2100)
    assert.equal(final.balance, -2900, 'the hospital owes the patient')
    await biller.post(`${api}/bills/${final.id}/finalize`)
    const paid = (await biller.post(`${api}/bills/${final.id}/pay`, { paymentMode: 'cash' })).body
    assert.deepEqual([paid.settlement[0].kind, paid.settlement[0].amount], ['refund', 2900])
    assert.match(paid.settlement[0].receiptNo, /^RF-\d+$/)
  })

  it('settles with no money moving when the advances exactly cover the bill', async () => {
    const biller = await t.as('biller')
    const bedD = (await t.post(`${api}/beds`, { ward: 'Ward A', bedNo: 'A-04' })).body.id
    const { stayId: id } = await admit('Exact', bedD)
    await mark(id, 'advances', { amount: 2100, mode: 'cash' })
    await t.post(`${api}/encounters/${id}/discharge`, { summary: 'Fine.' })
    const final = (await mark(id, 'final-bill', {}, biller)).body
    await biller.post(`${api}/bills/${final.id}/finalize`)
    const paid = (await biller.post(`${api}/bills/${final.id}/pay`, { paymentMode: 'cash' })).body
    assert.deepEqual([paid.status, paid.settlement.length], ['paid', 0])
  })

  it('lists admissions with their advance and bill status, and refuses a visit that is not an admission', async () => {
    const list = (await (await t.as('front_office')).get(`${api}/ipd-billing?status=all`)).body as { patientName: string; advancesHeld: number; billStatus: string | null; ward: string | null }[]
    const running = list.find((r) => r.patientName === 'Running Bill')
    assert.ok(!running, 'a paid-up stay is not in the list')
    assert.ok(list.some((r) => r.patientName === 'Long Stay' && r.ward === 'Ward A'), 'a patient still in is')
    const opd = (await t.post(`${api}/encounters/opd`, { patientId: patientId, department: 'General Medicine', doctorId })).body.id
    assert.equal((await t.get(`${api}/ipd-billing/${opd}`)).status, 400)
    assert.equal((await (await t.as('housekeeping')).get(`${api}/ipd-billing`)).status, 403)
  })
})

describe('Reserved beds', () => {
  let t: TestApi
  let doctorId: string
  let bedA: string
  let bedB: string
  before(async () => {
    t = await startTestApi()
    ;({ doctorId, bedA, bedB } = await seedBasics(t))
  })
  after(() => t.close())

  const admit = (patientId: string, bedId: string) => t.post(`${api}/encounters/ipd`, { patientId, department: 'Medicine', doctorId, bedId })

  it('keeps a vacant bed for the patient who is coming, and only for them', async () => {
    const expected = await newPatient(t, { name: 'Expected Patient' })
    const walkIn = await newPatient(t, { name: 'Walk In' })
    const reserved = await t.post(`${api}/beds/${bedA}/reserve`, { patientId: expected.id, note: 'Planned surgery' })
    assert.equal(reserved.status, 200, JSON.stringify(reserved.body))
    assert.deepEqual([reserved.body.status, reserved.body.reservedFor], ['reserved', 'Expected Patient'])

    const refused = await admit(walkIn.id, bedA)
    assert.equal(refused.status, 409)
    assert.match(refused.body.error.message, /reserved for Expected Patient/)
    assert.equal((await t.post(`${api}/beds/${bedA}/reserve`, { reservedFor: 'Someone else' })).status, 409, 'a reserved bed cannot be reserved again')

    const taken = await admit(expected.id, bedA)
    assert.equal(taken.status, 201, JSON.stringify(taken.body))
    const bed = (await t.get(`${api}/beds`)).body.find((b: any) => b.id === bedA)
    assert.deepEqual([bed.status, bed.reservedFor], ['occupied', null], 'the reservation is used up')
  })

  it('can be given up, and only a vacant bed can be reserved', async () => {
    const reserved = await t.post(`${api}/beds/${bedB}/reserve`, { reservedFor: 'Mrs Rao (surgery Friday)' })
    assert.equal(reserved.body.reservedFor, 'Mrs Rao (surgery Friday)')
    const cleared = await t.post(`${api}/beds/${bedB}/clear-reservation`)
    assert.equal(cleared.body.status, 'vacant')
    assert.equal((await t.post(`${api}/beds/${bedB}/clear-reservation`)).status, 409, 'nothing to clear')
    assert.equal((await t.post(`${api}/beds/${bedA}/reserve`, { reservedFor: 'Anyone' })).status, 409, 'an occupied bed cannot be reserved')
    assert.equal((await t.post(`${api}/beds/${bedB}/reserve`, {})).status, 400, 'say who it is for')
    assert.equal((await (await t.as('biller')).post(`${api}/beds/${bedB}/reserve`, { reservedFor: 'X Y' })).status, 403)
  })

  it('does not count a reserved bed as free or occupied', async () => {
    await t.post(`${api}/beds/${bedB}/reserve`, { reservedFor: 'Mr Khan' })
    const dash = (await t.get(`${api}/dashboard`)).body
    assert.equal(dash.bedsTotal, 2)
    assert.equal(dash.bedsOccupied, 1)
  })

  it('lets a lapsed reservation be taken by anyone', async () => {
    const other = await newPatient(t, { name: 'Late Comer' })
    await t.inHospital(() => t.api.ctx.db.execute(`UPDATE "Bed" SET "reservedUntil" = now() - interval '1 hour' WHERE id = $1`, [bedB]))
    assert.equal((await admit(other.id, bedB)).status, 201)
  })
})

describe('Admission under a panel', () => {
  let t: TestApi
  let doctorId: string
  let bedA: string
  let bedB: string
  let panelId: string
  before(async () => {
    t = await startTestApi()
    ;({ doctorId, bedA, bedB } = await seedBasics(t))
    const ward = (await t.call('PUT', `${api}/masters/wards`, { ward: 'Ward A', price: 2000 })).body.id
    panelId = (await t.post(`${api}/panels`, { code: 'ECHS', name: 'ECHS', discountPct: 25 })).body.id
    await t.call('PUT', `${api}/masters/panels/${panelId}/item-rates`, { rates: [{ kind: 'service', itemId: ward, rate: 1200 }] })
  })
  after(() => t.close())

  it('needs the beneficiary number when the panel asks for one, and prices the bed day at the panel rate', async () => {
    const patient = await newPatient(t, { name: 'ECHS Patient' })
    const body = { patientId: patient.id, department: 'Medicine', doctorId, bedId: bedA, panelId }
    assert.equal((await t.post(`${api}/encounters/ipd`, body)).status, 400, 'ECHS card number needed')
    const stay = await t.post(`${api}/encounters/ipd`, { ...body, beneficiaryId: 'ECHS-4410' })
    assert.equal(stay.status, 201, JSON.stringify(stay.body))
    assert.deepEqual([stay.body.panelId, stay.body.beneficiaryId], [panelId, 'ECHS-4410'])
    const running = (await t.get(`${api}/ipd-billing/${stay.body.id}`)).body
    assert.deepEqual([running.panel.code, running.lines[0].rate, running.lines[0].standardRate], ['ECHS', 1200, 2000])
  })

  it('uses the panel\'s discount for a service it has no rate for, and refuses an unknown or switched-off panel', async () => {
    const service = (await t.post(`${api}/masters/services`, { code: 'NEB', name: 'Nebulisation', category: 'nursing', price: 400 })).body.id
    const patient = await newPatient(t, { name: 'Second ECHS' })
    const stay = (await t.post(`${api}/encounters/ipd`, { patientId: patient.id, department: 'Medicine', doctorId, bedId: bedB, panelId, beneficiaryId: 'ECHS-7' })).body.id
    const added = await t.post(`${api}/ipd-billing/${stay}/charges`, { serviceId: service, qty: 1 })
    assert.equal(added.body.lines.find((l: any) => l.description === 'Nebulisation').rate, 300, '25% off the standard 400')

    const other = await newPatient(t, { name: 'No Such Panel' })
    const bedC = (await t.post(`${api}/beds`, { ward: 'Ward A', bedNo: 'A-07' })).body.id
    assert.equal((await t.post(`${api}/encounters/ipd`, { patientId: other.id, department: 'Medicine', doctorId, bedId: bedC, panelId: '00000000-0000-4000-8000-000000000000' })).status, 400)
    await t.call('PATCH', `${api}/panels/${panelId}`, { active: false })
    assert.equal((await t.post(`${api}/encounters/ipd`, { patientId: other.id, department: 'Medicine', doctorId, bedId: bedC, panelId, beneficiaryId: 'X-1' })).status, 400, 'a switched-off panel is not offered')
  })
})
