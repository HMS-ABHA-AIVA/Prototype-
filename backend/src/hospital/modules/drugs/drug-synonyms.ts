/**
 * The same medicine goes by different names in India and elsewhere (paracetamol / acetaminophen, adrenaline / epinephrine).
 * Each group lists names for ONE medicine. The Indian brand list uses the first spelling of a group where it has a choice;
 * the international sources (RxNorm) use the US one. Searching for any name in a group also searches the others.
 */
export const SYNONYM_GROUPS: string[][] = [
  ["paracetamol", "acetaminophen"],
  ["amoxycillin", "amoxicillin"],
  ["cefalexin", "cephalexin"],
  ["adrenaline", "epinephrine"],
  ["noradrenaline", "norepinephrine"],
  ["salbutamol", "albuterol"],
  ["levosalbutamol", "levalbuterol"],
  ["pethidine", "meperidine"],
  ["glyceryl trinitrate", "nitroglycerin", "gtn"],
  ["frusemide", "furosemide"],
  ["lignocaine", "lidocaine"],
  ["rifampicin", "rifampin"],
  ["sulphacetamide", "sulfacetamide"],
  ["sulphamethoxazole", "sulfamethoxazole"],
  ["cotrimoxazole", "co-trimoxazole"],
  ["thyroxine", "levothyroxine"],
  ["ciclosporin", "cyclosporine"],
  ["aciclovir", "acyclovir"],
  ["chlorpheniramine", "chlorphenamine"],
  ["hyoscine", "scopolamine"],
  ["glibenclamide", "glyburide"],
  ["phenobarbitone", "phenobarbital"],
  ["benzylpenicillin", "penicillin g"],
  ["dicyclomine", "dicycloverine"],
  ["isoprenaline", "isoproterenol"],
  ["cholecalciferol", "vitamin d3"],
];

/**
 * Other ways to write the search text. The text itself comes first. A name is swapped when it appears as a whole word,
 * or when what was typed so far is the start of one (typing "acetam" also finds paracetamol).
 */
export function expandQuery(text: string): string[] {
  const q = text.toLowerCase().replace(/\s+/g, " ").trim();
  const out = [q];
  const add = (value: string) => {
    if (value && !out.includes(value)) out.push(value);
  };
  for (const group of SYNONYM_GROUPS) {
    for (const term of group) {
      const asWord = new RegExp(`(^|[\\s(+/])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[\\s)+/,\\d])`);
      if (asWord.test(q)) {
        for (const other of group) if (other !== term) add(q.replace(asWord, `$1${other}`));
      } else if (q.length >= 4 && term.startsWith(q)) {
        for (const other of group) if (other !== term) add(other);
      }
    }
  }
  return out.slice(0, 4);
}
