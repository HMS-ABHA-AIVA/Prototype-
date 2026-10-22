import { api } from './client.ts'

/** The doctor's AI assistant. Both calls only DRAFT: nothing is saved until the doctor chooses to save it. */
export interface NoteFields {
  subjective: string
  objective: string
  assessment: string
  plan: string
}

export interface DictationResult {
  sections: NoteFields
  vitals: { tempF?: number; pulse?: number; bp?: string; spo2?: number; rr?: number }
  orders: { type: 'lab' | 'radiology'; name: string }[]
  /** 'ai' = a model organised it; 'rules' = sorted by the spoken section words (AI not switched on). */
  source: 'ai' | 'rules'
}

export type Frequency = 'OD' | 'BD' | 'TDS' | 'QID' | 'SOS'

export interface PrescriptionSuggestion {
  drugName: string
  dose: string
  frequency: Frequency
  duration: string
  rationale: string
  allergyWarning: string | null
  alreadyPrescribed: boolean
  /** false = the name is in no drug list (possibly misspelt or invented); null = could not be checked just now. */
  recognised: boolean | null
  pharmacy: { listed: boolean; stock: number | null; unit: string | null }
}

export interface SuggestionResult {
  suggestions: PrescriptionSuggestion[]
  advice: string
  source: 'ai'
  disclaimer: string
}

/** Whether the server's AI is on, and whether the provider may read what is sent (Gemini's free tier): then use invented patients only. */
export interface AiStatus {
  enabled: boolean
  provider: 'anthropic' | 'gemini'
  demoOnly: boolean
}

export const fetchAiStatus = () => api<AiStatus>('/ai/status')

export const sortDictation = (encounterId: string, transcript: string) =>
  api<DictationResult>(`/encounters/${encounterId}/ai/dictation`, { method: 'POST', body: { transcript } })

export const suggestPrescription = (encounterId: string, note: NoteFields) =>
  api<SuggestionResult>(`/encounters/${encounterId}/ai/prescription-suggestions`, { method: 'POST', body: note })
