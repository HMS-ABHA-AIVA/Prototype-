import { api, openFile, uploadFile } from './client.ts'
import type { PaymentMode } from './opdBilling.ts'

export type LineSource = 'bed' | 'service' | 'custom' | 'investigation' | 'medicine'

export interface BillLine {
  id: string | null
  source: LineSource
  date: string | null
  description: string
  qty: number
  rate: number
  standardRate: number
  gstPct: number
  amount: number
  serviceId: string | null
  voided: boolean
  voidReason: string | null
  postedBy: string | null
}

export interface Receipt {
  id: string
  receiptNo: string
  encounterId: string
  kind: 'advance' | 'refund' | 'settlement'
  amount: number
  mode: PaymentMode
  reference: string | null
  note: string | null
  billId: string | null
  receivedBy: string
  at: string
  cancelled: boolean
  cancelReason: string | null
  cancelledBy: string | null
}

export interface RunningBill {
  encounterId: string
  encounterType: 'OPD' | 'IPD' | 'ER'
  status: string
  patient: { id: string; mrn: string; name: string; yearOfBirth: number | null; gender: string; phone: string | null }
  doctorName: string | null
  department: string
  admittedAt: string | null
  dischargedAt: string | null
  bed: { ward: string; bedNo: string } | null
  panel: { id: string; code: string; name: string } | null
  beneficiaryId: string | null
  lines: BillLine[]
  subtotal: number
  gstTotal: number
  total: number
  payments: Receipt[]
  advancesHeld: number
  balance: number
  warnings: string[]
  bill: { id: string; billNo: string; status: string } | null
}

export interface AdmissionRow {
  encounterId: string
  status: string
  admittedAt: string | null
  dischargedAt: string | null
  department: string
  panelId: string | null
  panelCode: string | null
  patientId: string
  patientName: string
  mrn: string
  doctorName: string | null
  ward: string | null
  bedNo: string | null
  advancesHeld: number
  billId: string | null
  billNo: string | null
  billStatus: 'draft' | 'finalized' | 'paid' | 'void' | null
}

export interface ChargeInput {
  serviceId?: string
  description?: string
  qty: number
  rate?: number
  gstPct?: number
  rateNote?: string
  date?: string
}

export interface FinalBill {
  id: string
  billNo: string
  encounterId: string
  patientId: string
  status: 'draft' | 'finalized' | 'paid' | 'void'
  kind: 'opd_fee' | 'final'
  paymentMode: PaymentMode | null
  paidAt: string | null
  panelName: string | null
  beneficiaryId: string | null
  discountType: 'percent' | 'amount' | null
  discountValue: number | null
  discountReason: string | null
  createdAt: string
  items: { id: string; label: string; qty: number; rate: number; gstPct: number; amount: number; isDiscount: boolean }[]
  subtotal: number
  gstTotal: number
  total: number
  discountAmount: number
  advancesHeld: number
  balance: number
  settlement: Receipt[]
}

export interface DiscountInput { type: 'percent' | 'amount'; value: number; reason: string }

const bill = (encounterId: string) => `/ipd-billing/${encounterId}`

export const fetchAdmissions = () => api<AdmissionRow[]>('/ipd-billing?status=all')
export const fetchRunningBill = (encounterId: string) => api<RunningBill>(bill(encounterId))
export const addCharge = (encounterId: string, input: ChargeInput) => api<RunningBill>(`${bill(encounterId)}/charges`, { method: 'POST', body: input })
export const voidCharge = (encounterId: string, chargeId: string, reason: string) => api<RunningBill>(`${bill(encounterId)}/charges/${chargeId}/void`, { method: 'POST', body: { reason } })
export const setBillingCategory = (encounterId: string, panelId: string | null, beneficiaryId: string | undefined, reprice: boolean) =>
  api<RunningBill>(`${bill(encounterId)}/billing`, { method: 'PUT', body: { panelId, beneficiaryId, reprice } })
export const takeAdvance = (encounterId: string, input: { amount: number; mode: PaymentMode; reference?: string; note?: string }) =>
  api<{ receipt: Receipt; bill: RunningBill }>(`${bill(encounterId)}/advances`, { method: 'POST', body: input })
export const refundAdvance = (encounterId: string, input: { amount: number; mode: PaymentMode; reference?: string; reason: string }) =>
  api<{ receipt: Receipt; bill: RunningBill }>(`${bill(encounterId)}/refunds`, { method: 'POST', body: input })
export const cancelAdvance = (encounterId: string, paymentId: string, reason: string) =>
  api<RunningBill>(`${bill(encounterId)}/payments/${paymentId}/cancel`, { method: 'POST', body: { reason } })
export const prepareFinalBill = (encounterId: string, discount?: DiscountInput | null) =>
  api<FinalBill>(`${bill(encounterId)}/final-bill`, { method: 'POST', body: discount === undefined ? {} : { discount } })

export const fetchBill = (billId: string) => api<FinalBill>(`/bills/${billId}`)
export const setBillDiscount = (billId: string, discount: DiscountInput | null) =>
  api<FinalBill>(`/bills/${billId}/discount`, { method: 'POST', body: discount ?? { clear: true } })
export const finalizeFinalBill = (billId: string) => api<FinalBill>(`/bills/${billId}/finalize`, { method: 'POST', body: {} })
export const payFinalBill = (billId: string, input: { paymentMode: PaymentMode; reference?: string; amountReceived?: number }) =>
  api<FinalBill>(`/bills/${billId}/pay`, { method: 'POST', body: input })

// ---- Beds ----
export const reserveBed = (bedId: string, input: { patientId?: string; reservedFor?: string; until?: string; note?: string }) =>
  api(`/beds/${bedId}/reserve`, { method: 'POST', body: input })
export const clearReservation = (bedId: string) => api(`/beds/${bedId}/clear-reservation`, { method: 'POST', body: {} })

// ---- Births ----
export interface Birth {
  id: string
  birthNo: string
  motherEncounterId: string
  motherPatientId: string
  motherName: string
  motherMrn: string
  babyName: string | null
  gender: 'M' | 'F' | 'O'
  bornAt: string
  weightGrams: number | null
  deliveryType: 'normal' | 'caesarean' | 'assisted' | 'other'
  fatherName: string | null
  attendedBy: string | null
  notes: string | null
  recordedBy: string
}
export interface BirthInput {
  babyName?: string
  gender: 'M' | 'F' | 'O'
  bornAt?: string
  weightGrams?: number
  deliveryType: Birth['deliveryType']
  fatherName?: string
  attendedBy?: string
  notes?: string
}
export const fetchBirths = (encounterId: string) => api<Birth[]>(`/ipd/${encounterId}/births`)
export const recordBirth = (encounterId: string, input: BirthInput) => api<Birth>(`/ipd/${encounterId}/births`, { method: 'POST', body: input })

// ---- Documents ----
export type DocumentKind = 'consent' | 'report' | 'scan' | 'prescription' | 'other'
export const DOCUMENT_KIND_LABEL: Record<DocumentKind, string> = { consent: 'Consent form', report: 'Report', scan: 'Scan / image', prescription: 'Outside prescription', other: 'Other' }
export interface EncounterDocument {
  id: string
  encounterId: string
  kind: DocumentKind
  title: string
  fileName: string
  contentType: string
  sizeBytes: number
  uploadedBy: string
  uploadedAt: string
  removed: boolean
  removeReason: string | null
}
export const fetchDocuments = (encounterId: string) => api<EncounterDocument[]>(`/ipd/${encounterId}/documents`)
export const removeDocument = (id: string, reason: string) => api<EncounterDocument>(`/ipd/documents/${id}/remove`, { method: 'POST', body: { reason } })

/** The file travels as the request body; its details go in the address. */
export const uploadDocument = (encounterId: string, file: File, details: { kind: DocumentKind; title: string }) =>
  uploadFile<EncounterDocument>(`/ipd/${encounterId}/documents?kind=${details.kind}&title=${encodeURIComponent(details.title)}&fileName=${encodeURIComponent(file.name)}`, file)

/** Opens a stored document in a new tab. */
export const openDocument = (id: string) => openFile(`/ipd/documents/${id}/file`, 'The document could not be opened')
