import { api } from './client.ts'

/** The facility's own profile (name, address, and the ids ABDM assigns once it is registered). */
export interface FacilityProfile {
  name: string
  hfrId: string | null
  hipId: string | null
  facilityType: string | null
  address: string | null
  state: string | null
  district: string | null
  pincode: string | null
  phone: string | null
  email: string | null
}

export const fetchFacility = () => api<FacilityProfile>('/facility')
export const saveFacility = (profile: FacilityProfile) => api<FacilityProfile>('/facility', { method: 'PUT', body: profile })
