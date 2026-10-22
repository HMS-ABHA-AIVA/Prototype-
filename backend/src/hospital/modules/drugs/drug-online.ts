import type { HospitalEnv } from "../../config.js";
import type { Logger } from "../../shared/logger.js";

/**
 * The free international drug services of the US National Library of Medicine (no key needed):
 *  - Clinical Tables / RxTerms: drug names with their strengths and forms;
 *  - RxNav / RxNorm: spelling suggestions, and whether a name is a known medicine.
 * Only the text typed in the drug box is ever sent. Every answer is cached for a day (NLM asks for that, and for no more
 * than 20 requests a second). If the service is slow or down the app carries on with the local lists, and does not retry for a minute.
 */
export interface OnlineDrug {
  name: string;
  /** e.g. "Oral Pill · 250 mg Cap, 500 mg Cap, 500 mg Tab" */
  detail: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const GIVE_UP_FOR_MS = 60 * 1000;
// The first request on a cold connection can take about 3 seconds (DNS, TLS); later ones about a third of a second.
const TIMEOUT_MS = 6000;
const MAX_CACHED = 3000;

export class DrugOnline {
  private readonly cache = new Map<string, { at: number; value: unknown }>();
  private pausedUntil = 0;

  constructor(
    private readonly env: Pick<HospitalEnv, "drugOnlineLookup" | "rxnavUrl" | "clinicalTablesUrl">,
    private readonly log: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get enabled(): boolean {
    return this.env.drugOnlineLookup;
  }

  private async cached<T>(key: string, load: () => Promise<T>): Promise<T | undefined> {
    if (!this.enabled || Date.now() < this.pausedUntil) return undefined;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < DAY_MS) return hit.value as T;
    try {
      const value = await load();
      if (this.cache.size >= MAX_CACHED) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { at: Date.now(), value });
      return value;
    } catch (error) {
      this.pausedUntil = Date.now() + GIVE_UP_FOR_MS;
      this.log.warn("Online drug lookup unavailable; using the local lists only", { message: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  }

  private async getJson(url: string): Promise<any> {
    const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  /** Drug names beginning with the text, with strengths and forms. Empty when unavailable. */
  async names(text: string): Promise<OnlineDrug[]> {
    const q = text.toLowerCase().trim();
    const found = await this.cached<OnlineDrug[]>(`names:${q}`, async () => {
      const body = await this.getJson(`${this.env.clinicalTablesUrl}/api/rxterms/v3/search?terms=${encodeURIComponent(q)}&ef=STRENGTHS_AND_FORMS&maxList=6`);
      const labels: unknown = body?.[1];
      const strengths: unknown = body?.[2]?.STRENGTHS_AND_FORMS;
      if (!Array.isArray(labels)) return [];
      return labels.flatMap((label, i): OnlineDrug[] => {
        if (typeof label !== "string") return [];
        const match = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(label);
        const list = Array.isArray(strengths) && Array.isArray(strengths[i]) ? (strengths[i] as unknown[]).filter((s): s is string => typeof s === "string") : [];
        const detail = [match?.[2], list.slice(0, 4).join(", ")].filter(Boolean).join(" · ");
        return [{ name: (match?.[1] ?? label).trim(), detail }];
      });
    });
    return found ?? [];
  }

  /** Corrections for a misspelt name ("amoxicilin" -> "amoxicillin"). Empty when none or unavailable. */
  async spelling(text: string): Promise<string[]> {
    const q = text.toLowerCase().trim();
    const found = await this.cached<string[]>(`spell:${q}`, async () => {
      const body = await this.getJson(`${this.env.rxnavUrl}/REST/spellingsuggestions.json?name=${encodeURIComponent(q)}`);
      const list: unknown = body?.suggestionGroup?.suggestionList?.suggestion;
      return Array.isArray(list) ? list.filter((s): s is string => typeof s === "string").slice(0, 3) : [];
    });
    return found ?? [];
  }

  /** True / false when RxNorm answers, null when it cannot be asked (offline, switched off). */
  async isKnown(text: string): Promise<boolean | null> {
    const q = text.toLowerCase().trim();
    const found = await this.cached<boolean>(`known:${q}`, async () => {
      const body = await this.getJson(`${this.env.rxnavUrl}/REST/rxcui.json?name=${encodeURIComponent(q)}&search=2`);
      const ids: unknown = body?.idGroup?.rxnormId;
      return Array.isArray(ids) && ids.length > 0;
    });
    return found ?? null;
  }
}
