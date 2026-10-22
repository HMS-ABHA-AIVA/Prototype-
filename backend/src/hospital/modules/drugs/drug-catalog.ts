import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { expandQuery } from "./drug-synonyms.js";

/**
 * The Indian brand -> generic list, searched in memory. About 240,000 current allopathic brands, from the open
 * "Indian Medicine Dataset" (MIT licence; see docs/HOSPITAL_MODULES.md). Prices are deliberately not kept: they go stale.
 * Built by scripts/build-drug-catalog.mjs into reference/drug-catalog.tsv.gz, one brand per line, sorted by lower-case name.
 */
export interface BrandHit {
  name: string;
  composition: string;
  manufacturer: string;
}
export interface GenericHit {
  /** How to write it on a prescription, e.g. "Paracetamol 500mg". */
  name: string;
  /** The catalog's own wording, e.g. "Paracetamol (500mg)". */
  composition: string;
  brandCount: number;
}

/** backend/reference/drug-catalog.tsv.gz, found both from the sources (tsx) and from the build (dist/src/...). */
function catalogFile(): string {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [
    join(here, "../../../../reference/drug-catalog.tsv.gz"),
    join(here, "../../../../../reference/drug-catalog.tsv.gz"),
    join(process.cwd(), "reference/drug-catalog.tsv.gz"),
  ];
  return candidates.find((path) => existsSync(path)) ?? candidates[0]!;
}

/** "Ambroxol (30mg/5ml) + Levosalbutamol (1mg/5ml)" -> "Ambroxol 30mg/5ml + Levosalbutamol 1mg/5ml" */
export const prescribingName = (composition: string) => composition.replace(/\s*\(([^)]*)\)/g, " $1").replace(/\s+/g, " ").trim();

/** The medicine words of a typed drug name, without strength or form: "Paracetamol 500mg tab" -> ["paracetamol"]. */
export function moleculesIn(drugName: string): string[] {
  return drugName
    .toLowerCase()
    .split(/\s*(?:\+|\/|,|&|\band\b|\bwith\b)\s*/)
    .map((part) =>
      part
        .replace(/\(.*?\)/g, " ")
        .split(/\s\d|\d/)[0]!
        .replace(/\b(tab|tablet|tablets|cap|capsule|capsules|syrup|inj|injection|drops|cream|gel)\b/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((part) => part.length >= 3);
}

/** True when `key` occurs in `text` at the start of a word (so "dolo" matches "Dolo 650" but not "Pindolol"). */
function hasWordStartingWith(text: string, key: string): boolean {
  for (let at = text.indexOf(key); at !== -1; at = text.indexOf(key, at + 1)) {
    if (at === 0 || !/[a-z0-9]/.test(text[at - 1]!)) return true;
  }
  return false;
}

export class DrugCatalog {
  private readonly lower: string[];
  private readonly compositionLower: string[];
  /** The same compositions as written on a prescription ("paracetamol 500mg"), lower-case. */
  private readonly prescribingLower: string[];
  private readonly compositionCount: Uint32Array;
  private readonly molecules = new Set<string>();
  private readonly firstWords = new Set<string>();

  constructor(
    private readonly names: string[],
    private readonly compositionOf: Uint32Array,
    private readonly manufacturerOf: Uint32Array,
    private readonly compositions: string[],
    private readonly manufacturers: string[],
  ) {
    this.lower = names.map((n) => n.toLowerCase());
    this.compositionLower = compositions.map((c) => c.toLowerCase());
    this.prescribingLower = compositions.map((c) => prescribingName(c).toLowerCase());
    this.compositionCount = new Uint32Array(compositions.length);
    for (const c of compositionOf) this.compositionCount[c]!++;
    for (const composition of this.compositionLower) {
      for (const part of composition.split(" + ")) {
        const molecule = part.replace(/\s*\(.*$/, "").trim();
        if (molecule) {
          this.molecules.add(molecule);
          this.firstWords.add(molecule.split(" ")[0]!);
        }
      }
    }
  }

  static fromTsv(text: string): DrugCatalog {
    const names: string[] = [];
    const compositionIndex = new Map<string, number>();
    const manufacturerIndex = new Map<string, number>();
    const compositions: string[] = [];
    const manufacturers: string[] = [];
    const compositionOf: number[] = [];
    const manufacturerOf: number[] = [];
    const intern = (map: Map<string, number>, list: string[], value: string) => {
      let i = map.get(value);
      if (i === undefined) {
        i = list.length;
        list.push(value);
        map.set(value, i);
      }
      return i;
    };
    for (const line of text.split("\n")) {
      const [name, composition, manufacturer] = line.split("\t");
      if (!name) continue;
      names.push(name);
      compositionOf.push(intern(compositionIndex, compositions, composition ?? ""));
      manufacturerOf.push(intern(manufacturerIndex, manufacturers, manufacturer ?? ""));
    }
    return new DrugCatalog(names, Uint32Array.from(compositionOf), Uint32Array.from(manufacturerOf), compositions, manufacturers);
  }

  get size(): number {
    return this.names.length;
  }

  private brand(i: number): BrandHit {
    return { name: this.names[i]!, composition: this.compositions[this.compositionOf[i]!]!, manufacturer: this.manufacturers[this.manufacturerOf[i]!]! };
  }

  /** First index whose lower-case name is not below `key`. */
  private lowerBound(key: string): number {
    let lo = 0;
    let hi = this.lower.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.lower[mid]! < key) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** The brand with exactly this name (ignoring case), if there is one. */
  findBrand(name: string): BrandHit | null {
    const key = name.toLowerCase().replace(/\s+/g, " ").trim();
    const i = this.lowerBound(key);
    return this.lower[i] === key ? this.brand(i) : null;
  }

  /**
   * Brands whose name starts with the text, then (unless `startsWithOnly`) those with a later word that does.
   * Callers searching several spellings of one name run the starts-with pass for all of them before the wider one.
   */
  searchBrands(text: string, limit: number, startsWithOnly = false): BrandHit[] {
    const key = text.toLowerCase().replace(/\s+/g, " ").trim();
    if (key.length < 2 || limit < 1) return [];
    const out: BrandHit[] = [];
    const taken = new Set<number>();
    for (let i = this.lowerBound(key); i < this.lower.length && this.lower[i]!.startsWith(key) && out.length < limit; i++) {
      out.push(this.brand(i));
      taken.add(i);
    }
    if (!startsWithOnly && out.length < limit && key.length >= 3) {
      for (let i = 0; i < this.lower.length && out.length < limit; i++) {
        if (!taken.has(i) && hasWordStartingWith(this.lower[i]!, key)) out.push(this.brand(i));
      }
    }
    return out;
  }

  /** Generic compositions (e.g. "Paracetamol (500mg)") matching the text, most-used first within starting-with / containing. */
  searchGenerics(text: string, limit: number): GenericHit[] {
    const key = text.toLowerCase().replace(/\s+/g, " ").trim();
    if (key.length < 2 || limit < 1) return [];
    const starts: number[] = [];
    const contains: number[] = [];
    for (let i = 0; i < this.compositionLower.length; i++) {
      const written = this.prescribingLower[i]!;
      if (written.startsWith(key) || this.compositionLower[i]!.startsWith(key)) starts.push(i);
      else if (key.length >= 3 && hasWordStartingWith(written, key)) contains.push(i);
    }
    const byUse = (a: number, b: number) => this.compositionCount[b]! - this.compositionCount[a]!;
    return [...starts.sort(byUse), ...contains.sort(byUse)].slice(0, limit).map((i) => ({
      name: prescribingName(this.compositions[i]!),
      composition: this.compositions[i]!,
      brandCount: this.compositionCount[i]!,
    }));
  }

  /** What the typed name is, as far as this list can tell: a known brand, a known medicine, or neither. */
  recognise(drugName: string): { recognised: boolean; generic: string | null } {
    const brand = this.findBrand(drugName);
    if (brand) return { recognised: true, generic: brand.composition };
    const parts = moleculesIn(drugName);
    if (parts.length === 0) {
      // Nothing medicine-like was typed (e.g. only a strength): fall back to a brand-prefix check.
      const key = drugName.toLowerCase().trim();
      const i = this.lowerBound(key);
      return { recognised: key.length >= 3 && !!this.lower[i]?.startsWith(key), generic: null };
    }
    const known = parts.every((part) => {
      for (const variant of expandQuery(part)) {
        // A whole molecule name, or a single word that begins one ("cefpodoxime" for "cefpodoxime proxetil").
        if (this.molecules.has(variant) || (!variant.includes(" ") && this.firstWords.has(variant))) return true;
        const i = this.lowerBound(variant);
        if (this.lower[i]?.startsWith(variant)) return true; // the first word(s) of a brand, e.g. "dolo"
      }
      return false;
    });
    return { recognised: known, generic: null };
  }
}

let loading: Promise<DrugCatalog> | undefined;

/** Loads the list once (about a third of a second) and shares it. Failing to load is a deployment mistake, so it throws. */
export function loadDrugCatalog(): Promise<DrugCatalog> {
  loading ??= readFile(catalogFile())
    .then((zipped) => promisify(gunzip)(zipped))
    .then((raw) => DrugCatalog.fromTsv(raw.toString("utf8")))
    .catch((error: unknown) => {
      loading = undefined;
      throw error;
    });
  return loading;
}
