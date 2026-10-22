import { api, openFile, uploadFile } from './client.ts'
import type { PaymentMode } from './opdBilling.ts'

/** Laboratory and radiology: the worklist, sample and result steps, signed reports, lab-desk invoices and the management figures. */

export type OrderStatus = 'ordered' | 'sample_collected' | 'in_progress' | 'resulted' | 'completed' | 'cancelled'
export type Flag = 'normal' | 'low' | 'high' | 'critical_low' | 'critical_high' | 'abnormal'

export const STATUS_LABEL: Record<OrderStatus, string> = {
  ordered: 'Ordered',
  sample_collected: 'Sample collected',
  in_progress: 'In progress',
  resulted: 'Awaiting signature',
  completed: 'Report ready',
  cancelled: 'Cancelled',
}
export const STATUS_TONE: Record<OrderStatus, 'neutral' | 'warn' | 'ok' | 'danger'> = {
  ordered: 'neutral', sample_collected: 'warn', in_progress: 'warn', resulted: 'warn', completed: 'ok', cancelled: 'danger',
}
export const FLAG_LABEL: Record<Flag, string> = { normal: '', low: 'L', high: 'H', critical_low: 'LL', critical_high: 'HH', abnormal: 'Abn' }
export const isCriticalFlag = (flag: Flag | null) => flag === 'critical_low' || flag === 'critical_high'

export interface WorkRow {
  id: string
  kind: 'lab' | 'radiology'
  name: string
  status: OrderStatus
  accessionNo: string | null
  createdAt: string
  collectedAt: string | null
  collectedBy: string | null
  signedAt: string | null
  signedBy: string | null
  critical: boolean
  criticalAckAt: string | null
  amendedCount: number
  testCode: string | null
  section: string | null
  sample: string | null
  tatHours: number | null
  overdue: boolean
  encounterId: string | null
  encounterType: string | null
  department: string | null
  orderedBy: string | null
  invoiceNo: string | null
  patientId: string
  patientName: string
  mrn: string
  yearOfBirth: number | null
  gender: string
  phone: string | null
}
export interface WorkCounts { ordered: number; inProgress: number; awaitingSignature: number; overdue: number; criticalUnacknowledged: number }

export interface WorklistFilter { status?: string; kind?: 'lab' | 'radiology'; source?: 'visit' | 'desk'; overdue?: boolean; from?: string; to?: string; search?: string }
export function fetchWorklist(f: WorklistFilter = {}) {
  const q = new URLSearchParams()
  if (f.status) q.set('status', f.status)
  if (f.kind) q.set('kind', f.kind)
  if (f.source) q.set('source', f.source)
  if (f.overdue) q.set('overdue', 'true')
  if (f.from) q.set('from', f.from)
  if (f.to) q.set('to', f.to)
  if (f.search?.trim()) q.set('search', f.search.trim())
  return api<{ orders: WorkRow[]; counts: WorkCounts }>(`/lab/orders?${q.toString()}`)
}

export interface FormRow {
  parameterId: string | null
  name: string
  unit: string | null
  refLow: number | null
  refHigh: number | null
  refText: string | null
  criticalLow: number | null
  criticalHigh: number | null
  value: string
  flag: Flag | null
}
export interface ResultLine {
  id: string
  name: string
  unit: string | null
  refLow: number | null
  refHigh: number | null
  refText: string | null
  valueText: string
  flag: Flag | null
}
export interface Attachment { id: string; orderId: string; title: string; fileName: string; contentType: string; sizeBytes: number; uploadedBy: string; uploadedAt: string }
export interface Amendment { id: string; reason: string; amendedBy: string; amendedAt: string }
export interface OrderDetail extends WorkRow {
  sampleNote: string | null
  resultedAt: string | null
  resultedBy: string | null
  remarks: string | null
  findings: string | null
  impression: string | null
  criticalAckBy: string | null
  cancelReason: string | null
  cancelledBy: string | null
  referredBy: string | null
  form: FormRow[]
  results: ResultLine[]
  attachments: Attachment[]
  amendments: Amendment[]
}
export interface Report extends OrderDetail { signer: { id: string; name: string; hprId: string | null; department: string } | null }

export const fetchOrder = (id: string) => api<OrderDetail>(`/lab/orders/${id}`)
export const fetchReport = (id: string) => api<Report>(`/lab/orders/${id}/report`)
export const collect = (id: string, note?: string) => api<OrderDetail>(`/lab/orders/${id}/collect`, { method: 'POST', body: note ? { note } : {} })
export const rejectSample = (id: string, reason: string) => api<OrderDetail>(`/lab/orders/${id}/reject-sample`, { method: 'POST', body: { reason } })
export const saveResults = (id: string, results: { parameterId?: string; name?: string; value: string; abnormal?: boolean }[], remarks: string) =>
  api<OrderDetail>(`/lab/orders/${id}/results`, { method: 'PUT', body: { results, ...(remarks.trim() ? { remarks: remarks.trim() } : {}) } })
export const saveWrittenReport = (id: string, findings: string, impression: string) => api<OrderDetail>(`/lab/orders/${id}/report`, { method: 'PUT', body: { findings, impression } })
export const signReport = (id: string) => api<OrderDetail>(`/lab/orders/${id}/sign`, { method: 'POST', body: {} })
export const amendReport = (id: string, reason: string) => api<OrderDetail>(`/lab/orders/${id}/amend`, { method: 'POST', body: { reason } })
export const cancelTest = (id: string, reason: string) => api<OrderDetail>(`/lab/orders/${id}/cancel`, { method: 'POST', body: { reason } })
export const acknowledgeCritical = (id: string) => api<OrderDetail>(`/lab/orders/${id}/acknowledge-critical`, { method: 'POST', body: {} })
export const fetchCritical = () => api<{ id: string; name: string; accessionNo: string; signedAt: string; patientId: string; patientName: string; mrn: string; encounterId: string | null; orderedBy: string | null }[]>('/lab/critical')
export const removeAttachment = (id: string, reason: string) => api(`/lab/attachments/${id}/remove`, { method: 'POST', body: { reason } })

/** The file travels as the request body; its details go in the address. */
export const uploadAttachment = (orderId: string, file: File, title: string) =>
  uploadFile<Attachment>(`/lab/orders/${orderId}/attachments?title=${encodeURIComponent(title)}&fileName=${encodeURIComponent(file.name)}`, file)

/** Opens a stored image in a new tab. */
export const openAttachment = (id: string) => openFile(`/lab/attachments/${id}/file`, 'The image could not be opened')

// ---- Lab-desk invoices ---------------------------------------------------------------------------------------------------------------
export interface InvoiceItem { id: string; orderId: string; name: string; standardRate: number; rate: number; gstPct: number; amount: number; status: OrderStatus; accessionNo: string | null }
export interface LabInvoice {
  id: string
  invoiceNo: string
  patientId: string
  patientName: string
  mrn: string
  yearOfBirth: number | null
  gender: string
  phone: string | null
  panelId: string | null
  panelName: string | null
  beneficiaryId: string | null
  discountPct: number
  subtotal: number
  discount: number
  gstTotal: number
  total: number
  paymentMode: PaymentMode
  paymentReference: string | null
  amountReceived: number | null
  referredBy: string | null
  status: 'paid' | 'cancelled'
  createdBy: string
  createdAt: string
  cancelledAt: string | null
  cancelReason: string | null
  cancelledBy: string | null
  items: InvoiceItem[]
  change: number | null
}
export interface NewInvoice {
  patientId: string
  tests: { investigationId: string }[]
  panelId?: string
  beneficiaryId?: string
  discountPct: number
  referredBy?: string
  payment: { mode: PaymentMode; reference?: string; amountReceived?: number }
}
export const createInvoice = (input: NewInvoice) => api<LabInvoice>('/lab/invoices', { method: 'POST', body: input })
export const fetchInvoice = (id: string) => api<LabInvoice>(`/lab/invoices/${id}`)
export const cancelInvoice = (id: string, reason: string) => api<LabInvoice>(`/lab/invoices/${id}/cancel`, { method: 'POST', body: { reason } })
export const fetchInvoices = (f: { from?: string; to?: string; search?: string; status?: 'paid' | 'cancelled' } = {}) => {
  const q = new URLSearchParams()
  if (f.from) q.set('from', f.from)
  if (f.to) q.set('to', f.to)
  if (f.status) q.set('status', f.status)
  if (f.search?.trim()) q.set('search', f.search.trim())
  return api<{ invoices: (LabInvoice & { itemCount: number })[]; totals: { count: number; total: number } }>(`/lab/invoices?${q.toString()}`)
}

// ---- Management figures --------------------------------------------------------------------------------------------------------------
export interface TestFigures {
  investigationId: string | null
  name: string
  kind: 'lab' | 'radiology'
  section: string | null
  tatHours: number | null
  ordered: number
  completed: number
  avgTatHours: number | null
  withTarget: number
  withinTarget: number
  withinTargetPct: number | null
  visitValue: number
  deskCollected: number
}
export interface Summary {
  period: { from: string; to: string }
  totals: { ordered: number; completed: number; cancelled: number; pending: number; overdue: number; critical: number; amended: number; criticalWaiting: number }
  tests: TestFigures[]
  sections: { section: string; kind: string; ordered: number; completed: number; visitValue: number; deskCollected: number }[]
  desk: { count: number; total: number; cancelled: number }
}
export const fetchSummary = (from: string, to: string, kind?: 'lab' | 'radiology') =>
  api<Summary>(`/lab/reports/summary?from=${from}&to=${to}${kind ? `&kind=${kind}` : ''}`)

export interface Quote {
  panelName: string | null
  subtotal: number
  discount: number
  gstTotal: number
  total: number
  lines: { investigationId: string; name: string; standardRate: number; rate: number; gstPct: number; amount: number }[]
}
export const quoteInvoice = (input: Pick<NewInvoice, 'tests' | 'panelId' | 'beneficiaryId' | 'discountPct'>) => api<Quote>('/lab/invoices/quote', { method: 'POST', body: input })
