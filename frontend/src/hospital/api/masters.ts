import { api } from './client.ts'

/** The hospital's own billing and print settings (Masters > Settings). */
export interface HospitalSettings {
  opdDefaultFee: number
  erFee: number
  unlistedTestPrice: number
  unlistedMedicinePrice: number
  medicineGstPct: number
  bedDayCheckoutHour: number
  gstin: string
  registrationNo: string
  drugLicenseNo: string
  /** A lab or radiology report must be signed by someone other than the person who entered the results. */
  requireReportVerification: boolean
  consentText: string
  billFooter: string
}

export const fetchSettings = () => api<HospitalSettings>('/masters/settings')
export const saveSettings = (change: Partial<HospitalSettings>) => api<HospitalSettings>('/masters/settings', { method: 'PUT', body: change })

export type ServiceCategory = 'bed' | 'nursing' | 'procedure' | 'doctor_visit' | 'consultation' | 'package' | 'other'

export const SERVICE_CATEGORY_LABEL: Record<ServiceCategory, string> = {
  bed: 'Bed charge',
  nursing: 'Nursing',
  procedure: 'Procedure',
  doctor_visit: 'Doctor visit',
  consultation: 'Consultation',
  package: 'Package',
  other: 'Other',
}

export interface Service {
  id: string
  code: string
  name: string
  category: ServiceCategory
  ward: string | null
  price: number
  gstPct: number
  active: boolean
}

export interface ServiceInput { code: string; name: string; category: ServiceCategory; price: number; gstPct: number; active: boolean }

export const fetchServices = (opts: { all?: boolean; search?: string } = {}) =>
  api<Service[]>(`/masters/services?all=${opts.all ? 'true' : 'false'}${opts.search ? `&search=${encodeURIComponent(opts.search)}` : ''}`)
export const createService = (input: ServiceInput) => api<Service>('/masters/services', { method: 'POST', body: input })
export const updateService = (id: string, change: Partial<ServiceInput>) => api<Service>(`/masters/services/${id}`, { method: 'PATCH', body: change })

export interface Ward { ward: string; beds: number; serviceId: string | null; dailyRate: number | null; gstPct: number; active: boolean | null }
export const fetchWards = () => api<Ward[]>('/masters/wards')
export const saveWardRate = (ward: string, price: number, gstPct: number) => api<Service>('/masters/wards', { method: 'PUT', body: { ward, price, gstPct } })

export interface Parameter { id?: string; name: string; unit: string | null; refLow: number | null; refHigh: number | null; refText: string | null; criticalLow?: number | null; criticalHigh?: number | null }
export interface Investigation {
  id: string
  code: string
  name: string
  kind: 'lab' | 'radiology'
  section: string | null
  sample: string | null
  tatHours: number | null
  price: number
  gstPct: number
  active: boolean
}
export interface InvestigationDetail extends Investigation { parameters: Parameter[] }
export interface InvestigationInput {
  code: string
  name: string
  kind: 'lab' | 'radiology'
  section: string | null
  sample: string | null
  tatHours: number | null
  price: number
  gstPct: number
  active: boolean
  parameters: Omit<Parameter, 'id'>[]
}

export const fetchInvestigations = (opts: { all?: boolean; search?: string; kind?: 'lab' | 'radiology' } = {}) =>
  api<Investigation[]>(`/masters/investigations?all=${opts.all ? 'true' : 'false'}${opts.search ? `&search=${encodeURIComponent(opts.search)}` : ''}${opts.kind ? `&kind=${opts.kind}` : ''}`)
export const fetchInvestigation = (id: string) => api<InvestigationDetail>(`/masters/investigations/${id}`)
export const createInvestigation = (input: InvestigationInput) => api<InvestigationDetail>('/masters/investigations', { method: 'POST', body: input })
export const updateInvestigation = (id: string, change: Partial<InvestigationInput>) => api<InvestigationDetail>(`/masters/investigations/${id}`, { method: 'PATCH', body: change })

export interface PanelItemRates {
  services: { id: string; code: string; name: string; category: string; price: number; rate: number | null }[]
  investigations: { id: string; code: string; name: string; kind: string; price: number; rate: number | null }[]
}
export const fetchPanelItemRates = (panelId: string) => api<PanelItemRates>(`/masters/panels/${panelId}/item-rates`)
export const savePanelItemRates = (panelId: string, rates: { kind: 'service' | 'investigation'; itemId: string; rate: number }[]) =>
  api<{ saved: number }>(`/masters/panels/${panelId}/item-rates`, { method: 'PUT', body: { rates } })

export interface TemplateItem { drugName: string; dose: string; frequency: string; duration: string }
export interface RxTemplate { id: string; name: string; diagnosis: string | null; items: TemplateItem[]; shared: boolean; ownerId: string | null; ownerName: string | null }
export const fetchTemplates = () => api<RxTemplate[]>('/masters/rx-templates')
export const saveTemplate = (input: { name: string; diagnosis: string | null; items: TemplateItem[]; shared: boolean }, id?: string) =>
  api<RxTemplate>(id ? `/masters/rx-templates/${id}` : '/masters/rx-templates', { method: id ? 'PUT' : 'POST', body: input })
export const deleteTemplate = (id: string) => api<null>(`/masters/rx-templates/${id}`, { method: 'DELETE' })
