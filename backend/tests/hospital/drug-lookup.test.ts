import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { loadHospitalEnv as loadEnv } from '../../src/hospital/config.js'
import { DrugCatalog, loadDrugCatalog, moleculesIn, prescribingName } from '../../src/hospital/modules/drugs/drug-catalog.js'
import { DrugOnline } from '../../src/hospital/modules/drugs/drug-online.js'
import { expandQuery } from '../../src/hospital/modules/drugs/drug-synonyms.js'
import { createLogger } from '../../src/hospital/shared/logger.js'
import { checkInOpdPaid, newPatient, seedBasics, startTestApi, type TestApi, stopServer } from './helpers.js'

// One application per test file, shared by its describe blocks: stop it when they are all done.
after(stopServer)

const api = '/api/v1'

const SAMPLE = [
  'Augmentin 625 Duo Tablet\tAmoxycillin (500mg) + Clavulanic Acid (125mg)\tGlaxo SmithKline',
  'Crocin 500 Tablet\tParacetamol (500mg)\tGSK Consumer',
  'Dolo 650 Tablet\tParacetamol (650mg)\tMicro Labs',
  'Pindolol 10mg Tablet\tPindolol (10mg)\tSome Maker',
  'Taxim-O 200 Tablet\tCefixime (200mg)\tAlkem',
].join('\n')

describe('Indian brand list', () => {
  const small = DrugCatalog.fromTsv(SAMPLE)

  it('finds brands by the start of the name, and by the start of a later word, but not by the middle of a word', () => {
    assert.deepEqual(small.searchBrands('dolo', 5).map((b) => b.name), ['Dolo 650 Tablet'])
    assert.deepEqual(small.searchBrands('duo', 5).map((b) => b.name), ['Augmentin 625 Duo Tablet'])
    assert.deepEqual(small.searchBrands('dolo', 5).map((b) => b.name).filter((n) => n.startsWith('Pindolol')), [])
    assert.equal(small.searchBrands('d', 5).length, 0, 'one letter is too little to search')
  })

  it('lists generic compositions as they would be written on a prescription', () => {
    assert.equal(prescribingName('Ambroxol (30mg/5ml) + Levosalbutamol (1mg/5ml)'), 'Ambroxol 30mg/5ml + Levosalbutamol 1mg/5ml')
    const generics = small.searchGenerics('paracetamol', 5)
    assert.deepEqual(generics.map((g) => g.name), ['Paracetamol 500mg', 'Paracetamol 650mg'])
    assert.equal(generics[0]!.brandCount, 1)
  })

  it('tells what a brand is made of, and whether a name is a real medicine', () => {
    assert.equal(small.findBrand('augmentin 625 duo tablet')?.composition, 'Amoxycillin (500mg) + Clavulanic Acid (125mg)')
    assert.equal(small.findBrand('Augmentin'), null, 'only an exact brand name')
    assert.equal(small.recognise('Augmentin 625 Duo Tablet').generic, 'Amoxycillin (500mg) + Clavulanic Acid (125mg)')
    assert.equal(small.recognise('Paracetamol 500mg').recognised, true, 'a generic name with a strength')
    assert.equal(small.recognise('Amoxicillin 500mg tab').recognised, true, 'the US spelling of amoxycillin')
    assert.equal(small.recognise('Dolo 650').recognised, true, 'a brand without its form')
    assert.equal(small.recognise('Zorbaxin 10mg').recognised, false)
    assert.equal(small.recognise('Paracetamol + Cefixime').recognised, true, 'every part must be known')
    assert.equal(small.recognise('Paracetamol + Zorbaxin').recognised, false)
  })

  it('pulls the medicine words out of what a doctor types', () => {
    assert.deepEqual(moleculesIn('Paracetamol 500mg'), ['paracetamol'])
    assert.deepEqual(moleculesIn('Amoxicillin 500mg + Clavulanic acid 125mg'), ['amoxicillin', 'clavulanic acid'])
    assert.deepEqual(moleculesIn('Cefixime 200 mg tablet'), ['cefixime'])
  })

  it('treats Indian and international names of one medicine alike', () => {
    assert.deepEqual(expandQuery('acetaminophen 500'), ['acetaminophen 500', 'paracetamol 500'])
    assert.ok(expandQuery('epinephrine').includes('adrenaline'))
    assert.ok(expandQuery('acetam').includes('paracetamol'), 'what is typed so far is enough')
    assert.deepEqual(expandQuery('zorbaxin'), ['zorbaxin'])
  })

  it('ships a complete, correctly ordered list (the search relies on the order)', async () => {
    const full = await loadDrugCatalog()
    assert.ok(full.size > 200_000, `only ${full.size} brands`)
    assert.ok(full.searchBrands('dolo 650', 3).length > 0)
    assert.match(full.findBrand('Augmentin 625 Duo Tablet')?.composition ?? '', /Amoxycillin.*Clavulanic Acid/)
    // Every brand must be findable by its own exact name; that only holds if the file is sorted the way the search expects.
    for (const probe of ['Crocin Advance Tablet', 'Azithral 500 Tablet', 'Zyvocol 1% Dusting Powder', 'Allegra 120mg Tablet']) {
      assert.equal(full.findBrand(probe)?.name, probe)
    }
    const indian = full.searchGenerics('paracetamol', 3).map((g) => g.name)
    assert.ok(indian.every((name) => !/acetaminophen/i.test(name)), 'one name per medicine, not "Paracetamol/Acetaminophen"')
  })
})

/** A stand-in for the NLM services that counts the requests it gets. */
function fakeNlm() {
  const hits: string[] = []
  const server: Server = createServer((req, res) => {
    hits.push(req.url ?? '')
    res.writeHead(200, { 'content-type': 'application/json' })
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname.startsWith('/api/rxterms')) {
      const terms = url.searchParams.get('terms')
      res.end(terms === 'ibupro'
        ? JSON.stringify([1, ['Ibuprofen (Oral Pill)'], { STRENGTHS_AND_FORMS: [['200 mg Tab', '400 mg Tab', '600 mg Tab']] }, [['Ibuprofen (Oral Pill)']]])
        : terms === 'qzxmed' // a medicine the Indian lists do not have
          ? JSON.stringify([1, ['Qzxmedine (Oral Pill)'], { STRENGTHS_AND_FORMS: [['10 mg Tab']] }, [['Qzxmedine (Oral Pill)']]])
          : JSON.stringify([0, [], null, []]))
    } else if (url.pathname.endsWith('spellingsuggestions.json')) {
      res.end(JSON.stringify({ suggestionGroup: { name: null, suggestionList: { suggestion: url.searchParams.get('name') === 'amoxicilin' ? ['amoxicillin'] : [] } } }))
    } else {
      const known = ['ibuprofen', 'zolpidem'].includes(url.searchParams.get('name') ?? '')
      res.end(JSON.stringify({ idGroup: known ? { rxnormId: ['5640'] } : {} }))
    }
  })
  return {
    hits,
    start: () => new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))),
    stop: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections() }),
  }
}

describe('international drug names (NLM RxNorm services)', () => {
  const nlm = fakeNlm()
  let url: string
  before(async () => { url = await nlm.start() })
  after(() => nlm.stop())
  const online = (on = true, fetchImpl?: typeof fetch) =>
    new DrugOnline(loadEnv({ NODE_ENV: 'test', DRUG_ONLINE_LOOKUP: String(on), RXNAV_URL: url, CLINICAL_TABLES_URL: url }), createLogger('silent'), fetchImpl)

  it('reads names with their forms and strengths, and remembers answers instead of asking again', async () => {
    const o = online()
    const before = nlm.hits.length
    assert.deepEqual(await o.names('ibupro'), [{ name: 'Ibuprofen', detail: 'Oral Pill · 200 mg Tab, 400 mg Tab, 600 mg Tab' }])
    await o.names('ibupro')
    assert.equal(nlm.hits.length - before, 1, 'the second ask came from memory')
    assert.deepEqual(await o.names('nothing'), [])
  })

  it('corrects spelling and says whether a name is a known medicine', async () => {
    const o = online()
    assert.deepEqual(await o.spelling('amoxicilin'), ['amoxicillin'])
    assert.equal(await o.isKnown('zolpidem'), true)
    assert.equal(await o.isKnown('zorbaxin'), false)
  })

  it('does nothing when switched off, and carries on quietly when the service is down', async () => {
    let calls = 0
    const off = online(false, (async () => { calls++; throw new Error('should not be called') }) as typeof fetch)
    assert.deepEqual(await off.names('ibupro'), [])
    assert.equal(await off.isKnown('zolpidem'), null)
    assert.equal(calls, 0)

    const down = online(true, (async () => { calls++; throw new Error('network down') }) as typeof fetch)
    assert.deepEqual(await down.names('ibupro'), [])
    assert.equal(await down.isKnown('zolpidem'), null, 'unknown, not "not a medicine"')
    assert.equal(calls, 1, 'after a failure it leaves the service alone for a minute')
  })
})

describe('drug search and check over the API', () => {
  const nlm = fakeNlm()
  let t: TestApi
  let visitId: string
  before(async () => {
    const url = await nlm.start()
    t = await startTestApi(undefined, { DRUG_ONLINE_LOOKUP: 'true', RXNAV_URL: url, CLINICAL_TABLES_URL: url })
    const { doctorId } = await seedBasics(t)
    await t.post(`${api}/pharmacy/drugs`, { name: 'Paracetamol 500mg Tab', batch: 'B1', expiry: '2030-01-01', stock: 80, reorderLevel: 10, unit: 'strip', mrp: 12 })
    const patient = await newPatient(t, { name: 'Sunita Rao', allergies: ['Penicillin'] })
    visitId = (await checkInOpdPaid(t, { patientId: patient.id, department: 'General Medicine', doctorId })).body.id
  })
  after(async () => { await t.close(); await nlm.stop() })

  it('puts this pharmacy first, then generic names, then Indian brands', async () => {
    const r = await t.get(`${api}/drugs/search?q=paracetamol`)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const kinds = r.body.results.map((x: any) => x.kind)
    assert.deepEqual(kinds.slice(0, 1), ['formulary'])
    assert.ok(kinds.includes('generic') && kinds.includes('brand'))
    assert.ok(kinds.indexOf('generic') < kinds.indexOf('brand'), 'generic names come before brands')
    const own = r.body.results[0]
    assert.equal(own.name, 'Paracetamol 500mg Tab')
    assert.equal(own.stock, 80)
    assert.match(own.detail, /80 strip in stock/)
  })

  it('finds a brand and shows what it is made of', async () => {
    const r = await t.get(`${api}/drugs/search?q=${encodeURIComponent('augmentin 625')}`)
    const brand = r.body.results.find((x: any) => x.name === 'Augmentin 625 Duo Tablet')
    assert.ok(brand, JSON.stringify(r.body.results.map((x: any) => x.name)))
    assert.match(brand.detail, /Amoxycillin \(500mg\) \+ Clavulanic Acid \(125mg\)/)
  })

  it('finds the Indian name from the international one', async () => {
    const r = await t.get(`${api}/drugs/search?q=acetaminophen`)
    assert.ok(r.body.results.some((x: any) => x.kind === 'generic' && /^Paracetamol /.test(x.name)))
  })

  it('adds international names and corrects spelling when the local lists have little', async () => {
    // Plenty of Indian matches: no need to ask abroad.
    const asked = nlm.hits.length
    assert.ok((await t.get(`${api}/drugs/search?q=paracetamol`)).body.results.every((x: any) => x.kind !== 'international'))
    assert.equal(nlm.hits.length, asked, 'no outgoing request when the local lists are enough')

    const intl = await t.get(`${api}/drugs/search?q=qzxmed`)
    const entry = intl.body.results.find((x: any) => x.kind === 'international')
    assert.ok(entry, JSON.stringify(intl.body))
    assert.equal(entry.name, 'Qzxmedine')
    assert.match(entry.detail, /Oral Pill · 10 mg Tab/)

    const typo = await t.get(`${api}/drugs/search?q=amoxicilin`)
    assert.equal(typo.body.didYouMean, 'amoxicillin')
    assert.ok(typo.body.results.some((x: any) => /Amoxycillin/.test(x.name + x.detail)))
  })

  it('returns nothing for too little text, and only the typed text ever leaves the system', async () => {
    assert.deepEqual((await t.get(`${api}/drugs/search?q=a`)).body, { results: [], didYouMean: null })
    assert.deepEqual((await t.get(`${api}/drugs/search`)).body, { results: [], didYouMean: null })
    assert.ok(nlm.hits.every((h) => !/Sunita|Rao|Penicillin/i.test(h)), 'no patient detail in any outgoing request')
  })

  it('checks a name against the patient\'s allergies through its generic make-up', async () => {
    const q = (name: string) => t.get(`${api}/drugs/check?name=${encodeURIComponent(name)}&encounterId=${visitId}`)
    const brand = await q('Augmentin 625 Duo Tablet')
    assert.equal(brand.status, 200, JSON.stringify(brand.body))
    assert.match(brand.body.allergyWarning, /Penicillin/)
    assert.equal(brand.body.recognised, true)
    assert.match(brand.body.generic, /Amoxycillin/)

    const safe = await q('Dolo 650 Tablet')
    assert.equal(safe.body.allergyWarning, null)

    const fake = await q('Zorbaxin 10mg')
    assert.equal(fake.body.recognised, false)

    await t.post(`${api}/encounters/${visitId}/prescriptions`, { drugName: 'Dolo 650 Tablet', dose: '1 tab', frequency: 'TDS', duration: '3 days' })
    assert.equal((await q('Dolo 650 Tablet')).body.alreadyPrescribed, true)
    assert.equal((await t.get(`${api}/drugs/check?name=Dolo`)).body.alreadyPrescribed, false, 'without a visit there is nothing to compare')
  })

  it('is for prescribers and the pharmacy, and validates what it is given', async () => {
    assert.equal((await (await t.as('doctor')).get(`${api}/drugs/search?q=dolo`)).status, 200)
    assert.equal((await (await t.as('nurse')).get(`${api}/drugs/search?q=dolo`)).status, 200)
    assert.equal((await (await t.as('pharmacist')).get(`${api}/drugs/search?q=dolo`)).status, 200)
    assert.equal((await (await t.as('front_office')).get(`${api}/drugs/search?q=dolo`)).status, 403)
    assert.equal((await (await t.as('biller')).get(`${api}/drugs/check?name=dolo`)).status, 403)
    assert.equal((await t.get(`${api}/drugs/check`)).status, 400)
    assert.equal((await t.get(`${api}/drugs/check?name=dolo&encounterId=nope`)).status, 400)
  })
})
