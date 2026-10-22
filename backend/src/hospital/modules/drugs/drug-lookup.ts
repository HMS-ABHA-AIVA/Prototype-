import type { Queryable } from "../../db.js";
import { loadDrugCatalog, moleculesIn } from "./drug-catalog.js";
import type { DrugOnline } from "./drug-online.js";
import { expandQuery } from "./drug-synonyms.js";

/**
 * Finds medicines by what a person types: this hospital's own pharmacy first, then generic names (Indian practice is to
 * prescribe by generic name), then Indian brands, then international names from the free RxNorm services when the local
 * lists have little to offer. Also answers "is this a real medicine?" for names the AI suggests.
 */
export type SuggestionKind = "formulary" | "generic" | "brand" | "international";

export interface DrugSuggestion {
  kind: SuggestionKind;
  /** What goes into the prescription's drug name when chosen. */
  name: string;
  /** A line to show underneath: composition and maker, stock level, strengths. */
  detail: string;
  stock?: number;
  unit?: string;
}

export interface SearchResult {
  results: DrugSuggestion[];
  /** A corrected spelling, when nothing matched what was typed and the spelling service had a suggestion that does. */
  didYouMean: string | null;
}

export interface NameCheck {
  /** true = found in the lists; false = not found anywhere; null = not in the local lists and the online check could not be made. */
  recognised: boolean | null;
  /** The generic composition when the name is an Indian brand, e.g. "Amoxycillin (500mg) + Clavulanic Acid (125mg)". */
  generic: string | null;
}

interface FormularyRow {
  name: string;
  stock: number;
  unit: string;
}

const MAX_RESULTS = 12;
/** When local results are already in hand, how long to wait for the online names before showing them without. */
const ONLINE_PATIENCE_MS = 1500;

/** The work's result, or `fallback` if it takes longer than `ms`. The work carries on (and caches its answer) either way. */
async function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

export class DrugLookup {
  constructor(
    private readonly db: Queryable,
    private readonly online: DrugOnline,
  ) {}

  /** The pharmacy of the hospital in scope: its medicines and what is in stock (unexpired batches). */
  private async formulary(): Promise<FormularyRow[]> {
    return this.db.query<FormularyRow>(
      `SELECT d.name, COALESCE((SELECT sum(b.qty) FROM "DrugBatch" b WHERE b."facilityId" = :fid AND b."drugId" = d.id
                                  AND b.expiry >= (now() AT TIME ZONE 'Asia/Kolkata')::date), 0)::int AS stock, d.unit
         FROM "Drug" d WHERE d."facilityId" = :fid`,
    );
  }

  private async fromLocal(variants: string[]): Promise<DrugSuggestion[]> {
    const catalog = await loadDrugCatalog();
    const seen = new Set<string>();
    const keep = (name: string) => {
      const key = name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    };
    const out: DrugSuggestion[] = [];

    const stocked = (await this.formulary())
      .filter((d) => variants.some((v) => d.name.toLowerCase().includes(v)))
      .sort(
        (a, b) =>
          Number(!variants.some((v) => b.name.toLowerCase().startsWith(v))) - Number(!variants.some((v) => a.name.toLowerCase().startsWith(v))) ||
          a.name.localeCompare(b.name),
      );
    for (const d of stocked.slice(0, 4)) {
      if (keep(d.name)) out.push({ kind: "formulary", name: d.name, detail: `In this hospital's pharmacy · ${d.stock} ${d.unit} in stock`, stock: d.stock, unit: d.unit });
    }
    for (const v of variants) {
      for (const g of catalog.searchGenerics(v, 4)) {
        if (out.filter((s) => s.kind === "generic").length < 4 && keep(g.name)) {
          out.push({ kind: "generic", name: g.name, detail: `Generic name · ${g.brandCount} brand${g.brandCount === 1 ? "" : "s"} in India` });
        }
      }
    }
    // Names that start with what was typed (in any spelling) come before names that merely have a later word that does.
    for (const startsWithOnly of [true, false]) {
      for (const v of variants) {
        for (const b of catalog.searchBrands(v, 8, startsWithOnly)) {
          if (out.filter((s) => s.kind === "brand").length < 8 && keep(b.name)) {
            out.push({ kind: "brand", name: b.name, detail: [b.composition, b.manufacturer].filter(Boolean).join(" · ") });
          }
        }
      }
    }
    return out;
  }

  async search(text: string, limit = MAX_RESULTS): Promise<SearchResult> {
    const q = text.replace(/\s+/g, " ").trim().slice(0, 60);
    if (q.length < 2) return { results: [], didYouMean: null };

    const variants = expandQuery(q);
    let results = await this.fromLocal(variants);
    let didYouMean: string | null = null;

    // International names help when the local lists have little: they carry strengths and forms.
    if (results.length < 5 && q.length >= 3) {
      const seen = new Set(results.map((r) => r.name.toLowerCase()));
      for (const v of variants.slice(0, 2)) {
        // With nothing local to show there is no point hurrying; with something, show it rather than make the person wait.
        const names = this.online.names(v);
        for (const o of results.length > 0 ? await within(names, ONLINE_PATIENCE_MS, []) : await names) {
          if (results.filter((r) => r.kind === "international").length < 4 && !seen.has(o.name.toLowerCase())) {
            seen.add(o.name.toLowerCase());
            results.push({ kind: "international", name: o.name, detail: o.detail });
          }
        }
      }
    }

    if (results.length === 0 && q.length >= 4) {
      for (const suggestion of await this.online.spelling(q)) {
        const retry = await this.fromLocal(expandQuery(suggestion));
        if (retry.length > 0) {
          results = retry;
          didYouMean = suggestion;
          break;
        }
      }
    }
    return { results: results.slice(0, limit), didYouMean };
  }

  /** Is this a real medicine, and if it is an Indian brand, what is it made of? Used to check what the AI suggests. */
  async verify(drugName: string): Promise<NameCheck> {
    const catalog = await loadDrugCatalog();
    const local = catalog.recognise(drugName);
    if (local.recognised) return local;

    const lower = drugName.toLowerCase();
    if ((await this.formulary()).some((d) => d.name.toLowerCase() === lower)) return { recognised: true, generic: null };

    const parts = moleculesIn(drugName);
    if (!this.online.enabled) return { recognised: false, generic: null };
    if (parts.length === 0) return { recognised: false, generic: null };

    let unknown = false;
    for (const part of parts) {
      let found: boolean | null = false;
      for (const variant of expandQuery(part).slice(0, 2)) {
        const answer = await this.online.isKnown(variant);
        if (answer === null) found = null;
        else if (answer) {
          found = true;
          break;
        }
      }
      if (found === false) return { recognised: false, generic: null };
      if (found === null) unknown = true;
    }
    return { recognised: unknown ? null : true, generic: null };
  }
}
