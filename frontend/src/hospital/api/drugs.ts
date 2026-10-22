import { api } from './client.ts'

/** Medicine search and checking (Indian brand list, this pharmacy, and the free RxNorm services). Read-only. */
export type DrugKind = 'formulary' | 'generic' | 'brand' | 'international'

export interface DrugSuggestion {
  kind: DrugKind
  /** What goes into the drug-name box when chosen. */
  name: string
  /** A line to show underneath: composition and maker, stock, or strengths. */
  detail: string
  stock?: number
  unit?: string
}

export interface DrugSearch {
  results: DrugSuggestion[]
  /** A corrected spelling, when nothing matched what was typed. */
  didYouMean: string | null
}

export interface DrugCheck {
  /** true = a known medicine; false = not found in any list; null = could not be checked just now. */
  recognised: boolean | null
  /** What a brand is made of, e.g. "Amoxycillin (500mg) + Clavulanic Acid (125mg)". */
  generic: string | null
  allergyWarning: string | null
  alreadyPrescribed: boolean
}

export const searchDrugs = (text: string) => api<DrugSearch>(`/drugs/search?q=${encodeURIComponent(text)}`)

export const checkDrug = (name: string, encounterId?: string) =>
  api<DrugCheck>(`/drugs/check?name=${encodeURIComponent(name)}${encounterId ? `&encounterId=${encodeURIComponent(encounterId)}` : ''}`)
