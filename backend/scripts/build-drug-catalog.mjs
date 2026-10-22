// Builds reference/drug-catalog.tsv.gz (the Indian brand -> generic lookup) from the open "Indian Medicine Dataset"
// (https://github.com/junioralive/Indian-Medicine-Dataset, MIT licence). Run only when refreshing the data:
//   node scripts/build-drug-catalog.mjs path/to/indian_medicine_data.csv
// Keeps current allopathic products only, drops prices (they go stale), and writes one line per brand:
//   brand name <TAB> generic composition <TAB> manufacturer
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

const input = process.argv[2]
if (!input) {
  console.error('Usage: node scripts/build-drug-catalog.mjs <indian_medicine_data.csv>')
  process.exit(1)
}

/** Minimal CSV reader that handles quoted fields containing commas and line breaks. */
function* rows(text) {
  let field = ''
  let row = []
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.length > 1 || row[0] !== '') yield row
      row = []
    } else field += c
  }
  if (field !== '' || row.length) { row.push(field); yield row }
}

const tidy = (s) => s.replace(/[\t\r\n]+/g, ' ').replace(/\s+/g, ' ').replace(/\s+\(/g, ' (').trim()
// The dataset sometimes writes both names of one medicine as a single molecule.
const oneName = (s) => s.replace(/paracetamol\/acetaminophen/gi, 'Paracetamol')

const iterator = rows(readFileSync(input, 'utf8'))
const header = iterator.next().value
const col = Object.fromEntries(header.map((h, i) => [h.trim(), i]))
for (const need of ['name', 'Is_discontinued', 'manufacturer_name', 'type', 'short_composition1', 'short_composition2']) {
  if (!(need in col)) throw new Error(`Column "${need}" not found in the CSV header`)
}

const seen = new Set()
const lines = []
const stats = { total: 0, discontinued: 0, notAllopathy: 0, noName: 0, duplicate: 0 }
for (const r of iterator) {
  stats.total++
  const name = tidy(r[col.name] ?? '')
  if (!name) { stats.noName++; continue }
  if ((r[col.Is_discontinued] ?? '').trim().toUpperCase() === 'TRUE') { stats.discontinued++; continue }
  if ((r[col.type] ?? '').trim().toLowerCase() !== 'allopathy') { stats.notAllopathy++; continue }
  const key = name.toLowerCase()
  if (seen.has(key)) { stats.duplicate++; continue }
  seen.add(key)
  const composition = [r[col.short_composition1], r[col.short_composition2]].map((s) => oneName(tidy(s ?? ''))).filter(Boolean).join(' + ')
  lines.push(`${name}\t${composition}\t${tidy(r[col.manufacturer_name] ?? '')}`)
}

// Plain code-point order on the lower-cased brand name: the server binary-searches this order, so it must not be locale-dependent.
const brandKey = (line) => line.slice(0, line.indexOf('\t')).toLowerCase()
lines.sort((a, b) => { const x = brandKey(a); const y = brandKey(b); return x < y ? -1 : x > y ? 1 : 0 })
mkdirSync('reference', { recursive: true })
const out = gzipSync(Buffer.from(lines.join('\n'), 'utf8'), { level: 9 })
writeFileSync('reference/drug-catalog.tsv.gz', out)
console.log(`Read ${stats.total} rows; kept ${lines.length}.`, stats)
console.log(`Wrote reference/drug-catalog.tsv.gz (${(out.length / 1024 / 1024).toFixed(1)} MB)`)
