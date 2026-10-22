<!-- From AIVA OSHealth, adapted to the merged application. -->
# Drug names: where they come from

The drug-name box on the OPD, emergency and inpatient screens suggests medicines as you type, and the AI's prescription
suggestions are checked against the same lists. Three sources, tried in this order:

| Source | What it gives | Where it lives |
|---|---|---|
| **This hospital's pharmacy** (`drugs` table) | Items you stock, with the stock level | Your database |
| **Indian brand list** | About 240,000 current allopathic brands, each with its generic composition and maker (Dolo 650 -> Paracetamol 650mg). Also the generic names (prescribing by generic name is Indian practice) | `reference/drug-catalog.tsv.gz`, loaded into memory at start (about half a second, about 55 MB) |
| **US National Library of Medicine** (RxNorm / RxTerms) | International names with strengths and forms, spelling correction, and "is this a real medicine?" | Live, free, no key (see below) |

The same medicine often has two names (paracetamol / acetaminophen, adrenaline / epinephrine, salbutamol / albuterol).
`backend/src/hospital/modules/drugs/drug-synonyms.ts` lists them; searching for either finds both.

## What the system checks for the prescriber

- **Allergies through the brand.** "Augmentin" does not say "penicillin", so a brand's generic composition (amoxycillin) is checked
  against the patient's recorded allergies as well. The warning is shown under the drug box and on AI suggestions; it never blocks.
- **Already on this visit**, and **not found in any drug list** (a misspelt or invented name; the AI's suggestions get this check too).
- **Names are never forced.** Anything can still be typed; the lists only help.

These checks supplement the doctor's judgement. They are not a drug-interaction database (see below).

## Privacy

Only the **text typed in the drug box** is ever sent to the US services: no patient name, number, allergy or visit. Answers are
cached for 24 hours (NLM asks for that, and for no more than 20 requests a second per address). If the service is slow or down
the app carries on with the local lists and does not ask again for a minute. Set `DRUG_ONLINE_LOOKUP=false` to never call out.

## The Indian brand data

- **Source:** the open [Indian Medicine Dataset](https://github.com/junioralive/Indian-Medicine-Dataset) (about 254,000 rows), under the
  MIT licence. The licence covers that repository's compilation; **the origin of the underlying product data is not stated there.**
  Have this reviewed before relying on it in a commercial product, or replace it with a licensed source.
- **What we keep:** brand name, generic composition, manufacturer. Discontinued products and duplicate names are dropped, and
  **prices are not kept** (they go stale and are not authoritative).
- **Refreshing it:** download `DATA/indian_medicine_data.csv` from that repository, then
  `node scripts/build-drug-catalog.mjs path/to/indian_medicine_data.csv`. This rewrites `reference/drug-catalog.tsv.gz`
  (sorted by lower-case brand name, which the search relies on; a test checks this). Run the tests, then commit the new file.
- **Not a clinical reference.** It has no doses, interactions or contraindications.

## Not included, and why

- **Drug-interaction checking.** NLM retired its free interaction service; there is no free replacement of suitable quality. A licensed
  database would be needed. Until then the doctor's own judgement, and the AI's advice text, are the only interaction checks.
- **WHO ATC / DDD codes.** Their terms do not allow commercial copying or distribution.
- **SNOMED CT India / ABDM drug codes.** Needed when prescriptions are shared over ABDM (M2/M3), which is not built yet; check the
  national terminology centre's licence terms then.

## API

| Call | Who | Returns |
|---|---|---|
| `GET /api/v1/drugs/search?q=` | doctor, nurse, pharmacist, admin | `{ results: [{ kind, name, detail, stock?, unit? }], didYouMean }`. `kind` is `formulary`, `generic`, `brand` or `international` |
| `GET /api/v1/drugs/check?name=&encounterId=` | same | `{ recognised, generic, allergyWarning, alreadyPrescribed }` (the allergy and duplicate parts need `encounterId`) |

Both are read-only and rate limited (300 a minute per address).
