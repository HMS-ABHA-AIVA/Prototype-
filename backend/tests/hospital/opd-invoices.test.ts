import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { panelRate, priceConsultations, type PanelPricing } from '../../src/hospital/modules/opd-billing/opd-pricing.js'
import { newPatient, seedBasics, startTestApi, type TestApi, stopServer } from './helpers.js'

// One application per test file, shared by its describe blocks: stop it when they are all done.
after(stopServer)

const api = '/api/v1'

describe('panel rates and discounts (the pricing rules)', () => {
  const panel = (change: Partial<PanelPricing> = {}): PanelPricing => ({ id: 'p', code: 'CGHS', name: 'CGHS', discountPct: 0, flatFee: null, rates: {}, ...change })

  it('charges a panel\'s rate for the department, else its flat fee, else the standard fee less its discount', () => {
    assert.equal(panelRate(panel({ rates: { orthopedics: 400 }, flatFee: 350, discountPct: 20 }), 'Orthopedics', 800), 400, 'the department rate wins')
    assert.equal(panelRate(panel({ rates: { orthopedics: 400 }, flatFee: 350, discountPct: 20 }), 'ENT', 800), 350, 'then the flat fee')
    assert.equal(panelRate(panel({ discountPct: 20 }), 'ENT', 800), 640, 'then the standard fee less the discount')
    assert.equal(panelRate(panel(), 'ENT', 800), 800, 'a panel with nothing set charges the standard fee')
  })

  it('shares a discount across the consultations so the shares add up exactly', () => {
    const items = [
      { department: 'A', doctorName: 'Dr. A', standardFee: 333.33 },
      { department: 'B', doctorName: 'Dr. B', standardFee: 333.33 },
      { department: 'C', doctorName: 'Dr. C', standardFee: 333.34 },
    ]
    const priced = priceConsultations(items, null, { type: 'percent', value: 10, reason: 'staff' })
    assert.equal(priced.gross, 1000)
    assert.equal(priced.discount, 100)
    assert.equal(priced.net, 900)
    assert.equal(Math.round(priced.consultations.reduce((s, c) => s + c.discount, 0) * 100), 10000, 'the shares add up to the whole discount')
    assert.equal(Math.round(priced.consultations.reduce((s, c) => s + c.net, 0) * 100), 90000)
    assert.match(priced.consultations[0]!.discountLabel!, /Discount \(10%\): staff/)
  })

  it('refuses a discount that is zero, over 100%, or more than the amount', () => {
    const one = [{ department: 'A', doctorName: 'Dr. A', standardFee: 600 }]
    assert.throws(() => priceConsultations(one, null, { type: 'percent', value: 0 }), /more than zero/)
    assert.throws(() => priceConsultations(one, null, { type: 'percent', value: 101 }), /100%/)
    assert.throws(() => priceConsultations(one, null, { type: 'amount', value: 700 }), /more than the amount/)
    assert.equal(priceConsultations(one, null, { type: 'percent', value: 100 }).net, 0, 'a full waiver is allowed')
  })

  it('labels panel consultations with the panel', () => {
    const priced = priceConsultations([{ department: 'ENT', doctorName: 'Dr. E', standardFee: 600 }], panel({ flatFee: 350 }), null)
    assert.equal(priced.consultations[0]!.label, 'OPD Consultation Fee (CGHS): Dr. E (ENT)')
    assert.equal(priced.consultations[0]!.rate, 350)
  })
})

describe('OPD invoices: panels, discounts, lookup and refunds', () => {
  let t: TestApi
  let general: string
  let ortho: string
  let cghs: string
  let dghs: string
  let echs: string
  before(async () => {
    t = await startTestApi()
    ;({ doctorId: general } = await seedBasics(t)) // Dr. Test, General Medicine, standard fee 600
    ortho = (await t.post(`${api}/staff`, { name: 'Dr. Bones', role: 'doctor', department: 'Orthopedics', consultationFee: 900 })).body.id
    cghs = (await t.post(`${api}/panels`, { code: 'cghs', name: 'Central Government Health Scheme', category: 'government', flatFee: 350 })).body.id
    dghs = (await t.post(`${api}/panels`, { code: 'DGHS', name: 'DGHS', category: 'government', discountPct: 20 })).body.id
    echs = (await t.post(`${api}/panels`, { code: 'ECHS', name: 'ECHS', category: 'government', requiresBeneficiaryId: false })).body.id
    await t.call('PUT', `${api}/panels/${echs}/rates`, { rates: [{ department: 'Orthopedics', fee: 400 }] })
  })
  after(() => t.close())

  const GEN = 'General Medicine'
  const both = () => [{ department: GEN, doctorId: general }, { department: 'Orthopedics', doctorId: ortho }]
  const cash = { paymentMode: 'cash' }

  const invoice = async (as: TestApi, patientId: string, extra: Record<string, unknown> = {}, consultations = both()) =>
    as.post(`${api}/opd-billing/invoices`, { patientId, consultations, ...cash, ...extra })
  const awaitingFor = async (patientId: string) => ((await t.get(`${api}/opd-billing`)).body as { patientId: string; billId: string }[]).filter((a) => a.patientId === patientId)
  const visitsOf = async (patientId: string) => ((await t.get(`${api}/encounters?patientId=${patientId}&type=OPD&limit=50`)).body as { department: string; status: string; tokenNo: number | null }[])

  describe('panels', () => {
    it('are set up by administrators; the billing staff see the active ones', async () => {
      const list = (await (await t.as('biller')).get(`${api}/panels`)).body as { code: string; hasSpecialRates: boolean; rates: { department: string; fee: number }[]; flatFee: number | null }[]
      assert.deepEqual(list.map((p) => p.code).sort(), ['CGHS', 'DGHS', 'ECHS'], 'the code is kept in capitals')
      assert.equal(list.find((p) => p.code === 'CGHS')!.flatFee, 350)
      assert.deepEqual(list.find((p) => p.code === 'ECHS')!.rates, [{ department: 'Orthopedics', fee: 400 }])

      assert.equal((await (await t.as('biller')).post(`${api}/panels`, { code: 'XYZ', name: 'X' })).status, 403)
      assert.equal((await (await t.as('housekeeping')).get(`${api}/panels`)).status, 403)
      assert.equal((await (await t.as('doctor')).get(`${api}/panels`)).status, 200, 'an admitting doctor picks the billing category')
      assert.equal((await t.post(`${api}/panels`, { code: 'CGHS', name: 'Again' })).status, 409, 'a code is used once')
      assert.equal((await t.post(`${api}/panels`, { code: 'BAD CODE!', name: 'X' })).status, 400)
    })

    it('can be switched off (hidden from billing), and say when no special rate has been entered', async () => {
      const blank = (await t.post(`${api}/panels`, { code: 'NEWCO', name: 'New company' })).body
      assert.equal(blank.hasSpecialRates, false, 'nothing entered yet: billing would charge the standard fee')
      await t.call('PATCH', `${api}/panels/${blank.id}`, { active: false })
      const biller = await t.as('biller')
      assert.ok(!(await biller.get(`${api}/panels`)).body.some((p: any) => p.code === 'NEWCO'))
      assert.ok((await t.get(`${api}/panels?all=true`)).body.some((p: any) => p.code === 'NEWCO'), 'administrators can still see it')
      assert.equal((await biller.get(`${api}/panels?all=true`)).body.some((p: any) => p.code === 'NEWCO'), false, 'only administrators see inactive panels')

      const blocked = await t.post(`${api}/opd-billing/quote`, { consultations: [{ department: GEN, doctorId: general }], panelId: blank.id })
      assert.equal(blocked.status, 400)
    })
  })

  describe('the quote', () => {
    it('prices the doctors at the standard fee, or at a panel\'s rates, with a discount, without saving anything', async () => {
      const quote = async (body: Record<string, unknown>) => (await t.post(`${api}/opd-billing/quote`, { consultations: both(), ...body })).body
      const standard = await quote({})
      assert.equal(standard.gross, 1500)
      assert.equal(standard.net, 1500)
      assert.equal(standard.panel, null)
      assert.deepEqual(standard.consultations.map((c: any) => c.rate), [600, 900])

      const central = await quote({ panelId: cghs })
      assert.equal(central.gross, 700, 'CGHS: a flat fee for each doctor')
      assert.equal(central.panel.code, 'CGHS')
      assert.equal(central.panel.requiresBeneficiaryId, true)
      assert.match(central.consultations[0].label, /\(CGHS\)/)

      assert.equal((await quote({ panelId: dghs })).gross, 1200, 'DGHS: 20% off each standard fee (480 + 720)')
      assert.equal((await quote({ panelId: echs })).gross, 1000, 'ECHS: its Orthopedics rate (400) and the standard fee for the rest (600)')

      const discounted = await quote({ discount: { type: 'percent', value: 10 } })
      assert.deepEqual([discounted.gross, discounted.discount, discounted.net], [1500, 150, 1350])
      const both2 = await quote({ panelId: cghs, discount: { type: 'amount', value: 100 } })
      assert.deepEqual([both2.gross, both2.discount, both2.net], [700, 100, 600], 'a panel rate and a discount together')

      assert.equal((await t.post(`${api}/opd-billing/quote`, { consultations: both(), discount: { type: 'amount', value: 5000 } })).status, 400)
      assert.equal((await t.post(`${api}/opd-billing/quote`, { consultations: [] })).status, 400)
      assert.equal((await t.get(`${api}/opd-billing/invoices`)).body.invoices.length, 0, 'a quote saves nothing')
    })
  })

  describe('billing in one step', () => {
    it('registers the patient for the doctors, prices them at a panel\'s rates, takes payment, and issues tokens and slips', async () => {
      const patient = await newPatient(t, { name: 'Panel Patient', age: 61, gender: 'M' })
      const biller = await t.as('biller')
      const r = await invoice(biller, patient.id, { panelId: cghs, beneficiaryId: 'CGHS-77120045' })
      assert.equal(r.status, 201, JSON.stringify(r.body))
      const inv = r.body.invoice
      assert.match(inv.invoiceNo, /^OPD-\d+$/)
      assert.equal(inv.status, 'paid')
      assert.equal(inv.panelCode, 'CGHS')
      assert.equal(inv.beneficiaryId, 'CGHS-77120045')
      assert.deepEqual([inv.grossAmount, inv.discountAmount, inv.amount], [700, 0, 700])
      assert.equal(inv.slips.length, 2)
      assert.deepEqual(inv.slips.map((s: any) => s.fee), [350, 350])
      assert.ok(inv.slips.every((s: any) => s.tokenNo >= 1))
      assert.deepEqual(inv.lines.map((l: any) => l.amount), [350, 350])
      assert.deepEqual((await visitsOf(patient.id)).map((v) => v.status), ['waiting', 'waiting'], 'in both doctors\' queues')
      assert.equal((await awaitingFor(patient.id)).length, 0)
    })

    it('needs the panel\'s beneficiary number when the panel asks for it, and creates nothing if refused', async () => {
      const patient = await newPatient(t, { name: 'No Card Number' })
      const refused = await invoice(await t.as('biller'), patient.id, { panelId: cghs })
      assert.equal(refused.status, 400)
      assert.match(refused.body.error.message, /CGHS beneficiary/)
      assert.equal((await visitsOf(patient.id)).length, 0, 'no visits were left behind')
      assert.equal((await invoice(await t.as('biller'), patient.id, { panelId: echs })).status, 201, 'ECHS here does not need a number')
    })

    it('still checks the payment: a reference for UPI, enough cash, and no second invoice for an open visit', async () => {
      const patient = await newPatient(t, { name: 'Payment Checks' })
      const biller = await t.as('biller')
      assert.equal((await invoice(biller, patient.id, { paymentMode: 'upi' })).status, 400)
      assert.equal((await invoice(biller, patient.id, { amountReceived: 10 })).status, 400)
      assert.equal((await visitsOf(patient.id)).length, 0)
      assert.equal((await invoice(biller, patient.id, { paymentMode: 'upi', reference: 'UPI-5521' })).status, 201)
      const again = await invoice(biller, patient.id)
      assert.equal(again.status, 409, 'the patient already has these doctors open')
    })
  })

  describe('discounts', () => {
    it('are given by the billing counter or an administrator, with a reason, and are shown as their own line', async () => {
      const patient = await newPatient(t, { name: 'Gets A Discount' })
      const biller = await t.as('biller')
      assert.equal((await invoice(biller, patient.id, { discount: { type: 'percent', value: 10 } })).status, 400, 'a reason is needed')
      assert.equal((await invoice(biller, patient.id, { discount: { type: 'percent', value: 10, reason: 'ok' } })).status, 400, 'a real reason')
      assert.equal((await visitsOf(patient.id)).length, 0)

      const r = await invoice(biller, patient.id, { discount: { type: 'percent', value: 10, reason: 'Hospital staff family' } })
      assert.equal(r.status, 201, JSON.stringify(r.body))
      const inv = r.body.invoice
      assert.deepEqual([inv.grossAmount, inv.discountAmount, inv.amount], [1500, 150, 1350])
      assert.equal(inv.discountType, 'percent')
      assert.equal(inv.discountValue, 10)
      assert.equal(inv.discountReason, 'Hospital staff family')
      assert.equal(inv.lines.filter((l: any) => l.amount < 0).length, 2, 'a discount line under each doctor')
      assert.match(inv.lines.find((l: any) => l.amount < 0).label, /Discount \(10%\): Hospital staff family/)
      assert.equal(Math.round(inv.lines.reduce((s: number, l: any) => s + l.amount, 0) * 100), 135000, 'the lines add up to the amount paid')
      assert.equal(Math.round(inv.slips.reduce((s: number, x: any) => s + x.fee, 0) * 100), 135000, 'and so do the slips')
      const log = (await t.get(`${api}/audit-log?limit=10`)).body as { action: string; detail: string }[]
      assert.ok(log.some((l) => l.action === 'OPD Payment Received' && /discount Rs 150\.00 \(Hospital staff family\)/.test(l.detail)))
    })

    it('are not for the front desk, and cannot exceed the amount', async () => {
      const patient = await newPatient(t, { name: 'Front Desk Discount' })
      const front = await t.as('front_office')
      const denied = await invoice(front, patient.id, { discount: { type: 'amount', value: 100, reason: 'asked nicely' } })
      assert.equal(denied.status, 403)
      assert.equal((await visitsOf(patient.id)).length, 0)
      assert.equal((await invoice(front, patient.id)).status, 201, 'the front desk can still bill at the standard or panel rate')

      const other = await newPatient(t, { name: 'Too Big A Discount' })
      assert.equal((await invoice(t, other.id, { discount: { type: 'amount', value: 99999, reason: 'mistake' } })).status, 400)
      const admin = await invoice(t, other.id, { discount: { type: 'amount', value: 100, reason: 'Senior citizen' } }, [{ department: GEN, doctorId: general }])
      assert.equal(admin.status, 201, 'administrators may')
      assert.equal(admin.body.invoice.amount, 500)
    })

    it('apply to fees already registered by the front desk, repricing them at the panel\'s rate', async () => {
      const patient = await newPatient(t, { name: 'Registered First' })
      assert.equal((await (await t.as('front_office')).post(`${api}/opd-billing/visits`, { patientId: patient.id, consultations: both() })).status, 201)
      const fees = await awaitingFor(patient.id)
      const ids = fees.map((f) => f.billId)

      const preview = (await t.post(`${api}/opd-billing/quote`, { billIds: ids, panelId: dghs, discount: { type: 'amount', value: 100 } })).body
      assert.deepEqual([preview.gross, preview.discount, preview.net], [1200, 100, 1100])

      const paid = await (await t.as('biller')).post(`${api}/opd-billing/collect`, { billIds: ids, ...cash, panelId: dghs, beneficiaryId: 'DG-1', discount: { type: 'amount', value: 100, reason: 'Referred by the director' } })
      assert.equal(paid.status, 200, JSON.stringify(paid.body))
      assert.deepEqual([paid.body.invoice.grossAmount, paid.body.invoice.discountAmount, paid.body.invoice.amount], [1200, 100, 1100])
      assert.equal(paid.body.invoice.panelCode, 'DGHS')
      assert.deepEqual(paid.body.encounters.map((e: any) => e.status), ['waiting', 'waiting'])
    })
  })

  describe('looking invoices up', () => {
    it('finds them by invoice number, patient name or MRN, filters by status, and totals what is listed', async () => {
      const list = async (query = '') => (await t.get(`${api}/opd-billing/invoices${query}`)).body
      const all = await list()
      assert.ok(all.invoices.length >= 6)
      const target = all.invoices.find((i: any) => i.patientName === 'Gets A Discount')

      assert.deepEqual((await list(`?search=${target.invoiceNo}`)).invoices.map((i: any) => i.id), [target.id])
      assert.deepEqual((await list('?search=gets%20a%20disc')).invoices.map((i: any) => i.id), [target.id])
      assert.deepEqual((await list(`?search=${target.mrn}`)).invoices.map((i: any) => i.id), [target.id])
      assert.equal((await list('?search=nobody-by-this-name')).invoices.length, 0)
      assert.equal((await list('?status=cancelled')).invoices.length, 0)
      assert.equal((await list('?limit=2')).invoices.length, 2)

      const one = (await t.get(`${api}/opd-billing/invoices/${target.id}`)).body
      assert.equal(one.invoiceNo, target.invoiceNo)
      assert.equal(one.slips.length, 2)
      assert.equal((await t.get(`${api}/opd-billing/invoices/00000000-0000-4000-8000-000000000000`)).status, 404)

      assert.equal(Math.round(all.totals.collected * 100), Math.round(all.invoices.reduce((s: number, i: any) => s + i.amount, 0) * 100))
      assert.ok(all.totals.discounts >= 150 + 100)
      assert.equal(all.totals.net, all.totals.collected - all.totals.refunded)
    })
  })

  describe('cancelling an invoice with a refund', () => {
    const cancel = (as: TestApi, id: string, body: Record<string, unknown>) => as.post(`${api}/opd-billing/invoices/${id}/cancel`, body)

    it('is for the billing counter and administrators, and needs a reason', async () => {
      const patient = await newPatient(t, { name: 'Wants A Refund' })
      const made = (await invoice(await t.as('biller'), patient.id)).body.invoice
      for (const role of ['front_office', 'doctor', 'nurse']) {
        assert.equal((await cancel(await t.as(role), made.id, { reason: 'Changed mind' })).status, 403, `${role} cannot cancel invoices`)
      }
      assert.equal((await cancel(await t.as('biller'), made.id, { reason: 'x' })).status, 400, 'a real reason is needed')
      assert.equal((await cancel(await t.as('biller'), made.id, {})).status, 400)
      assert.equal((await t.get(`${api}/opd-billing/invoices/${made.id}`)).body.status, 'paid', 'nothing changed')
    })

    it('refunds in full by default: the invoice is cancelled, its bills voided, its visits cancelled, and the day\'s totals show the refund', async () => {
      const patient = await newPatient(t, { name: 'Full Refund' })
      const made = (await invoice(await t.as('biller'), patient.id, { paymentMode: 'upi', reference: 'UPI-9001' })).body.invoice
      const before = (await t.get(`${api}/opd-billing/invoices`)).body.totals

      const done = await cancel(await t.as('biller'), made.id, { reason: 'Patient left before seeing the doctor', refundReference: 'UPI-REF-77' })
      assert.equal(done.status, 200, JSON.stringify(done.body))
      const inv = done.body.invoice
      assert.equal(inv.status, 'cancelled')
      assert.equal(inv.refundAmount, 1500)
      assert.equal(inv.refundMode, 'upi', 'refunded the way it was paid, unless said otherwise')
      assert.equal(inv.refundReference, 'UPI-REF-77')
      assert.equal(inv.cancelReason, 'Patient left before seeing the doctor')
      assert.equal(inv.cancelledByName, 'Test biller')
      assert.ok(inv.cancelledAt)

      assert.deepEqual((await visitsOf(patient.id)).map((v) => v.status), ['cancelled', 'cancelled'])
      const bills = ((await t.get(`${api}/bills?patientId=${patient.id}&limit=50`)).body as { status: string }[])
      assert.ok(bills.length === 2 && bills.every((b) => b.status === 'void'))

      const after = (await t.get(`${api}/opd-billing/invoices`)).body.totals
      assert.equal(after.refunded, before.refunded + 1500)
      assert.equal(after.net, before.net - 1500)
      assert.equal(after.cancelledCount, before.cancelledCount + 1)
      assert.equal((await t.get(`${api}/opd-billing/invoices?status=cancelled`)).body.invoices.length, after.cancelledCount)
      const log = (await t.get(`${api}/audit-log?limit=10`)).body as { action: string; detail: string }[]
      assert.ok(log.some((l) => l.action === 'OPD Invoice Cancelled' && l.detail.includes(made.invoiceNo) && /refunded Rs 1500\.00/.test(l.detail)))

      assert.equal((await cancel(await t.as('biller'), made.id, { reason: 'Again' })).status, 409, 'cannot be cancelled twice')
      assert.equal((await invoice(await t.as('biller'), patient.id)).status, 201, 'the patient can be billed again afterwards')
    })

    it('allows a partial refund, and checks the refund details', async () => {
      const patient = await newPatient(t, { name: 'Partial Refund' })
      const made = (await invoice(t, patient.id)).body.invoice
      const biller = await t.as('biller')
      assert.equal((await cancel(biller, made.id, { reason: 'Duplicate billing', refundAmount: 1501 })).status, 400, 'more than was paid')
      assert.equal((await cancel(biller, made.id, { reason: 'Duplicate billing', refundAmount: 500, refundMode: 'card' })).status, 400, 'a card refund needs its slip number')
      const done = await cancel(biller, made.id, { reason: 'Duplicate billing, cancellation charge kept', refundAmount: 1000, refundMode: 'cash' })
      assert.equal(done.status, 200, JSON.stringify(done.body))
      assert.equal(done.body.invoice.refundAmount, 1000)
      assert.equal(done.body.invoice.refundMode, 'cash')
      assert.equal(done.body.invoice.amount, 1500, 'what was paid is unchanged')
    })

    it('is refused once a doctor has started the consultation, and then nothing changes', async () => {
      const patient = await newPatient(t, { name: 'Already Seen' })
      const made = (await invoice(await t.as('biller'), patient.id)).body.invoice
      const started = made.slips.find((s: any) => s.department === 'Orthopedics')
      assert.equal((await t.post(`${api}/encounters/${started.encounterId}/start`)).status, 200)

      const refused = await cancel(await t.as('biller'), made.id, { reason: 'Changed mind' })
      assert.equal(refused.status, 409)
      assert.match(refused.body.error.message, /Dr\. Bones/)
      assert.match(refused.body.error.message, /already started/)
      assert.equal((await t.get(`${api}/opd-billing/invoices/${made.id}`)).body.status, 'paid')
      const visits = await visitsOf(patient.id)
      assert.deepEqual(visits.map((v) => v.status).sort(), ['in_consult', 'waiting'], 'the other doctor\'s visit was not cancelled either')
    })
  })
})
