import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { flagFor, numberOf } from '../../src/hospital/modules/lab/results.js'
import { checkInOpdPaid, newPatient, seedBasics, startTestApi, type TestApi, stopServer } from './helpers.js'

// One application per test file, shared by its describe blocks: stop it when they are all done.
after(stopServer)

const api = '/api/v1'
const lab = `${api}/lab`
const masters = `${api}/masters`

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

describe('Result flags', () => {
  const hb = { refLow: 12, refHigh: 16, criticalLow: 7, criticalHigh: 20 }
  it('flags a number against the normal range and the critical limits', () => {
    assert.equal(flagFor(14, hb), 'normal')
    assert.equal(flagFor(12, hb), 'normal', 'the ends of the range are normal')
    assert.equal(flagFor(11.9, hb), 'low')
    assert.equal(flagFor(16.1, hb), 'high')
    assert.equal(flagFor(6.9, hb), 'critical_low')
    assert.equal(flagFor(20.5, hb), 'critical_high')
    assert.equal(flagFor(5, { refLow: 3, refHigh: null, criticalLow: null, criticalHigh: null }), 'normal', 'a range with one end only')
  })
  it('does not flag what has no range, unless the person says it is abnormal', () => {
    const none = { refLow: null, refHigh: null, criticalLow: null, criticalHigh: null }
    assert.equal(flagFor(5, none), null)
    assert.equal(flagFor(null, none), null)
    assert.equal(flagFor(null, none, true), 'abnormal')
    assert.equal(flagFor(14, hb, true), 'abnormal', 'a number inside the range can still be marked')
    assert.equal(flagFor(5, hb, true), 'critical_low', 'marking never hides a real flag')
  })
  it('reads a number only when the whole value is one', () => {
    assert.deepEqual([numberOf('13.5'), numberOf(' 7 '), numberOf('-2'), numberOf('<0.5'), numberOf('Nil'), numberOf('1,200')], [13.5, 7, -2, null, null, null])
  })
})

describe('Lab and radiology workflow', () => {
  let t: TestApi
  let doctorId: string
  let patientId: string
  let cbc: string
  let urine: string
  let xray: string
  let visit: string

  before(async () => {
    t = await startTestApi()
    doctorId = (await seedBasics(t)).doctorId
    patientId = (await newPatient(t, { name: 'Lab Patient', age: 40, gender: 'F' })).id
    cbc = (await t.post(`${masters}/investigations`, {
      code: 'CBC', name: 'Complete Blood Count', kind: 'lab', section: 'Haematology', sample: 'EDTA blood', tatHours: 4, price: 400,
      parameters: [
        { name: 'Haemoglobin', unit: 'g/dL', refLow: 12, refHigh: 16, criticalLow: 7, criticalHigh: 20 },
        { name: 'WBC', unit: '/cumm', refLow: 4000, refHigh: 11000 },
        { name: 'Malaria parasite', refText: 'Not seen' },
      ],
    })).body.id
    urine = (await t.post(`${masters}/investigations`, { code: 'URN', name: 'Urine Routine', kind: 'lab', section: 'Clinical pathology', price: 150, gstPct: 12 })).body.id
    xray = (await t.post(`${masters}/investigations`, { code: 'XRC', name: 'X-ray Chest', kind: 'radiology', section: 'X-ray', tatHours: 2, price: 500 })).body.id
    visit = (await checkInOpdPaid(t, { patientId, doctorId, department: 'General Medicine' })).body.id
  })
  after(() => t.close())

  const order = async (investigationId: string, type: 'lab' | 'radiology', name: string) => {
    const r = await t.post(`${api}/encounters/${visit}/orders`, { type, name, investigationId })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    return r.body.id as string
  }
  let cbcOrder: string
  let urineOrder: string
  let xrayOrder: string

  it('puts a test ordered on a visit on the worklist, for the patient', async () => {
    cbcOrder = await order(cbc, 'lab', 'Complete Blood Count')
    urineOrder = await order(urine, 'lab', 'Urine Routine')
    xrayOrder = await order(xray, 'radiology', 'X-ray Chest')
    const list = await (await t.as('lab')).get(`${lab}/orders`)
    assert.equal(list.status, 200, JSON.stringify(list.body))
    const mine = list.body.orders.filter((o: any) => o.patientName === 'Lab Patient')
    assert.equal(mine.length, 3)
    assert.deepEqual([...new Set(mine.map((o: any) => o.status))], ['ordered'])
    assert.deepEqual([mine[0].encounterType, mine[0].orderedBy], ['OPD', 'Dr. Test'])
    assert.equal(list.body.counts.ordered, 3)
    assert.equal(mine.find((o: any) => o.name === 'Complete Blood Count').section, 'Haematology')
  })

  it('lets the lab look patients up but not register or change them', async () => {
    const lb = await t.as('lab')
    assert.equal((await lb.get(`${api}/patients?search=Lab`)).status, 200)
    assert.equal((await lb.post(`${api}/patients`, { name: 'Not Allowed', age: 30, gender: 'M', phone: '9876500009' })).status, 403)
    assert.equal((await lb.call('PATCH', `${api}/patients/${patientId}`, { phone: '9876500010' })).status, 403)
  })

  it('is open to the lab, doctors, nurses and administrators only', async () => {
    assert.equal((await (await t.as('pharmacist')).get(`${lab}/orders`)).status, 403)
    assert.equal((await (await t.as('housekeeping')).get(`${lab}/orders`)).status, 403)
    assert.equal((await (await t.as('biller')).get(`${lab}/orders`)).status, 403)
    assert.equal((await (await t.as('nurse')).get(`${lab}/orders`)).status, 200)
  })

  it('cannot enter results before the sample is collected', async () => {
    const lb = await t.as('lab')
    const early = await lb.call('PUT', `${lab}/orders/${cbcOrder}/results`, { results: [{ name: 'Haemoglobin', value: '13' }] })
    assert.equal(early.status, 409)
    assert.match(early.body.error.message, /Collect the sample first/)
  })

  it('collects a sample, giving it a number (a nurse may do it, once)', async () => {
    const nurse = await t.as('nurse')
    const done = await nurse.post(`${lab}/orders/${cbcOrder}/collect`, { note: 'left arm' })
    assert.equal(done.status, 200, JSON.stringify(done.body))
    assert.equal(done.body.status, 'sample_collected')
    assert.match(done.body.accessionNo, /^LS-\d+$/)
    assert.equal(done.body.collectedBy, 'Test nurse')
    assert.equal((await nurse.post(`${lab}/orders/${cbcOrder}/collect`, {})).status, 409)
    const second = await nurse.post(`${lab}/orders/${urineOrder}/collect`, {})
    assert.notEqual(second.body.accessionNo, done.body.accessionNo)
    assert.equal((await (await t.as('doctor')).post(`${lab}/orders/${xrayOrder}/collect`, {})).body.accessionNo.slice(0, 3), 'RD-')
  })

  it('sends a bad sample back to be collected again, with the reason', async () => {
    const lb = await t.as('lab')
    assert.equal((await (await t.as('nurse')).post(`${lab}/orders/${urineOrder}/reject-sample`, { reason: 'leaked in transit' })).status, 403)
    assert.equal((await lb.post(`${lab}/orders/${urineOrder}/reject-sample`, { reason: 'x' })).status, 400)
    const rejected = await lb.post(`${lab}/orders/${urineOrder}/reject-sample`, { reason: 'leaked in transit' })
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body))
    assert.deepEqual([rejected.body.status, rejected.body.accessionNo], ['ordered', null])
    assert.match(rejected.body.sampleNote, /leaked in transit/)
    assert.equal((await lb.post(`${lab}/orders/${urineOrder}/collect`, {})).body.status, 'sample_collected')
  })

  it('shows the form from the test master, and flags what is entered', async () => {
    const lb = await t.as('lab')
    const form = (await lb.get(`${lab}/orders/${cbcOrder}`)).body.form as { parameterId: string; name: string; refLow: number | null }[]
    assert.deepEqual(form.map((f) => f.name), ['Haemoglobin', 'WBC', 'Malaria parasite'])
    const id = (name: string) => form.find((f) => f.name === name)!.parameterId

    assert.equal((await lb.call('PUT', `${lab}/orders/${cbcOrder}/results`, { results: [] })).status, 400, 'at least one value')
    assert.equal((await lb.call('PUT', `${lab}/orders/${cbcOrder}/results`, { results: [{ parameterId: '00000000-0000-4000-8000-000000000000', value: '1' }] })).status, 400, 'not one of this test\'s parameters')

    const saved = await lb.call('PUT', `${lab}/orders/${cbcOrder}/results`, {
      results: [{ parameterId: id('Haemoglobin'), value: '6.5' }, { parameterId: id('WBC'), value: '12000' }, { parameterId: id('Malaria parasite'), value: 'Not seen' }],
      remarks: 'Severe anaemia',
    })
    assert.equal(saved.status, 200, JSON.stringify(saved.body))
    assert.equal(saved.body.status, 'resulted')
    assert.equal(saved.body.critical, true)
    const flags = Object.fromEntries(saved.body.results.map((r: any) => [r.name, r.flag]))
    assert.deepEqual(flags, { Haemoglobin: 'critical_low', WBC: 'high', 'Malaria parasite': null })
    assert.equal(saved.body.results[0].unit, 'g/dL')
  })

  it('can be saved again until it is signed, and the flags follow the new values', async () => {
    const lb = await t.as('lab')
    const form = (await lb.get(`${lab}/orders/${cbcOrder}`)).body.form as { parameterId: string; name: string }[]
    const id = (name: string) => form.find((f) => f.name === name)!.parameterId
    const again = await lb.call('PUT', `${lab}/orders/${cbcOrder}/results`, {
      results: [{ parameterId: id('Haemoglobin'), value: '9.1' }, { parameterId: id('WBC'), value: '8000' }, { parameterId: id('Malaria parasite'), value: 'Seen', abnormal: true }],
    })
    assert.deepEqual(Object.fromEntries(again.body.results.map((r: any) => [r.name, r.flag])), { Haemoglobin: 'low', WBC: 'normal', 'Malaria parasite': 'abnormal' })
    assert.equal(again.body.critical, false, 'no critical value any more')
    assert.equal(again.body.results.length, 3, 'replaced, not added to')
  })

  it('does not show a doctor results until the report is signed', async () => {
    const doctor = await t.as('doctor')
    const hidden = (await doctor.get(`${lab}/orders/${cbcOrder}`)).body
    assert.deepEqual([hidden.status, hidden.results.length, hidden.form.length, hidden.remarks], ['resulted', 0, 0, null])
    assert.equal((await doctor.get(`${lab}/orders/${cbcOrder}/report`)).status, 409, 'no report yet')
    assert.ok((await doctor.get(`${lab}/orders`)).body.orders.every((o: any) => o.remarks === undefined), 'the worklist carries no report text')
  })

  it('refuses to sign while a measure is missing, then signs and releases the report', async () => {
    const lb = await t.as('lab')
    const form = (await lb.get(`${lab}/orders/${cbcOrder}`)).body.form as { parameterId: string; name: string }[]
    const id = (name: string) => form.find((f) => f.name === name)!.parameterId
    await lb.call('PUT', `${lab}/orders/${cbcOrder}/results`, { results: [{ parameterId: id('Haemoglobin'), value: '6.0' }, { parameterId: id('WBC'), value: '8000' }] })
    const refused = await lb.post(`${lab}/orders/${cbcOrder}/sign`)
    assert.equal(refused.status, 400)
    assert.match(refused.body.error.message, /Malaria parasite/)
    await lb.call('PUT', `${lab}/orders/${cbcOrder}/results`, {
      results: [{ parameterId: id('Haemoglobin'), value: '6.0' }, { parameterId: id('WBC'), value: '8000' }, { parameterId: id('Malaria parasite'), value: 'Not seen' }],
    })
    assert.equal((await (await t.as('nurse')).post(`${lab}/orders/${cbcOrder}/sign`)).status, 403, 'a nurse cannot sign')
    const signed = await lb.post(`${lab}/orders/${cbcOrder}/sign`)
    assert.equal(signed.status, 200, JSON.stringify(signed.body))
    assert.deepEqual([signed.body.status, signed.body.signedBy, signed.body.critical], ['completed', 'Test lab', true])
    assert.equal((await lb.call('PUT', `${lab}/orders/${cbcOrder}/results`, { results: [{ name: 'Haemoglobin', value: '10' }] })).status, 409, 'signed reports are not overwritten')
    assert.equal((await lb.post(`${lab}/orders/${cbcOrder}/sign`)).status, 409)
  })

  it('shows the signed report to the doctor, and asks them to acknowledge the critical value', async () => {
    const doctor = await t.as('doctor')
    const report = await doctor.get(`${lab}/orders/${cbcOrder}/report`)
    assert.equal(report.status, 200, JSON.stringify(report.body))
    assert.equal(report.body.results.find((r: any) => r.name === 'Haemoglobin').flag, 'critical_low')
    assert.equal(report.body.signer.name, 'Test lab')
    assert.equal(report.body.patientName, 'Lab Patient')

    const waiting = (await doctor.get(`${lab}/critical`)).body as { id: string }[]
    assert.deepEqual(waiting.map((w) => w.id), [cbcOrder])
    assert.equal((await doctor.get(`${api}/dashboard`)).body.criticalResults, 1)
    assert.equal((await (await t.as('nurse')).post(`${lab}/orders/${cbcOrder}/acknowledge-critical`)).status, 403)
    const ack = await doctor.post(`${lab}/orders/${cbcOrder}/acknowledge-critical`)
    assert.equal(ack.status, 200, JSON.stringify(ack.body))
    assert.equal(ack.body.criticalAckBy, 'Test doctor')
    assert.equal((await doctor.post(`${lab}/orders/${cbcOrder}/acknowledge-critical`)).status, 409)
    assert.deepEqual((await doctor.get(`${lab}/critical`)).body, [])

    const orders = (await doctor.get(`${api}/encounters/${visit}`)).body.orders as { id: string; status: string; critical: boolean; accessionNo: string }[]
    const mine = orders.find((o) => o.id === cbcOrder)!
    assert.deepEqual([mine.status, mine.critical, /^LS-/.test(mine.accessionNo)], ['completed', true, true], 'the visit shows the order\'s progress')
  })

  it('keeps a correction as an amendment, with what was there before', async () => {
    const lb = await t.as('lab')
    assert.equal((await lb.post(`${lab}/orders/${cbcOrder}/amend`, { reason: 'x' })).status, 400)
    const amended = await lb.post(`${lab}/orders/${cbcOrder}/amend`, { reason: 'Haemoglobin was keyed wrongly' })
    assert.equal(amended.status, 200, JSON.stringify(amended.body))
    assert.deepEqual([amended.body.status, amended.body.amendedCount, amended.body.signedBy], ['resulted', 1, null])
    const form = amended.body.form as { parameterId: string; name: string }[]
    await lb.call('PUT', `${lab}/orders/${cbcOrder}/results`, {
      results: [{ parameterId: form[0]!.parameterId, value: '10.4' }, { parameterId: form[1]!.parameterId, value: '8000' }, { parameterId: form[2]!.parameterId, value: 'Not seen' }],
    })
    assert.equal((await lb.post(`${lab}/orders/${cbcOrder}/sign`)).status, 200)
    const report = (await (await t.as('doctor')).get(`${lab}/orders/${cbcOrder}/report`)).body
    assert.equal(report.amendedCount, 1)
    assert.equal(report.amendments[0].reason, 'Haemoglobin was keyed wrongly')
    assert.equal(report.results.find((r: any) => r.name === 'Haemoglobin').flag, 'low')
    const kept = await t.inHospital(() => t.api.ctx.db.queryOne<{ previous: { results: { name: string; value: string }[] } }>('SELECT previous FROM "ReportAmendment" WHERE "orderId" = $1', [cbcOrder]))
    assert.equal(kept!.previous.results.find((r) => r.name === 'Haemoglobin')!.value, '6.0', 'the old value is kept')
    assert.equal(report.critical, false)
  })

  it('takes results for a test that has no list of measures', async () => {
    const lb = await t.as('lab')
    assert.deepEqual((await lb.get(`${lab}/orders/${urineOrder}`)).body.form, [])
    const saved = await lb.call('PUT', `${lab}/orders/${urineOrder}/results`, { results: [{ name: 'Protein', value: 'Nil' }, { name: 'Pus cells', value: '2-3 /hpf' }] })
    assert.equal(saved.status, 200, JSON.stringify(saved.body))
    assert.equal((await lb.call('PUT', `${lab}/orders/${urineOrder}/results`, { results: [{ name: 'Protein', value: 'Nil' }, { name: 'protein', value: 'Trace' }] })).status, 400, 'a name twice')
    assert.equal((await lb.post(`${lab}/orders/${urineOrder}/sign`)).status, 200)
  })

  it('writes and signs a radiology report, with an image attached', async () => {
    const lb = await t.as('lab')
    assert.equal((await lb.call('PUT', `${lab}/orders/${xrayOrder}/results`, { results: [{ name: 'x', value: 'y' }] })).status, 400, 'radiology has a written report')
    assert.equal((await lb.post(`${lab}/orders/${xrayOrder}/sign`)).status, 409, 'nothing to sign yet')
    const upload = (body: Buffer, query: string, token = lb.token) =>
      fetch(`${t.api.url}${lab}/orders/${xrayOrder}/attachments?${query}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${token}` }, body: new Uint8Array(body) })
    assert.equal((await upload(Buffer.from('not an image'), 'title=Fake')).status, 400)
    const up = await upload(PNG, 'title=PA%20view&fileName=chest.png')
    const att = (await up.json()) as any
    assert.equal(up.status, 201, JSON.stringify(att))
    assert.equal(att.contentType, 'image/png')

    const written = await lb.call('PUT', `${lab}/orders/${xrayOrder}/report`, { findings: 'Lungs are clear. Heart size normal.', impression: 'Normal chest radiograph' })
    assert.equal(written.status, 200, JSON.stringify(written.body))
    assert.equal(written.body.status, 'resulted')
    assert.equal(written.body.attachments.length, 1)

    const doctor = await t.as('doctor')
    assert.equal((await fetch(`${t.api.url}${lab}/attachments/${att.id}/file`, { headers: { Authorization: `Bearer ${doctor.token}` } })).status, 403, 'the doctor sees the image once the report is signed')
    assert.equal((await lb.post(`${lab}/orders/${xrayOrder}/sign`)).status, 200)
    const image = await fetch(`${t.api.url}${lab}/attachments/${att.id}/file`, { headers: { Authorization: `Bearer ${doctor.token}` } })
    assert.equal(image.status, 200)
    assert.ok(Buffer.from(await image.arrayBuffer()).equals(PNG))
    assert.equal((await upload(PNG, 'title=Late')).status, 409, 'no new images on a signed report')
    const report = (await doctor.get(`${lab}/orders/${xrayOrder}/report`)).body
    assert.deepEqual([report.impression, report.accessionNo.slice(0, 3)], ['Normal chest radiograph', 'RD-'])
  })

  it('does not charge for a cancelled test, and refuses to cancel one with results', async () => {
    const extra = await order(urine, 'lab', 'Urine Routine')
    const lb = await t.as('lab')
    assert.equal((await lb.post(`${lab}/orders/${cbcOrder}/cancel`, { reason: 'wrong test' })).status, 409, 'it has a result')
    assert.equal((await lb.post(`${lab}/orders/${extra}/cancel`, { reason: 'x' })).status, 400)
    const cancelled = await lb.post(`${lab}/orders/${extra}/cancel`, { reason: 'Ordered by mistake' })
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body))
    assert.equal(cancelled.body.status, 'cancelled')
    assert.equal((await lb.post(`${lab}/orders/${extra}/collect`, {})).status, 409)

    const closed = await t.post(`${api}/encounters/${visit}/close`)
    assert.equal(closed.status, 200, JSON.stringify(closed.body))
    const labels = (closed.body.bill.items as { label: string }[]).map((i) => i.label)
    assert.deepEqual(labels.filter((l) => l.startsWith('Lab Test')).sort(), ['Lab Test: Complete Blood Count', 'Lab Test: Urine Routine'], 'the cancelled test is not on the bill')
    const late = await order(urine, 'lab', 'Urine Routine').catch(() => null)
    assert.equal(late, null, 'a closed visit takes no more orders')
  })

  it('refuses to cancel a test once its visit has been billed', async () => {
    const visit2 = (await checkInOpdPaid(t, { patientId: (await newPatient(t, { name: 'Second Patient' })).id, doctorId, department: 'General Medicine' })).body.id
    const o = (await t.post(`${api}/encounters/${visit2}/orders`, { type: 'lab', name: 'Urine Routine', investigationId: urine })).body.id
    await t.post(`${api}/encounters/${visit2}/close`)
    const refused = await (await t.as('lab')).post(`${lab}/orders/${o}/cancel`, { reason: 'changed mind' })
    assert.equal(refused.status, 409)
    assert.match(refused.body.error.message, /billing counter/)
  })
})

describe('Second-person verification', () => {
  let t: TestApi
  let orderId: string
  before(async () => {
    t = await startTestApi()
    const { doctorId } = await seedBasics(t)
    const patient = await newPatient(t, { name: 'Verify Patient' })
    const test = (await t.post(`${masters}/investigations`, { code: 'GLU', name: 'Blood Glucose', kind: 'lab', price: 100, parameters: [{ name: 'Glucose', unit: 'mg/dL', refLow: 70, refHigh: 140 }] })).body.id
    const visit = (await checkInOpdPaid(t, { patientId: patient.id, doctorId, department: 'General Medicine' })).body.id
    orderId = (await t.post(`${api}/encounters/${visit}/orders`, { type: 'lab', name: 'Blood Glucose', investigationId: test })).body.id
    await t.post(`${lab}/orders/${orderId}/collect`, {})
  })
  after(() => t.close())

  it('lets the person who entered the results sign them when the hospital has not asked for a second person', async () => {
    assert.equal((await t.get(`${masters}/settings`)).body.requireReportVerification, false)
    const lb = await t.as('lab')
    const form = (await lb.get(`${lab}/orders/${orderId}`)).body.form as { parameterId: string }[]
    await lb.call('PUT', `${lab}/orders/${orderId}/results`, { results: [{ parameterId: form[0]!.parameterId, value: '95' }] })
    assert.equal((await lb.post(`${lab}/orders/${orderId}/sign`)).status, 200)
    assert.equal((await lb.post(`${lab}/orders/${orderId}/amend`, { reason: 'Reopen to test verification' })).status, 200)
  })

  it('needs somebody else to sign once the setting is on', async () => {
    assert.equal((await t.call('PUT', `${masters}/settings`, { requireReportVerification: true })).body.requireReportVerification, true)
    const lb = await t.as('lab')
    const form = (await lb.get(`${lab}/orders/${orderId}`)).body.form as { parameterId: string }[]
    await lb.call('PUT', `${lab}/orders/${orderId}/results`, { results: [{ parameterId: form[0]!.parameterId, value: '99' }] })
    const own = await lb.post(`${lab}/orders/${orderId}/sign`)
    assert.equal(own.status, 403)
    assert.match(own.body.error.message, /second person/)
    const other = await (await t.as('doctor')).post(`${lab}/orders/${orderId}/sign`)
    assert.equal(other.status, 200, JSON.stringify(other.body))
    assert.equal(other.body.signedBy, 'Test doctor')
  })
})

describe('Lab desk invoices and management figures', () => {
  let t: TestApi
  let patientId: string
  let cbc: string
  let urine: string
  let panel: string
  before(async () => {
    t = await startTestApi()
    patientId = (await newPatient(t, { name: 'Walk In Patient' })).id
    cbc = (await t.post(`${masters}/investigations`, { code: 'CBC', name: 'CBC', kind: 'lab', section: 'Haematology', tatHours: 4, price: 400, parameters: [{ name: 'Hb', unit: 'g/dL', refLow: 12, refHigh: 16 }] })).body.id
    urine = (await t.post(`${masters}/investigations`, { code: 'URN', name: 'Urine Routine', kind: 'lab', price: 100, gstPct: 12 })).body.id
    panel = (await t.post(`${api}/panels`, { code: 'CGHS', name: 'CGHS', category: 'government', discountPct: 10, requiresBeneficiaryId: true })).body.id
  })
  after(() => t.close())

  const sale = (body: Record<string, unknown>, client: TestApi = t) =>
    client.post(`${lab}/invoices`, { patientId, tests: [{ investigationId: cbc }, { investigationId: urine }], payment: { mode: 'cash' }, ...body })

  it('invoices tests for a registered patient and puts them on the worklist', async () => {
    const r = await sale({ payment: { mode: 'cash', amountReceived: 600 } })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.match(r.body.invoiceNo, /^LB-\d+$/)
    assert.deepEqual([r.body.subtotal, r.body.discount, r.body.gstTotal, r.body.total, r.body.change], [500, 0, 12, 512, 88])
    assert.equal(r.body.items.length, 2)
    const worklist = (await (await t.as('lab')).get(`${lab}/orders?source=desk`)).body.orders as { name: string; invoiceNo: string; encounterId: string | null }[]
    assert.deepEqual(worklist.map((o) => [o.name, o.invoiceNo, o.encounterId]).sort(), [['CBC', r.body.invoiceNo, null], ['Urine Routine', r.body.invoiceNo, null]])
  })

  it('applies a discount, and checks the payment and the people', async () => {
    const d = await sale({ discountPct: 10 })
    assert.deepEqual([d.body.subtotal, d.body.discount, d.body.gstTotal, d.body.total], [500, 50, 10.8, 460.8])
    assert.equal((await sale({ payment: { mode: 'upi' } })).status, 400, 'UPI needs a transaction id')
    assert.equal((await sale({ payment: { mode: 'cash', amountReceived: 100 } })).status, 400, 'cash short')
    assert.equal((await sale({ patientId: '00000000-0000-4000-8000-000000000000' })).status, 404)
    assert.equal((await sale({ tests: [{ investigationId: cbc }, { investigationId: cbc }] })).status, 400, 'a test twice')
    assert.equal((await sale({ tests: [] })).status, 400)
  })

  it('uses a panel\'s rate and asks for its card number', async () => {
    assert.equal((await sale({ panelId: panel })).status, 400, 'CGHS needs the beneficiary number')
    const p = await sale({ panelId: panel, beneficiaryId: 'CG-123' })
    assert.equal(p.status, 201, JSON.stringify(p.body))
    assert.deepEqual([p.body.panelName, p.body.beneficiaryId], ['CGHS', 'CG-123'])
    assert.deepEqual(p.body.items.map((i: any) => [i.name, i.standardRate, i.rate]).sort(), [['CBC', 400, 360], ['Urine Routine', 100, 90]], 'the panel\'s 10% comes off each test')
  })

  it('quotes the exact amount before anything is taken or saved', async () => {
    const before = (await t.get(`${lab}/invoices`)).body.invoices.length
    const q = await t.post(`${lab}/invoices/quote`, { tests: [{ investigationId: cbc }, { investigationId: urine }], panelId: panel, beneficiaryId: 'CG-1', discountPct: 10 })
    assert.equal(q.status, 200, JSON.stringify(q.body))
    // 10% panel rate (360 and 90), then a further 10% off those: 324 + 81 + GST 12% of 81
    assert.deepEqual([q.body.subtotal, q.body.discount, q.body.gstTotal, q.body.total, q.body.panelName], [450, 45, 9.72, 414.72, 'CGHS'])
    assert.equal((await t.post(`${lab}/invoices/quote`, { tests: [{ investigationId: cbc }], panelId: panel })).status, 400, 'a quote asks for the same card number')
    assert.equal((await t.get(`${lab}/invoices`)).body.invoices.length, before, 'nothing was saved')
    assert.equal((await (await t.as('nurse')).post(`${lab}/invoices/quote`, { tests: [{ investigationId: cbc }] })).status, 403)
    assert.equal((await (await t.as('lab')).get(`${api}/panels`)).status, 200, 'the lab desk can pick a panel')
  })

  it('lists invoices, and only the lab desk, front office and billing can raise them', async () => {
    assert.equal((await sale({}, await t.as('nurse'))).status, 403)
    assert.equal((await sale({}, await t.as('pharmacist'))).status, 403)
    assert.equal((await sale({}, await t.as('front_office'))).status, 201)
    const list = (await t.get(`${lab}/invoices`)).body
    assert.ok(list.invoices.length >= 4)
    assert.equal(list.totals.count, list.invoices.length)
    assert.equal((await t.get(`${lab}/invoices?search=Walk`)).body.invoices.length, list.invoices.length)
    const one = await t.get(`${lab}/invoices/${list.invoices[0].id}`)
    assert.equal(one.body.items.length, 2)
  })

  it('cancels an invoice only before any work has started, and only at the billing counter', async () => {
    const r = await sale({})
    assert.equal((await (await t.as('lab')).post(`${lab}/invoices/${r.body.id}/cancel`, { reason: 'customer left' })).status, 403)
    const biller = await t.as('biller')
    assert.equal((await biller.post(`${lab}/invoices/${r.body.id}/cancel`, { reason: 'x' })).status, 400)

    const first = r.body.items[0].orderId as string
    await (await t.as('lab')).post(`${lab}/orders/${first}/collect`, {})
    const refused = await biller.post(`${lab}/invoices/${r.body.id}/cancel`, { reason: 'customer left' })
    assert.equal(refused.status, 409)
    assert.match(refused.body.error.message, /sample is collected/)
    assert.equal((await (await t.as('lab')).post(`${lab}/orders/${first}/cancel`, { reason: 'x y z' })).status, 409, 'a desk test is cancelled with its invoice')

    const fresh = await sale({})
    const cancelled = await biller.post(`${lab}/invoices/${fresh.body.id}/cancel`, { reason: 'Customer left' })
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body))
    assert.deepEqual([cancelled.body.status, cancelled.body.items.map((i: any) => i.status)], ['cancelled', ['cancelled', 'cancelled']])
    assert.equal((await biller.post(`${lab}/invoices/${fresh.body.id}/cancel`, { reason: 'Again please' })).status, 409)
  })

  it('reports test volumes, turnaround against the promise, and the money', async () => {
    const lb = await t.as('lab')
    const orders = ((await lb.get(`${lab}/orders?source=desk&status=ordered`)).body.orders as { id: string; name: string }[]).filter((o) => o.name === 'CBC')
    const target = orders[0]!.id
    await lb.post(`${lab}/orders/${target}/collect`, {})
    const form = (await lb.get(`${lab}/orders/${target}`)).body.form as { parameterId: string }[]
    await lb.call('PUT', `${lab}/orders/${target}/results`, { results: [{ parameterId: form[0]!.parameterId, value: '13' }] })
    await lb.post(`${lab}/orders/${target}/sign`)

    const mis = await lb.get(`${lab}/reports/summary`)
    assert.equal(mis.status, 200, JSON.stringify(mis.body))
    const cbcRow = mis.body.tests.find((r: any) => r.name === 'CBC')
    assert.equal(cbcRow.completed, 1)
    assert.equal(cbcRow.withTarget, 1)
    assert.equal(cbcRow.withinTargetPct, 100, 'reported in minutes against a four-hour promise')
    assert.ok(cbcRow.avgTatHours < 1)
    assert.ok(cbcRow.deskCollected > 0)
    assert.equal(mis.body.sections.find((s: any) => s.section === 'Haematology').completed, 1)
    assert.equal(mis.body.totals.completed, 1)
    assert.ok(mis.body.totals.pending >= 1)
    assert.ok(mis.body.desk.count >= 4 && mis.body.desk.cancelled === 1)
    assert.equal((await (await t.as('nurse')).get(`${lab}/reports/summary`)).status, 403)
    assert.equal((await lb.get(`${lab}/reports/summary?from=2020-01-01&to=2020-01-31`)).body.totals.ordered, 0)
  })

  it('counts a test as overdue once it passes the hours it promised', async () => {
    const lb = await t.as('lab')
    const before = (await lb.get(`${lab}/orders`)).body.counts.overdue
    await t.inHospital(() => t.api.ctx.db.execute(`UPDATE "ClinicalOrder" SET "createdAt" = now() - interval '9 hours' WHERE name = 'CBC' AND status = 'ordered' AND "accessionNo" IS NULL`))
    const now = (await lb.get(`${lab}/orders`)).body.counts.overdue
    assert.ok(now > before, `${before} -> ${now}`)
    const only = (await lb.get(`${lab}/orders?overdue=true`)).body.orders as { overdue: boolean }[]
    assert.ok(only.length > 0 && only.every((o) => o.overdue))
  })
})
