import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { istDate, priceLine, splitTax, suggestedQuantity } from '../../src/hospital/modules/pharmacy/gst.js'
import { defaultTimes } from '../../src/hospital/modules/pharmacy/ward-medicine.js'
import { newPatient, seedBasics, startTestApi, type TestApi, stopServer } from './helpers.js'

// One application per test file, shared by its describe blocks: stop it when they are all done.
after(stopServer)

const api = '/api/v1'
const ph = `${api}/pharmacy`
const daysFromNow = (n: number) => istDate(new Date(Date.now() + n * 86_400_000))

describe('Pharmacy arithmetic', () => {
  it('splits an MRP into taxable value and GST, since the MRP includes the tax', () => {
    assert.deepEqual(priceLine(1, 118, 18), { lineTotal: 118, taxable: 100, tax: 18 })
    assert.deepEqual(priceLine(10, 8, 12), { lineTotal: 80, taxable: 71.43, tax: 8.57 })
    assert.deepEqual(priceLine(2, 50, 5, 10), { lineTotal: 90, taxable: 85.71, tax: 4.29 }, 'a discount comes off the MRP first')
    assert.deepEqual(priceLine(3, 10, 0), { lineTotal: 30, taxable: 30, tax: 0 })
  })

  it('shares tax equally between CGST and SGST with nothing lost', () => {
    assert.deepEqual(splitTax(8.57), { cgst: 4.29, sgst: 4.28 })
    assert.deepEqual(splitTax(18), { cgst: 9, sgst: 9 })
  })

  it('works out how many units a prescription needs, or says it cannot', () => {
    assert.equal(suggestedQuantity('TDS', '5 days'), 15)
    assert.equal(suggestedQuantity('BD', '2 weeks'), 28)
    assert.equal(suggestedQuantity('OD', '1 month'), 30)
    assert.equal(suggestedQuantity('1-0-1', '3 days'), 6)
    assert.equal(suggestedQuantity('SOS', '5 days'), null)
    assert.equal(suggestedQuantity('BD', 'Ongoing'), null)
  })

  it('knows the usual times for a frequency', () => {
    assert.deepEqual(defaultTimes('tds'), ['08:00', '14:00', '20:00'])
    assert.equal(defaultTimes('SOS'), null)
  })
})

describe('Suppliers and purchases', () => {
  let t: TestApi
  let supplier: string
  let drugId: string
  before(async () => {
    t = await startTestApi()
    supplier = (await t.post(`${ph}/suppliers`, { name: 'MediSupply', gstin: '27ABCDE1234F1Z5', phone: '9876500100' })).body.id
    drugId = (await t.post(`${ph}/drugs`, { name: 'Paracetamol 500mg', unit: 'tab', reorderLevel: 20, mrp: 2, gstPct: 12 })).body.id
  })
  after(() => t.close())

  const buy = (body: Record<string, unknown>, client: TestApi = t) =>
    client.post(`${ph}/purchases`, { supplierId: supplier, supplierInvoiceNo: 'INV-1', invoiceDate: daysFromNow(-1), ...body })
  const line = (extra: Record<string, unknown> = {}) => ({ drugId, batchNo: 'B1', expiry: daysFromNow(400), qty: 100, freeQty: 10, purchaseRate: 1.2, mrp: 2, ...extra })

  it('keeps suppliers once each, and checks a GSTIN', async () => {
    assert.equal((await t.post(`${ph}/suppliers`, { name: 'medisupply' })).status, 409)
    assert.equal((await t.post(`${ph}/suppliers`, { name: 'Bad Gstin', gstin: 'NOPE' })).status, 400)
    const edited = await t.call('PATCH', `${ph}/suppliers/${supplier}`, { phone: '9000000000' })
    assert.equal(edited.body.phone, '9000000000')
  })

  it('receives a purchase into a batch, counting the free units and working out the tax', async () => {
    const result = await buy({ items: [line()], payment: { amount: 50, mode: 'cash' } })
    assert.equal(result.status, 201, JSON.stringify(result.body))
    const p = result.body
    assert.match(p.purchaseNo, /^PUR-\d+$/)
    assert.deepEqual([p.taxable, p.gstTotal, p.total], [120, 14.4, 134.4], '100 paid units at 1.20, 12% GST; free units cost nothing')
    assert.deepEqual([p.amountPaid, p.due], [50, 84.4])

    const stock = (await t.get(`${ph}/stock`)).body
    assert.equal(stock.batches.length, 1)
    assert.equal(stock.batches[0].qty, 110, '100 bought plus 10 free')
    assert.equal(stock.batches[0].purchaseRate, 1.0909, 'the cost per unit is spread over the free units too')
    assert.deepEqual([stock.totals.units, stock.totals.costValue, stock.totals.mrpValue], [110, 120, 220])
    const ledger = (await t.get(`${ph}/stock-ledger?drugId=${drugId}`)).body
    assert.deepEqual([ledger[0].kind, ledger[0].delta], ['purchase', 110])
  })

  it('adds to an existing batch, averaging its cost, and refuses a batch number reused with another expiry', async () => {
    const more = await buy({ supplierInvoiceNo: 'INV-2', items: [line({ qty: 110, freeQty: 0, purchaseRate: 1.5 })] })
    assert.equal(more.status, 201, JSON.stringify(more.body))
    const batch = (await t.get(`${ph}/stock`)).body.batches[0]
    assert.equal(batch.qty, 220)
    assert.equal(batch.purchaseRate, 1.2955, '(110 x 1.0909 + 110 x 1.5) / 220')

    const clash = await buy({ supplierInvoiceNo: 'INV-3', items: [line({ expiry: daysFromNow(900) })] })
    assert.equal(clash.status, 409)
    assert.match(clash.body.error.message, /already in stock with expiry/)
  })

  it('refuses a repeated supplier invoice, an expired batch, a future invoice date and a payment above the total', async () => {
    assert.equal((await buy({ items: [line({ batchNo: 'B9' })] })).status, 409, 'INV-1 was already entered')
    assert.equal((await buy({ supplierInvoiceNo: 'X1', items: [line({ batchNo: 'OLD', expiry: daysFromNow(-5) })] })).status, 400)
    assert.equal((await buy({ supplierInvoiceNo: 'X2', invoiceDate: daysFromNow(3), items: [line({ batchNo: 'FUT' })] })).status, 400)
    assert.equal((await buy({ supplierInvoiceNo: 'X3', items: [line({ batchNo: 'PAY' })], payment: { amount: 99999, mode: 'cash' } })).status, 400)
    assert.equal(((await t.get(`${ph}/stock`)).body.batches as unknown[]).length, 1, 'a refused purchase leaves nothing behind')
  })

  it('adds a new medicine to the stock list from a purchase line (an imported bill)', async () => {
    const result = await buy({
      supplierInvoiceNo: 'IMP-1',
      items: [{ newDrug: { name: 'Cetirizine 10mg', unit: 'tab', gstPct: 12, mrp: 3 }, batchNo: 'C1', expiry: daysFromNow(300), qty: 50, purchaseRate: 1, mrp: 3 }],
    })
    assert.equal(result.status, 201, JSON.stringify(result.body))
    const drugs = (await t.get(`${ph}/drugs?search=cetiri`)).body
    assert.deepEqual([drugs[0].name, drugs[0].stock, drugs[0].hsnCode], ['Cetirizine 10mg', 50, '3004'])
    const again = await buy({ supplierInvoiceNo: 'IMP-2', items: [{ newDrug: { name: 'cetirizine 10MG', unit: 'tab', gstPct: 12, mrp: 3 }, batchNo: 'C2', expiry: daysFromNow(300), qty: 10, purchaseRate: 1, mrp: 3 }] })
    assert.equal(again.status, 201)
    assert.equal(((await t.get(`${ph}/drugs?search=cetiri`)).body as unknown[]).length, 1, 'found by name, not added twice')
  })

  it('records payments to the supplier up to what is owed, and cancels a purchase only while its stock is untouched', async () => {
    const list = (await t.get(`${ph}/purchases?unpaid=true`)).body
    const first = list.purchases.find((p: any) => p.supplierInvoiceNo === 'INV-1')
    assert.equal(first.due, 84.4)
    assert.equal((await t.post(`${ph}/purchases/${first.id}/payment`, { amount: 100, mode: 'bank' })).status, 400, 'more than due')
    const paid = await t.post(`${ph}/purchases/${first.id}/payment`, { amount: 84.4, mode: 'bank', reference: 'NEFT-1' })
    assert.equal(paid.body.due, 0)

    const cetirizine = (await t.get(`${ph}/purchases`)).body.purchases.find((p: any) => p.supplierInvoiceNo === 'IMP-2')
    const cancelled = await t.post(`${ph}/purchases/${cetirizine.id}/cancel`, { reason: 'Entered twice by mistake' })
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body))
    assert.equal(cancelled.body.status, 'cancelled')
    assert.equal((await t.get(`${ph}/drugs?search=cetiri`)).body[0].stock, 50, 'its units are back out of stock')
    assert.equal((await t.post(`${ph}/purchases/${cetirizine.id}/cancel`, { reason: 'again please' })).status, 409)

    // sell some of the first purchase's batch: it can no longer be taken back out
    await t.post(`${ph}/sales`, { items: [{ drugId, qty: 5 }], payment: { mode: 'cash' } })
    assert.equal((await t.post(`${ph}/purchases/${first.id}/cancel`, { reason: 'wrong supplier' })).status, 200, 'enough of it is still on the shelf, so this one can go')
    const second = (await t.get(`${ph}/purchases`)).body.purchases.find((p: any) => p.supplierInvoiceNo === 'INV-2')
    await t.post(`${ph}/sales`, { items: [{ drugId, qty: 215 }], payment: { mode: 'cash' } })
    assert.equal((await t.post(`${ph}/purchases/${second.id}/cancel`, { reason: 'too late' })).status, 409, 'its stock has been sold')
  })

  it('is for the pharmacist and the administrator', async () => {
    assert.equal((await buy({ supplierInvoiceNo: 'ROLE', items: [line({ batchNo: 'R' })] }, await t.as('nurse'))).status, 403)
    assert.equal((await (await t.as('biller')).get(`${ph}/purchases`)).status, 403)
    assert.equal((await (await t.as('pharmacist')).get(`${ph}/purchases`)).status, 200)
  })
})

describe('Selling from batches', () => {
  let t: TestApi
  let drugId: string
  let late: string
  before(async () => {
    t = await startTestApi()
    const supplier = (await t.post(`${ph}/suppliers`, { name: 'Apex' })).body.id
    drugId = (await t.post(`${ph}/drugs`, { name: 'Amoxicillin 500mg', unit: 'cap', reorderLevel: 10, mrp: 11.8, gstPct: 18 })).body.id
    const base = { supplierId: supplier, invoiceDate: daysFromNow(-2) }
    await t.post(`${ph}/purchases`, { ...base, supplierInvoiceNo: 'A-1', items: [{ drugId, batchNo: 'LATE', expiry: daysFromNow(700), qty: 50, purchaseRate: 6, mrp: 12 }] })
    await t.post(`${ph}/purchases`, { ...base, supplierInvoiceNo: 'A-2', items: [{ drugId, batchNo: 'EARLY', expiry: daysFromNow(100), qty: 20, purchaseRate: 5, mrp: 11.8 }] })
    const batches = (await t.get(`${ph}/stock`)).body.batches as { batchId: string; batchNo: string }[]
    late = batches.find((b) => b.batchNo === 'LATE')!.batchId
  })
  after(() => t.close())

  const sell = (body: Record<string, unknown>) => t.post(`${ph}/sales`, { payment: { mode: 'cash' }, ...body })

  it('takes from the batch that expires first, then the next, one line per batch, each at its own MRP', async () => {
    const sale = await sell({ items: [{ drugId, qty: 30 }], customerName: 'Walk-in Customer' })
    assert.equal(sale.status, 201, JSON.stringify(sale.body))
    assert.match(sale.body.invoiceNo, /^PH-\d+$/)
    assert.deepEqual(sale.body.items.map((i: any) => [i.batchNo, i.qty, i.mrp]).sort(), [['EARLY', 20, 11.8], ['LATE', 10, 12]])
    assert.equal(sale.body.total, 20 * 11.8 + 10 * 12, 'the totals are what is paid')
    assert.equal(sale.body.taxable + sale.body.tax, sale.body.total)
    const stock = (await t.get(`${ph}/stock`)).body.batches
    assert.deepEqual(stock.map((b: any) => [b.batchNo, b.qty]), [['LATE', 40]], 'the early batch is used up and not listed')
  })

  it('shows the GST by rate with CGST and SGST', async () => {
    const sale = await sell({ items: [{ drugId, qty: 10 }] })
    assert.deepEqual(sale.body.taxSummary, [{ gstPct: 18, taxable: 101.69, cgst: 9.15, sgst: 9.16, total: 120 }])
  })

  it('gives a discount from the MRP, and needs a reference for UPI and card', async () => {
    const discounted = await sell({ items: [{ drugId, qty: 10 }], discountPct: 10 })
    assert.equal(discounted.body.total, 108)
    assert.equal((await sell({ items: [{ drugId, qty: 1 }], payment: { mode: 'upi' } })).status, 400)
    assert.equal((await sell({ items: [{ drugId, qty: 1 }], payment: { mode: 'upi', reference: 'UPI-77-1234' } })).status, 201)
    assert.equal((await sell({ items: [{ drugId, qty: 1 }], payment: { mode: 'cash', amountReceived: 1 } })).status, 400, 'less cash than the bill')
    const change = await sell({ items: [{ drugId, qty: 1 }], payment: { mode: 'cash', amountReceived: 50 } })
    assert.equal(change.body.change, 38)
  })

  it('refuses more than is in stock, naming how many there are, and never sells an expired batch', async () => {
    const left = (await t.get(`${ph}/drugs`)).body[0].stock
    const refused = await sell({ items: [{ drugId, qty: left + 1 }] })
    assert.equal(refused.status, 409)
    assert.match(refused.body.error.message, new RegExp(`Only ${left} of Amoxicillin`))
    assert.equal((await t.get(`${ph}/drugs`)).body[0].stock, left, 'a refused sale leaves stock alone')

    await t.inHospital(() => t.api.ctx.db.execute(`UPDATE "DrugBatch" SET expiry = current_date - 1 WHERE "batchNo" = 'LATE'`))
    const expired = await sell({ items: [{ drugId, qty: 1 }] })
    assert.equal(expired.status, 409)
    assert.match(expired.body.error.message, /out of stock/)
    const drug = (await t.get(`${ph}/drugs`)).body[0]
    assert.deepEqual([drug.stock, drug.expiredQty], [0, left], 'expired units are counted apart from what can be sold')
    await t.inHospital(() => t.api.ctx.db.execute(`UPDATE "DrugBatch" SET expiry = current_date + 500 WHERE "batchNo" = 'LATE'`))
  })

  it('chooses a particular batch when asked', async () => {
    await t.post(`${ph}/purchases`, { supplierId: (await t.get(`${ph}/suppliers`)).body[0].id, supplierInvoiceNo: 'A-3', invoiceDate: daysFromNow(-1), items: [{ drugId, batchNo: 'NEWER', expiry: daysFromNow(50), qty: 10, purchaseRate: 4, mrp: 11 }] })
    const specific = await sell({ items: [{ drugId, qty: 2, batchId: late }] })
    assert.equal(specific.body.items[0].batchNo, 'LATE', 'not the NEWER batch that expires first')
  })

  it('cancels a sale, putting the stock back where it came from and keeping the invoice on record', async () => {
    const before = (await t.get(`${ph}/drugs`)).body[0].stock
    const sale = (await sell({ items: [{ drugId, qty: 4 }] })).body
    assert.equal((await t.get(`${ph}/drugs`)).body[0].stock, before - 4)
    assert.equal((await t.post(`${ph}/sales/${sale.id}/cancel`, { reason: 'x' })).status, 400)
    const cancelled = await t.post(`${ph}/sales/${sale.id}/cancel`, { reason: 'Customer returned the pack' })
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body))
    assert.equal(cancelled.body.status, 'cancelled')
    assert.equal((await t.get(`${ph}/drugs`)).body[0].stock, before)
    assert.equal((await t.post(`${ph}/sales/${sale.id}/cancel`, { reason: 'again please' })).status, 409)
    const listed = (await t.get(`${ph}/sales?status=cancelled`)).body.sales as { invoiceNo: string }[]
    assert.ok(listed.some((s) => s.invoiceNo === sale.invoiceNo))
  })

  it('writes stock off with a reason on the ledger, and never below zero', async () => {
    const batch = ((await t.get(`${ph}/stock`)).body.batches as any[]).find((b) => b.batchNo === 'NEWER')
    assert.equal((await t.post(`${ph}/batches/${batch.batchId}/adjust`, { delta: -3 })).status, 400, 'a reason is needed')
    assert.equal((await t.post(`${ph}/batches/${batch.batchId}/adjust`, { delta: -99, reason: 'Count' })).status, 400, 'more than is there')
    const done = await t.post(`${ph}/batches/${batch.batchId}/adjust`, { delta: -3, reason: 'Damaged in storage' })
    assert.equal(done.body.qty, batch.qty - 3)
    const ledger = (await t.get(`${ph}/stock-ledger`)).body
    assert.deepEqual([ledger[0].kind, ledger[0].delta, ledger[0].reason], ['adjustment', -3, 'Damaged in storage'])
  })

  it('lets clinical staff see what is in stock but not sell it', async () => {
    const nurse = await t.as('nurse')
    assert.equal((await nurse.get(`${ph}/drugs`)).status, 200)
    assert.equal((await nurse.post(`${ph}/sales`, { items: [{ drugId, qty: 1 }], payment: { mode: 'cash' } })).status, 403)
    assert.equal((await (await t.as('doctor')).get(`${ph}/stock`)).status, 403)
  })
})

describe('Dispensing for a visit, and the visit\'s bill', () => {
  let t: TestApi
  let doctorId: string
  let bedA: string
  let drugId: string
  before(async () => {
    t = await startTestApi()
    ;({ doctorId, bedA } = await seedBasics(t))
    const supplier = (await t.post(`${ph}/suppliers`, { name: 'Apex' })).body.id
    drugId = (await t.post(`${ph}/drugs`, { name: 'Pantoprazole 40mg', unit: 'tab', reorderLevel: 5, mrp: 11.2, gstPct: 12 })).body.id
    await t.post(`${ph}/purchases`, { supplierId: supplier, supplierInvoiceNo: 'P-1', invoiceDate: daysFromNow(-1), items: [{ drugId, batchNo: 'P1', expiry: daysFromNow(400), qty: 100, purchaseRate: 6, mrp: 11.2 }] })
  })
  after(() => t.close())

  const admit = async (name: string, bed = bedA) => {
    const patient = await newPatient(t, { name })
    return { patient, stayId: (await t.post(`${api}/encounters/ipd`, { patientId: patient.id, department: 'Medicine', doctorId, bedId: bed })).body.id as string }
  }

  it('suggests the quantity, takes it from stock, and puts it on the admission\'s bill at the MRP', async () => {
    const { stayId } = await admit('Pharmacy Stay')
    const rx = (await t.post(`${api}/encounters/${stayId}/prescriptions`, { drugName: 'Pantoprazole 40mg', dose: '1 tab', frequency: 'BD', duration: '5 days' })).body
    const queue = (await t.get(`${ph}/queue`)).body.find((q: any) => q.id === rx.id)
    assert.deepEqual([queue.suggestedQty, queue.listed, queue.stock], [10, true, 100])

    const done = await t.post(`${ph}/prescriptions/${rx.id}/dispense`, { quantity: 10 })
    assert.equal(done.status, 200, JSON.stringify(done.body))
    assert.deepEqual([done.body.quantity, done.body.remainingStock, done.body.stockUpdated], [10, 90, true])
    assert.match(done.body.invoiceNo, /^DISP-\d+$/)

    const running = (await t.get(`${api}/ipd-billing/${stayId}`)).body
    const line = running.lines.find((l: any) => l.source === 'medicine')
    assert.equal(line.description, 'Pharmacy: Pantoprazole 40mg x 10')
    assert.equal(line.amount, 112, '10 x 11.20, GST included in the MRP')
    assert.equal(line.rate, 100, 'entered at the taxable value')
    assert.equal((await t.post(`${ph}/prescriptions/${rx.id}/dispense`, { quantity: 1 })).status, 409, 'dispensed once')
  })

  it('refuses more than is in stock, and the dispense of a visit cannot be cancelled as a sale', async () => {
    const bedB = (await t.post(`${api}/beds`, { ward: 'Ward A', bedNo: 'A-05' })).body.id
    const { stayId } = await admit('Big Order', bedB)
    const rx = (await t.post(`${api}/encounters/${stayId}/prescriptions`, { drugName: 'Pantoprazole 40mg', dose: '1', frequency: 'BD', duration: '5 days' })).body
    const refused = await t.post(`${ph}/prescriptions/${rx.id}/dispense`, { quantity: 500 })
    assert.equal(refused.status, 409)
    assert.match(refused.body.error.message, /Only 90 of Pantoprazole/)
    const sales = (await t.get(`${ph}/sales?kind=encounter`)).body.sales as { id: string }[]
    assert.equal((await t.post(`${ph}/sales/${sales[0]!.id}/cancel`, { reason: 'trying' })).status, 409)
  })
})

describe('Reports', () => {
  let t: TestApi
  let drugId: string
  let supplier: string
  const today = daysFromNow(0)
  before(async () => {
    t = await startTestApi()
    supplier = (await t.post(`${ph}/suppliers`, { name: 'Apex' })).body.id
    drugId = (await t.post(`${ph}/drugs`, { name: 'Amoxicillin 500mg', unit: 'cap', mrp: 12, gstPct: 12, hsnCode: '3004' })).body.id
    const strip = (await t.post(`${ph}/drugs`, { name: 'Vitamin Syrup', unit: 'btl', mrp: 100, gstPct: 5, hsnCode: '2106' })).body.id
    const base = { supplierId: supplier, invoiceDate: daysFromNow(-1) }
    await t.post(`${ph}/purchases`, { ...base, supplierInvoiceNo: 'R-1', items: [
      { drugId, batchNo: 'R1', expiry: daysFromNow(400), qty: 100, purchaseRate: 6, mrp: 12 },
      { drugId: strip, batchNo: 'S1', expiry: daysFromNow(400), qty: 20, purchaseRate: 60, mrp: 100 },
    ] })
    // 10 + 4 sold today
    await t.post(`${ph}/sales`, { items: [{ drugId, qty: 10 }, { drugId: strip, qty: 2 }], payment: { mode: 'cash' } })
    // an old batch with no purchase price: cost unknown
    const legacy = (await t.post(`${ph}/drugs`, { name: 'Old Stock Drug', unit: 'tab', mrp: 5, gstPct: 12, batch: 'OLD', expiry: daysFromNow(200), stock: 10 })).body.id
    await t.post(`${ph}/sales`, { items: [{ drugId: legacy, qty: 4 }], payment: { mode: 'cash' } })
  })
  after(() => t.close())

  it('prepares the GST return figures: consumers by rate, the HSN summary and the documents issued', async () => {
    const r = (await t.get(`${ph}/reports/gstr1?from=${today}&to=${today}`)).body
    const byRate = Object.fromEntries(r.b2cByRate.map((x: any) => [x.gstPct, x]))
    assert.deepEqual([byRate[12].taxable, byRate[12].tax, byRate[12].total], [125, 15, 140], '10 x 12 + 4 x 5 = 140 at 12%')
    assert.deepEqual([byRate[5].taxable, byRate[5].tax, byRate[5].total], [190.48, 9.52, 200])
    assert.equal(byRate[12].cgst + byRate[12].sgst, byRate[12].tax)
    assert.deepEqual(r.hsn.map((h: any) => [h.hsnCode, h.gstPct, h.qty]).sort(), [['2106', 5, 2], ['3004', 12, 14]])
    assert.deepEqual([r.documents.issued, r.documents.cancelled], [2, 0])
    assert.equal(r.totals.total, 340)
    assert.deepEqual(r.inputTax, [], 'purchases dated yesterday are not in today')
    const withPurchases = (await t.get(`${ph}/reports/gstr1?from=${daysFromNow(-1)}&to=${today}`)).body
    assert.deepEqual(withPurchases.inputTax.map((x: any) => [x.gstPct, x.gst]), [[5, 60], [12, 72]], 'the tax paid on what was bought, for reference')
  })

  it('works out profit from the purchase prices, leaving out what it cannot cost', async () => {
    const r = (await t.get(`${ph}/reports/profit-loss?from=${today}&to=${today}`)).body
    // amoxicillin 10 x 6 = 60 cost; vitamin 2 x 60 = 120; the old-stock drug has no known cost
    assert.equal(r.costOfGoodsSold, 180)
assert.equal(r.revenueWithoutKnownCost, 17.86, '4 x 5 = 20 including 12% GST')
    assert.equal(r.revenue, 107.14 + 190.48 + 17.86)
    assert.equal(r.grossProfit, 315.48 - 17.86 - 180, 'the revenue with no known cost is not counted as profit')
    assert.equal(r.revenueByKind.counter, r.revenue)
    assert.equal(r.byItem[0].drugName, 'Vitamin Syrup', 'most profitable first')
    assert.equal(r.purchases.taxable, 0, 'purchases dated yesterday are not in today')
  })

  it('lists a cancelled sale of an earlier period as a credit note, and drops one issued and cancelled in the same period', async () => {
    const sale = (await t.post(`${ph}/sales`, { items: [{ drugId, qty: 5 }], payment: { mode: 'cash' } })).body
    await t.post(`${ph}/sales/${sale.id}/cancel`, { reason: 'Returned' })
    const sameDay = (await t.get(`${ph}/reports/gstr1?from=${today}&to=${today}`)).body
    assert.equal(sameDay.totals.total, 340, 'issued and cancelled today: nets to nothing')
    assert.equal(sameDay.creditNotes.length, 0)
    assert.equal(sameDay.documents.cancelled, 1, 'but the cancelled document is counted')

    await t.inHospital(() => t.api.ctx.db.execute(`UPDATE "PharmacySale" SET "soldAt" = "soldAt" - interval '3 days' WHERE id = $1`, [sale.id]))
    const later = (await t.get(`${ph}/reports/gstr1?from=${today}&to=${today}`)).body
    assert.equal(later.creditNotes.length, 1, 'cancelled today, invoiced before the period')
    assert.equal(later.totals.total, 340 - 60)
    const earlier = (await t.get(`${ph}/reports/gstr1?from=${daysFromNow(-4)}&to=${daysFromNow(-2)}`)).body
    assert.equal(earlier.totals.total, 60, 'in its own period the invoice counted in full')
  })

  it('refuses a bad period and shows the pharmacy dashboard', async () => {
    assert.equal((await t.get(`${ph}/reports/gstr1?from=${today}&to=${daysFromNow(-3)}`)).status, 400)
    assert.equal((await t.get(`${ph}/reports/gstr1?from=bad&to=${today}`)).status, 400)
    const dash = (await t.get(`${ph}/dashboard`)).body
    assert.equal(dash.todayCounterSales.n, 2, 'the cancelled one is not counted')
    assert.ok(dash.stock.costValue > 0)
    assert.ok(dash.fastMoving.length > 0)
    assert.equal(dash.owedToSuppliers, 600 * 1.12 + 1200 * 1.05, 'what was bought and not yet paid')
  })
})

describe('The ward medicine round', () => {
  let t: TestApi
  let doctorId: string
  let bedA: string
  let stayId: string
  let rxId: string
  before(async () => {
    t = await startTestApi()
    ;({ doctorId, bedA } = await seedBasics(t))
    const patient = await newPatient(t, { name: 'Ward Round Patient' })
    stayId = (await t.post(`${api}/encounters/ipd`, { patientId: patient.id, department: 'Medicine', doctorId, bedId: bedA })).body.id
    rxId = (await t.post(`${api}/encounters/${stayId}/prescriptions`, { drugName: 'Paracetamol 500mg', dose: '1 tab', frequency: 'TDS', duration: '3 days' })).body.id
  })
  after(() => t.close())

  const wm = `${api}/ward-medicine`

  it('schedules a prescription at its usual times and lets the pharmacy see the course', async () => {
    const nurse = await t.as('nurse')
    const made = await nurse.post(`${wm}/${stayId}/schedules`, { prescriptionId: rxId, days: 3 })
    assert.equal(made.status, 201, JSON.stringify(made.body))
    assert.deepEqual(made.body.times, ['08:00', '14:00', '20:00'])
    assert.equal((await nurse.post(`${wm}/${stayId}/schedules`, { prescriptionId: rxId })).status, 409, 'one schedule per prescription')

    const queue = (await t.get(`${ph}/queue`)).body.find((q: any) => q.id === rxId)
    assert.deepEqual([queue.scheduledTimes, queue.suggestedQty], [['08:00', '14:00', '20:00'], 9], '3 times a day for 3 days')
  })

  it('creates doses only from now on, for today and tomorrow, and not twice', async () => {
    const view = (await (await t.as('nurse')).get(`${wm}/${stayId}`)).body
    assert.ok(view.doses.length >= 3 && view.doses.length <= 6, `${view.doses.length} doses`)
    assert.ok(view.doses.every((d: any) => new Date(d.dueAt).getTime() >= Date.now() - 60_000), 'times already past when the schedule was made are not overdue')
    const again = (await (await t.as('nurse')).get(`${wm}/${stayId}`)).body
    assert.equal(again.doses.length, view.doses.length)
  })

  it('lists the doses due on the round and records who gave, missed or held each one', async () => {
    const nurse = await t.as('nurse')
    const doses = (await nurse.get(`${wm}/${stayId}`)).body.doses as { id: string }[]
    await t.inHospital(async () => {
      const db = t.api.ctx.db
      await db.execute(`UPDATE "MedicationDose" SET "dueAt" = now() + interval '20 minutes' WHERE id = $1`, [doses[0]!.id])
      await db.execute(`UPDATE "MedicationDose" SET "dueAt" = now() + interval '40 minutes' WHERE id = $1`, [doses[1]!.id])
      await db.execute(`UPDATE "MedicationDose" SET "dueAt" = now() + interval '60 minutes' WHERE id = $1`, [doses[2]!.id])
    })
    // The schedule's own times (08:00, 14:00, 20:00) may also fall in the next two hours, whenever the test runs: look at these three only.
    const mine = new Set([doses[0]!.id, doses[1]!.id, doses[2]!.id])
    const ofMine = async () => ((await nurse.get(`${wm}/due?hours=2`)).body as { id: string; patientName: string; drugName: string; bed: string }[]).filter((d) => mine.has(d.id))
    const due = await ofMine()
    assert.deepEqual(due.map((d) => d.id), [doses[0]!.id, doses[1]!.id, doses[2]!.id], 'soonest first')
    assert.deepEqual([due[0]!.patientName, due[0]!.drugName, due[0]!.bed], ['Ward Round Patient', 'Paracetamol 500mg', 'Ward A A-01'])

    const given = await nurse.post(`${wm}/doses/${doses[0]!.id}/give`, {})
    assert.equal(given.status, 200, JSON.stringify(given.body))
    assert.deepEqual([given.body.status, given.body.actedBy], ['given', 'Test nurse'])
    assert.equal((await nurse.post(`${wm}/doses/${doses[1]!.id}/miss`, {})).status, 400, 'a reason is needed')
    assert.equal((await nurse.post(`${wm}/doses/${doses[1]!.id}/miss`, { note: 'Patient was in the scan room' })).body.status, 'missed')
    assert.equal((await nurse.post(`${wm}/doses/${doses[2]!.id}/hold`, { note: 'Doctor asked to hold' })).body.status, 'held')
    assert.equal((await nurse.post(`${wm}/doses/${doses[0]!.id}/give`, {})).status, 409, 'a dose is marked once')
    assert.equal((await ofMine()).length, 0, 'done doses leave the round')
  })

  it('stops a schedule, removing doses not yet due, and is for the ward and doctors only', async () => {
    const nurse = await t.as('nurse')
    const schedule = (await nurse.get(`${wm}/${stayId}`)).body.schedules[0]
    assert.equal((await (await t.as('pharmacist')).get(`${wm}/${stayId}`)).status, 403)
    assert.equal((await (await t.as('biller')).get(`${wm}/due`)).status, 403)
    assert.equal((await nurse.post(`${wm}/schedules/${schedule.id}/stop`, {})).status, 200)
    const view = (await nurse.get(`${wm}/${stayId}`)).body
    assert.ok(view.doses.every((d: any) => d.status !== 'due'), 'nothing is left due')
    assert.equal(view.schedules[0].status, 'stopped')
    assert.equal((await nurse.post(`${wm}/schedules/${schedule.id}/stop`, {})).status, 409)
  })

  it('refuses a frequency that does not say when, unless the times are given, and a patient who has gone home', async () => {
    const nurse = await t.as('nurse')
    const sos = (await t.post(`${api}/encounters/${stayId}/prescriptions`, { drugName: 'Diclofenac 50mg', dose: '1 tab', frequency: 'SOS', duration: '2 days' })).body.id
    assert.equal((await nurse.post(`${wm}/${stayId}/schedules`, { prescriptionId: sos })).status, 400)
    assert.equal((await nurse.post(`${wm}/${stayId}/schedules`, { prescriptionId: sos, times: ['10:00', '22:00'] })).status, 201)
    assert.equal((await t.post(`${api}/encounters/${stayId}/discharge`, { summary: 'Fine.' })).status, 200)
    const rx2 = (await t.get(`${api}/encounters/${stayId}`)).body.prescriptions[0].id
    assert.equal((await nurse.post(`${wm}/${stayId}/schedules`, { prescriptionId: rx2 })).status, 409)
    assert.equal(((await nurse.get(`${wm}/due?hours=24`)).body as unknown[]).length, 0, 'no doses for a discharged patient')
  })
})
