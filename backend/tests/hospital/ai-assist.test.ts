import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { allergyConflict, hideIdentifiers, normaliseFrequency, splitDictation } from '../../src/hospital/modules/ai/clinical-text.js'
import { checkInOpdPaid, newPatient, seedBasics, startTestApi, type TestApi, stopServer } from './helpers.js'

// One application per test file, shared by its describe blocks: stop it when they are all done.
after(stopServer)

const api = '/api/v1'

describe('dictation sorting without AI', () => {
  it('sorts spoken section words into the note fields', () => {
    const r = splitDictation(
      'Subjective fever and cough for three days. Objective throat congested, chest clear. Assessment viral upper respiratory infection. Plan rest, fluids and review in one week',
    )
    assert.equal(r.source, 'rules')
    assert.equal(r.sections.subjective, 'Fever and cough for three days.')
    assert.equal(r.sections.objective, 'Throat congested, chest clear.')
    assert.equal(r.sections.assessment, 'Viral upper respiratory infection.')
    assert.equal(r.sections.plan, 'Rest, fluids and review in one week')
  })

  it('puts words before any section word into Subjective, and understands common synonyms', () => {
    const r = splitDictation('Headache since morning. Diagnosis tension headache. Treatment paracetamol as needed')
    assert.equal(r.sections.subjective, 'Headache since morning.')
    assert.equal(r.sections.assessment, 'Tension headache.')
    assert.equal(r.sections.plan, 'Paracetamol as needed')
    assert.equal(splitDictation('only a few words').sections.subjective, 'Only a few words')
  })

  it('picks vitals out of spoken phrases', () => {
    const r = splitDictation('On examination temperature 99.4 pulse 88 blood pressure 130 over 85 oxygen saturation 97 respiratory rate 18')
    assert.deepEqual(r.vitals, { tempF: 99.4, pulse: 88, bp: '130/85', spo2: 97, rr: 18 })
    assert.equal(splitDictation('temperature 38 degrees').vitals.tempF, 100.4, 'Celsius is converted')
    assert.deepEqual(splitDictation('pulse 400 and bp 40 over 20').vitals, {}, 'impossible numbers are ignored')
  })
})

describe('safety helpers', () => {
  it('maps wording to the prescription frequency codes', () => {
    assert.equal(normaliseFrequency('twice daily'), 'BD')
    assert.equal(normaliseFrequency('Three times a day'), 'TDS')
    assert.equal(normaliseFrequency('1-0-1'), 'BD')
    assert.equal(normaliseFrequency('as needed'), 'SOS')
    assert.equal(normaliseFrequency('once daily at night'), 'OD')
    assert.equal(normaliseFrequency('whatever'), 'OD')
  })

  it('warns about allergies by name and by medicine family', () => {
    assert.match(allergyConflict('Amoxicillin 500mg', ['Penicillin'])!, /Penicillin/)
    assert.match(allergyConflict('Cefixime 200mg', ['Cephalosporin'])!, /related/)
    assert.match(allergyConflict('Cotrimoxazole DS', ['Sulfa drugs'])!, /Sulfa drugs/)
    assert.match(allergyConflict('Diclofenac 50mg', ['NSAIDs'])!, /NSAIDs/)
    assert.equal(allergyConflict('Paracetamol 500mg', ['Penicillin', 'Sulfa drugs']), null)
    assert.equal(allergyConflict('Amoxicillin', []), null)
  })

  it('removes everything that identifies the patient', () => {
    const out = hideIdentifiers('Ramesh Gupta, MRN-10001, phone 9876500001 and 9123456789, ABHA 91-1234-5678-9012 has fever', { name: 'Ramesh Gupta', phone: '9876500001' })
    assert.equal(out, '[patient] [patient], [id], phone [phone] and [phone], ABHA [id] has fever')
  })
})

/** A stand-in for the AI service: records what it is sent and answers from a queue. */
function fakeAi() {
  const requests: any[] = []
  const answers: { status: number; text: string }[] = []
  const server: Server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      requests.push({ headers: req.headers, body: JSON.parse(raw) })
      const answer = answers.shift() ?? { status: 500, text: 'nothing queued' }
      res.writeHead(answer.status, { 'content-type': 'application/json' })
      res.end(answer.status === 200 ? JSON.stringify({ content: [{ type: 'text', text: answer.text }] }) : answer.text)
    })
  })
  return {
    requests,
    reply: (text: string, status = 200) => answers.push({ status, text }),
    start: () => new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))),
    stop: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections() }),
  }
}

describe('consultation assistant, AI switched off', () => {
  let t: TestApi
  before(async () => { t = await startTestApi() })
  after(() => t.close())

  async function visit() {
    const { doctorId } = await seedBasics(t)
    const patient = await newPatient(t, { name: 'No Key Patient' })
    return (await checkInOpdPaid(t, { patientId: patient.id, department: 'General Medicine', doctorId })).body.id as string
  }

  it('still sorts dictation by section words, and says how', async () => {
    const id = await visit()
    const r = await t.post(`${api}/encounters/${id}/ai/dictation`, { transcript: 'Subjective cough. Assessment bronchitis. Plan steam inhalation' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.source, 'rules')
    assert.equal(r.body.sections.assessment, 'Bronchitis.')
    const log = (await t.get(`${api}/audit-log?limit=5`)).body as { action: string; detail: string }[]
    assert.ok(log.some((l) => l.action === 'Dictation Sorted Into Note Fields' && l.detail.includes('rules')))
  })

  it('says plainly that suggestions need the AI to be switched on', async () => {
    const id = await visit()
    const r = await t.post(`${api}/encounters/${id}/ai/prescription-suggestions`, { assessment: 'viral fever' })
    assert.equal(r.status, 409)
    assert.equal(r.body.error.code, 'AI_NOT_CONFIGURED')
  })

  it('is for doctors and administrators only, and for open visits only', async () => {
    const id = await visit()
    const nurse = await t.as('nurse')
    assert.equal((await nurse.post(`${api}/encounters/${id}/ai/dictation`, { transcript: 'x' })).status, 403)
    assert.equal((await t.post(`${api}/encounters/${id}/ai/dictation`, { transcript: '' })).status, 400)
    await t.post(`${api}/encounters/${id}/close`)
    assert.equal((await t.post(`${api}/encounters/${id}/ai/dictation`, { transcript: 'cough' })).status, 409)
  })
})

describe('consultation assistant, AI switched on', () => {
  const ai = fakeAi()
  let t: TestApi
  let doctorId: string
  let visitId: string
  before(async () => {
    const url = await ai.start()
    t = await startTestApi(undefined, { ANTHROPIC_API_KEY: 'test-key', AI_MODEL: 'test-model', AI_API_URL: url })
    ;({ doctorId } = await seedBasics(t))
    await t.post(`${api}/pharmacy/drugs`, { name: 'Paracetamol 500mg', batch: 'B1', expiry: '2030-01-01', stock: 120, reorderLevel: 20, unit: 'tab', mrp: 1.5 })
    const patient = await newPatient(t, { name: 'Anita Verma', phone: '9811100033', age: 34, gender: 'F', allergies: ['Penicillin'], problemList: ['Asthma'] })
    visitId = (await checkInOpdPaid(t, { patientId: patient.id, department: 'General Medicine', doctorId })).body.id
  })
  after(async () => { await t.close(); await ai.stop() })

  it('lets the model organise a dictation, without ever sending the patient\'s identity', async () => {
    ai.reply('```json\n' + JSON.stringify({
      subjective: 'Fever for two days with body ache.', objective: 'Throat mildly congested.', assessment: 'Viral fever.', plan: 'Rest and fluids.',
      vitals: { tempF: 101.2, pulse: 96, bp: '118/76' }, orders: [{ type: 'lab', name: 'CBC' }],
    }) + '\n```')
    const r = await t.post(`${api}/encounters/${visitId}/ai/dictation`, {
      transcript: 'Anita Verma phone 9811100033 has fever two days body ache throat congested viral fever rest and fluids temperature 101.2 order CBC',
    })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.source, 'ai')
    assert.equal(r.body.sections.assessment, 'Viral fever.')
    assert.deepEqual(r.body.vitals, { tempF: 101.2, pulse: 96, bp: '118/76' })
    assert.deepEqual(r.body.orders, [{ type: 'lab', name: 'CBC' }])

    const sent = JSON.stringify(ai.requests.at(-1).body)
    assert.equal(ai.requests.at(-1).headers['x-api-key'], 'test-key')
    assert.equal(ai.requests.at(-1).body.model, 'test-model')
    assert.ok(!sent.includes('Anita') && !sent.includes('Verma'), 'no name sent')
    assert.ok(!sent.includes('9811100033'), 'no phone sent')
    assert.match(sent, /\[patient\]/)
  })

  it('falls back to section words when the model fails or rambles', async () => {
    ai.reply('sorry, I cannot', 200)
    const r = await t.post(`${api}/encounters/${visitId}/ai/dictation`, { transcript: 'Subjective cough. Plan steam' })
    assert.equal(r.body.source, 'rules')
    assert.equal(r.body.sections.plan, 'Steam')
    ai.reply('server trouble', 500)
    assert.equal((await t.post(`${api}/encounters/${visitId}/ai/dictation`, { transcript: 'Subjective cough' })).body.source, 'rules')
  })

  it('drafts a prescription and adds the checks the model cannot be trusted with', async () => {
    ai.reply(JSON.stringify({
      suggestions: [
        { drugName: 'Paracetamol 500mg', dose: '1 tab', frequency: 'three times a day', duration: '3 days', rationale: 'For fever and body ache.' },
        { drugName: 'Amoxicillin 500mg', dose: '1 cap', frequency: 'twice daily', duration: '5 days', rationale: 'Possible bacterial cause.' },
        { drugName: 'Salbutamol inhaler', dose: '2 puffs', frequency: 'as needed', duration: '5 days', rationale: 'Known asthma.' },
      ],
      advice: 'Plenty of fluids.',
    }))
    const r = await t.post(`${api}/encounters/${visitId}/ai/prescription-suggestions`, { subjective: 'Fever two days', assessment: 'Viral fever, mild asthma' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.source, 'ai')
    assert.match(r.body.disclaimer, /not part of the record/)
    assert.equal(r.body.advice, 'Plenty of fluids.')

    const [para, amox, salbu] = r.body.suggestions
    assert.equal(para.frequency, 'TDS')
    assert.deepEqual(para.pharmacy, { listed: true, stock: 120, unit: 'tab' })
    assert.equal(para.allergyWarning, null)
    assert.equal(amox.frequency, 'BD')
    assert.match(amox.allergyWarning, /Penicillin/, 'the system, not the model, flags the allergy')
    assert.equal(salbu.frequency, 'SOS')
    assert.equal(salbu.pharmacy.listed, false)

    const sent = JSON.stringify(ai.requests.at(-1).body)
    assert.ok(!sent.includes('Anita') && !sent.includes('9811100033'), 'no identity sent')
    assert.match(sent, /Penicillin/, 'the recorded allergy IS sent, so the model can avoid it')
    assert.match(sent, /Asthma/)
    assert.match(ai.requests.at(-1).body.messages[0].content, /"age": 34/)

    // Nothing was written to the record by the suggestion itself.
    assert.equal((await t.get(`${api}/encounters/${visitId}`)).body.prescriptions.length, 0)
    const log = (await t.get(`${api}/audit-log?limit=10`)).body as { action: string; detail: string }[]
    assert.ok(log.some((l) => l.action === 'AI Prescription Suggestions Generated' && l.detail.includes('3 suggestion')))
  })

  it('checks allergies through a brand\'s generic make-up, and flags names that are not real medicines', async () => {
    ai.reply(JSON.stringify({
      suggestions: [
        { drugName: 'Augmentin 625 Duo Tablet', dose: '1 tab', frequency: 'BD', duration: '5 days', rationale: 'x' },
        { drugName: 'Dolo 650', dose: '1 tab', frequency: 'TDS', duration: '3 days', rationale: 'x' },
        { drugName: 'Zorbaxin 10mg', dose: '1 tab', frequency: 'OD', duration: '3 days', rationale: 'x' },
      ],
      advice: '',
    }))
    const r = await t.post(`${api}/encounters/${visitId}/ai/prescription-suggestions`, { assessment: 'fever' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const [augmentin, dolo, invented] = r.body.suggestions
    assert.match(augmentin.allergyWarning, /Penicillin/, 'the brand name alone says nothing; its amoxycillin content does')
    assert.equal(augmentin.recognised, true)
    assert.equal(dolo.allergyWarning, null)
    assert.equal(dolo.recognised, true)
    assert.equal(invented.recognised, false, 'a name found in no list is flagged for the doctor')
  })

  it('records which added lines came from a suggestion the doctor chose', async () => {
    const added = await t.post(`${api}/encounters/${visitId}/prescriptions`, { drugName: 'Paracetamol 500mg', dose: '1 tab', frequency: 'TDS', duration: '3 days', aiSuggested: true })
    assert.equal(added.status, 201)
    assert.equal(added.body.aiSuggested, true)
    const own = await t.post(`${api}/encounters/${visitId}/prescriptions`, { drugName: 'Cetirizine 10mg', dose: '1 tab', frequency: 'OD', duration: '5 days' })
    assert.equal(own.body.aiSuggested, false)

    const detail = (await t.get(`${api}/encounters/${visitId}`)).body
    assert.deepEqual(detail.prescriptions.map((p: any) => p.aiSuggested), [true, false])
    const log = (await t.get(`${api}/audit-log?limit=10`)).body as { action: string; detail: string }[]
    assert.ok(log.some((l) => l.action === 'Prescription Added' && /AI-suggested, reviewed by the doctor/.test(l.detail)))
    assert.ok(log.some((l) => l.action === 'Prescription Added' && l.detail.startsWith('Cetirizine') && !/AI-suggested/.test(l.detail)))
  })

  it('flags a medicine that is already on this visit, and treats the saved note as the fallback', async () => {
    await t.call('PUT', `${api}/encounters/${visitId}/soap`, { subjective: 'Cough', objective: '', assessment: 'Bronchitis', plan: '' })
    ai.reply(JSON.stringify({ suggestions: [{ drugName: 'Paracetamol 500mg', dose: '1 tab', frequency: 'BD', duration: '2 days', rationale: 'x' }], advice: '' }))
    const r = await t.post(`${api}/encounters/${visitId}/ai/prescription-suggestions`, {})
    assert.equal(r.status, 200)
    assert.equal(r.body.suggestions[0].alreadyPrescribed, true)
    assert.match(JSON.stringify(ai.requests.at(-1).body), /Bronchitis/)
  })

  it('refuses an empty note, and reports an unreadable or unreachable AI honestly', async () => {
    const patient = await newPatient(t, { name: 'Blank Note' })
    const blank = (await checkInOpdPaid(t, { patientId: patient.id, department: 'General Medicine', doctorId })).body.id
    const empty = await t.post(`${api}/encounters/${blank}/ai/prescription-suggestions`, {})
    assert.equal(empty.status, 400)
    assert.equal(empty.body.error.code, 'NOTE_EMPTY')

    ai.reply('this is not json at all')
    const bad = await t.post(`${api}/encounters/${visitId}/ai/prescription-suggestions`, { assessment: 'fever' })
    assert.equal(bad.status, 502)
    assert.equal(bad.body.error.code, 'AI_BAD_RESPONSE')

    ai.reply('overloaded', 529)
    const down = await t.post(`${api}/encounters/${visitId}/ai/prescription-suggestions`, { assessment: 'fever' })
    assert.equal(down.status, 502)
    assert.equal(down.body.error.code, 'AI_UNAVAILABLE')

    ai.reply(JSON.stringify({ suggestions: 'none' }))
    assert.equal((await t.post(`${api}/encounters/${visitId}/ai/prescription-suggestions`, { assessment: 'fever' })).body.error.code, 'AI_BAD_RESPONSE')
  })
})
