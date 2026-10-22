import { api } from './client.ts'
import type { PaymentMode } from './opdBilling.ts'

/** Pharmacy: items, batch-wise stock, suppliers and purchases, counter sales, the dispense queue, reports and the ward medicine round. */

export interface DrugItem {
  id: string
  name: string
  unit: string
  reorderLevel: number
  /** The MRP of the batch that will be sold next (or the item's default). */
  mrp: number
  defaultMrp: number
  gstPct: number
  hsnCode: string
  stock: number
  expiredQty: number
  batch: string | null
  expiry: string | null
  batches: number
}

export const fetchItems = (search?: string) => api<DrugItem[]>(`/pharmacy/drugs${search ? `?search=${encodeURIComponent(search)}` : ''}`)
export const createItem = (input: { name: string; unit: string; reorderLevel: number; mrp: number; gstPct: number; hsnCode: string }) => api<DrugItem>('/pharmacy/drugs', { method: 'POST', body: input })
export const updateItem = (id: string, change: Partial<{ name: string; unit: string; reorderLevel: number; mrp: number; gstPct: number; hsnCode: string }>) => api<DrugItem>(`/pharmacy/drugs/${id}`, { method: 'PATCH', body: change })

export interface StockBatch {
  batchId: string
  drugId: string
  name: string
  unit: string
  batchNo: string
  expiry: string
  qty: number
  mrp: number
  purchaseRate: number | null
  costValue: number | null
  mrpValue: number
  state: 'expired' | 'near' | 'ok'
}
export interface StockReport {
  batches: StockBatch[]
  totals: { units: number; costValue: number; unknownCostUnits: number; mrpValue: number; expiredUnits: number; expiredValue: number; nearExpiryUnits: number }
}
export const fetchStock = (includeEmpty = false) => api<StockReport>(`/pharmacy/stock?includeEmpty=${includeEmpty}`)
export const adjustBatch = (batchId: string, delta: number, reason: string) => api(`/pharmacy/batches/${batchId}/adjust`, { method: 'POST', body: { delta, reason } })

export interface LedgerRow { id: number; at: string; drugName: string; batchNo: string; delta: number; kind: string; reason: string | null; by: string }
export const fetchLedger = (drugId?: string) => api<LedgerRow[]>(`/pharmacy/stock-ledger${drugId ? `?drugId=${drugId}` : ''}`)

export interface Dashboard {
  todayCounterSales: { n: number; total: number }
  todayDispensed: { n: number; total: number }
  prescriptionsWaiting: number
  lowStock: { id: string; name: string; unit: string; reorderLevel: number; stock: number }[]
  stock: StockReport['totals']
  fastMoving: { drugName: string; qty: number; total: number }[]
  lastSevenDays: { day: string; total: number }[]
  owedToSuppliers: number
}
export const fetchDashboard = () => api<Dashboard>('/pharmacy/dashboard')

// ---- Suppliers and purchases ----
export interface Supplier { id: string; name: string; gstin: string | null; phone: string | null; address: string | null; drugLicense: string | null; active: boolean }
export const fetchSuppliers = (all = false) => api<Supplier[]>(`/pharmacy/suppliers?all=${all}`)
export const saveSupplier = (input: Partial<Omit<Supplier, 'id'>> & { name?: string }, id?: string) =>
  api<Supplier>(id ? `/pharmacy/suppliers/${id}` : '/pharmacy/suppliers', { method: id ? 'PATCH' : 'POST', body: input })

export interface PurchaseLineInput {
  drugId?: string
  newDrug?: { name: string; unit: string; reorderLevel: number; gstPct: number; hsnCode?: string; mrp: number }
  batchNo: string
  expiry: string
  qty: number
  freeQty: number
  purchaseRate: number
  mrp: number
  gstPct?: number
}
export interface PurchaseInput {
  supplierId: string
  supplierInvoiceNo: string
  invoiceDate: string
  notes?: string
  payment?: { amount: number; mode: 'cash' | 'upi' | 'card' | 'bank' | 'other'; reference?: string }
  items: PurchaseLineInput[]
}
export interface PurchaseRow {
  id: string
  purchaseNo: string
  supplierId: string
  supplierName: string
  supplierInvoiceNo: string
  invoiceDate: string
  taxable: number
  gstTotal: number
  total: number
  amountPaid: number
  due: number
  status: 'received' | 'cancelled'
  cancelReason: string | null
  createdBy: string
}
export interface PurchaseDetail extends PurchaseRow {
  items: { id: string; drugName: string; batchNo: string; expiry: string; qty: number; freeQty: number; purchaseRate: number; mrp: number; gstPct: number; taxable: number; gstAmount: number }[]
}
export const fetchPurchases = (opts: { unpaid?: boolean; from?: string; to?: string } = {}) =>
  api<{ purchases: PurchaseRow[]; totals: { count: number; taxable: number; gst: number; total: number; due: number } }>(
    `/pharmacy/purchases?unpaid=${opts.unpaid ?? false}${opts.from ? `&from=${opts.from}` : ''}${opts.to ? `&to=${opts.to}` : ''}`,
  )
export const fetchPurchase = (id: string) => api<PurchaseDetail>(`/pharmacy/purchases/${id}`)
export const createPurchase = (input: PurchaseInput) => api<PurchaseDetail>('/pharmacy/purchases', { method: 'POST', body: input })
export const cancelPurchase = (id: string, reason: string) => api<PurchaseDetail>(`/pharmacy/purchases/${id}/cancel`, { method: 'POST', body: { reason } })
export const paySupplier = (id: string, payment: { amount: number; mode: 'cash' | 'upi' | 'card' | 'bank' | 'other'; reference?: string }) =>
  api<PurchaseDetail>(`/pharmacy/purchases/${id}/payment`, { method: 'POST', body: payment })

// ---- Sales ----
export interface SaleItem {
  id: string
  drugName: string
  batchNo: string | null
  expiry: string | null
  hsnCode: string
  qty: number
  mrp: number
  gstPct: number
  lineTotal: number
  taxable: number
  tax: number
}
export interface TaxRow { gstPct: number; taxable: number; cgst: number; sgst: number; total: number }
export interface SaleRow {
  id: string
  kind: 'counter' | 'encounter'
  invoiceNo: string
  patientName: string | null
  mrn: string | null
  customerName: string | null
  customerPhone: string | null
  discountPct: number
  taxable: number
  tax: number
  total: number
  paymentMode: PaymentMode | null
  paymentReference: string | null
  amountReceived: number | null
  status: 'paid' | 'cancelled'
  soldBy: string
  soldAt: string
  cancelledAt: string | null
  cancelReason: string | null
  cancelledBy: string | null
  itemCount?: number
}
export interface SaleDetail extends SaleRow { items: SaleItem[]; taxSummary: TaxRow[]; change: number | null }
export interface CounterSaleInput {
  patientId?: string
  customerName?: string
  customerPhone?: string
  discountPct: number
  items: { drugId: string; qty: number; batchId?: string }[]
  payment: { mode: PaymentMode; reference?: string; amountReceived?: number }
}
export const fetchSales = (opts: { from?: string; to?: string; kind?: 'counter' | 'encounter'; search?: string } = {}) =>
  api<{ sales: SaleRow[]; totals: { count: number; taxable: number; tax: number; total: number } }>(
    `/pharmacy/sales?limit=200${opts.from ? `&from=${opts.from}` : ''}${opts.to ? `&to=${opts.to}` : ''}${opts.kind ? `&kind=${opts.kind}` : ''}${opts.search ? `&search=${encodeURIComponent(opts.search)}` : ''}`,
  )
export const fetchSale = (id: string) => api<SaleDetail>(`/pharmacy/sales/${id}`)
export const createSale = (input: CounterSaleInput) => api<SaleDetail>('/pharmacy/sales', { method: 'POST', body: input })
export const cancelSale = (id: string, reason: string) => api<SaleDetail>(`/pharmacy/sales/${id}/cancel`, { method: 'POST', body: { reason } })

// ---- Dispense queue ----
export interface QueueRow {
  id: string
  drugName: string
  dose: string
  frequency: string
  duration: string
  encounterId: string
  encounterType: string
  patientId: string
  patientName: string
  mrn: string
  stock: number | null
  unit: string | null
  mrp: number | null
  listed: boolean
  scheduledTimes: string[] | null
  suggestedQty: number | null
}
export const fetchQueue = () => api<QueueRow[]>('/pharmacy/queue')
export const dispense = (prescriptionId: string, quantity: number) =>
  api<{
    prescriptionId: string; drugName: string; quantity: number; saleId: string; invoiceNo: string; stockUpdated: boolean; remainingStock: number | null
    /** The visit's bill the medicine went on, when the visit had already closed; billFinalised when that bill could no longer change. */
    billNo: string | null; billFinalised: boolean
  }>(
    `/pharmacy/prescriptions/${prescriptionId}/dispense`, { method: 'POST', body: { quantity } },
  )

// ---- Reports ----
export interface Gstr1 {
  from: string
  to: string
  b2cByRate: { gstPct: number; taxable: number; tax: number; total: number; cgst: number; sgst: number }[]
  hsn: { hsnCode: string; description: string; uqc: string; gstPct: number; qty: number; taxable: number; tax: number; total: number; cgst: number; sgst: number }[]
  creditNotes: { invoiceNo: string; soldAt: string; cancelledAt: string; taxable: number; tax: number; total: number }[]
  documents: { issued: number; cancelled: number; first: string | null; last: string | null }
  inputTax: { gstPct: number; taxable: number; gst: number }[]
  totals: { taxable: number; tax: number; cgst: number; sgst: number; total: number; inputTax: number }
}
export interface ProfitLoss {
  from: string
  to: string
  revenue: number
  taxCollected: number
  salesIncludingTax: number
  revenueByKind: { counter: number; encounter: number }
  costOfGoodsSold: number
  revenueWithoutKnownCost: number
  grossProfit: number
  marginPct: number | null
  purchases: { taxable: number; gst: number }
  byItem: { drugName: string; qty: number; revenue: number; cost: number; unknownCost: number; profit: number }[]
}
export const fetchGstr1 = (from: string, to: string) => api<Gstr1>(`/pharmacy/reports/gstr1?from=${from}&to=${to}`)
export const fetchProfitLoss = (from: string, to: string) => api<ProfitLoss>(`/pharmacy/reports/profit-loss?from=${from}&to=${to}`)

// ---- The ward medicine round ----
export interface Dose {
  id: string
  scheduleId: string
  dueAt: string
  status: 'due' | 'given' | 'missed' | 'held'
  actedAt: string | null
  actedBy: string | null
  note: string | null
  encounterId: string
  prescriptionId: string
  instructions: string | null
  drugName: string
  dose: string
  frequency: string
  patientId: string
  patientName: string
  mrn: string
  bed: string | null
}
export interface Schedule { id: string; prescriptionId: string; times: string[]; startDate: string; endDate: string | null; instructions: string | null; status: 'active' | 'stopped'; drugName: string; dose: string; frequency: string }
export const fetchDueDoses = (hours = 6) => api<Dose[]>(`/ward-medicine/due?hours=${hours}`)
export const fetchWardMedicine = (encounterId: string) => api<{ schedules: Schedule[]; doses: Dose[] }>(`/ward-medicine/${encounterId}`)
export const createSchedule = (encounterId: string, input: { prescriptionId: string; times?: string[]; days?: number; instructions?: string }) =>
  api<{ ok: true; times: string[] }>(`/ward-medicine/${encounterId}/schedules`, { method: 'POST', body: input })
export const stopSchedule = (id: string) => api<{ ok: true }>(`/ward-medicine/schedules/${id}/stop`, { method: 'POST', body: {} })
export const actOnDose = (id: string, action: 'give' | 'miss' | 'hold', note?: string) => api<Dose>(`/ward-medicine/doses/${id}/${action}`, { method: 'POST', body: note ? { note } : {} })
