import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { salariedAttendance } from '../../src/hospital/modules/payroll/payroll.service.js'
import { checkInOpdPaid, newPatient, seedBasics, startTestApi, type TestApi, stopServer } from './helpers.js'

// One application per test file, shared by its describe blocks: stop it when they are all done.
after(stopServer)

const api = '/api/v1'

// The hospital's calendar month (IST), which is what payroll uses to count consultations.
const thisMonth = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7)

describe('pay rules', () => {
  it('credits each shift, so a double shift earns more than one day', () => {
    const result = salariedAttendance(
      [
        { date: '2026-10-01', status: 'present' },
        { date: '2026-10-01', status: 'present' }, // second shift the same day
        { date: '2026-10-02', status: 'present' },
        { date: '2026-10-03', status: 'half_day' },
        { date: '2026-10-04', status: 'leave' },
      ],
      26000,
    )
    assert.deepEqual(result, { daysPresent: 3.5, doubleShiftDays: 1, grossPay: 3500 })
  })

  it('assumes a full month when no attendance was recorded', () => {
    assert.deepEqual(salariedAttendance([], 26000), { daysPresent: 26, doubleShiftDays: 0, grossPay: 26000 })
  })
})

describe('supplies', () => {
  let t: TestApi
  before(async () => { t = await startTestApi() })
  after(() => t.close())

  it('adds items, issues and restocks them, and keeps a log', async () => {
    const item = (await t.post(`${api}/supplies`, { name: 'Gauze Rolls', category: 'Surgical Consumables', unit: 'roll', stock: 50, reorderLevel: 20, location: 'Central Store' })).body
    assert.equal(item.stock, 50)

    const nurse = await t.as('nurse')
    const issued = await nurse.post(`${api}/supplies/${item.id}/issue`, { qty: 35, department: 'Ward A' })
    assert.equal(issued.status, 200)
    assert.equal(issued.body.stock, 15)

    const tooMany = await nurse.post(`${api}/supplies/${item.id}/issue`, { qty: 16, department: 'Ward A' })
    assert.equal(tooMany.status, 409)
    assert.match(tooMany.body.error.message, /Only 15 roll of Gauze Rolls in stock/)

    const low = (await t.get(`${api}/supplies?lowStock=true`)).body as { id: string }[]
    assert.ok(low.some((s) => s.id === item.id), 'now below its reorder level')

    const restocked = await t.post(`${api}/supplies/${item.id}/restock`, { qty: 100 })
    assert.equal(restocked.body.stock, 115)

    const log = (await t.get(`${api}/supplies/log?supplyId=${item.id}`)).body as { type: string; qty: number; by: string }[]
    assert.deepEqual(log.map((l) => [l.type, l.qty]), [['restock', 100], ['issue', 35]], 'newest first')
    assert.equal(log[1]!.by, 'Test nurse')
  })

  it('validates input and limits who can do what', async () => {
    const nurse = await t.as('nurse')
    const biller = await t.as('biller')
    const item = (await t.post(`${api}/supplies`, { name: 'Tape', category: 'PPE', unit: 'roll', stock: 5, reorderLevel: 1, location: 'Central Store' })).body
    assert.equal((await t.post(`${api}/supplies`, { name: 'X', category: 'Furniture', unit: 'pc', location: 'Y' })).status, 400)
    assert.equal((await t.post(`${api}/supplies/${item.id}/issue`, { qty: 0, department: 'Ward A' })).status, 400)
    assert.equal((await nurse.post(`${api}/supplies/${item.id}/restock`, { qty: 5 })).status, 403, 'only the store restocks')
    assert.equal((await nurse.post(`${api}/supplies`, { name: 'Y', category: 'PPE', unit: 'pc', location: 'Z' })).status, 403)
    assert.equal((await biller.get(`${api}/supplies`)).status, 403)
    assert.equal((await t.post(`${api}/supplies/00000000-0000-4000-8000-000000000000/issue`, { qty: 1, department: 'A' })).status, 404)
  })
})

describe('bio-medical waste', () => {
  let t: TestApi
  before(async () => { t = await startTestApi() })
  after(() => t.close())

  it('carries a batch through segregation, storage, pre-treatment and disposal, in order', async () => {
    const keeper = await t.as('housekeeping')
    const batch = (await keeper.post(`${api}/waste`, { category: 'white', department: 'OT', weightKg: 1.5 })).body
    assert.equal(batch.stage, 'segregated')
    assert.equal(batch.segregatedBy, 'Test housekeeping')

    // Steps cannot be skipped or repeated.
    assert.equal((await keeper.post(`${api}/waste/${batch.id}/pretreat`, { method: 'Autoclave' })).status, 409)
    assert.equal((await keeper.post(`${api}/waste/${batch.id}/dispose`, { vendor: 'V', manifestNo: 'M1' })).status, 409)

    const stored = await keeper.post(`${api}/waste/${batch.id}/store`, { location: 'BMW Room' })
    assert.equal(stored.body.stage, 'stored')
    assert.equal(stored.body.storageLocation, 'BMW Room')
    assert.equal((await keeper.post(`${api}/waste/${batch.id}/store`, { location: 'BMW Room' })).status, 409)

    const treated = await keeper.post(`${api}/waste/${batch.id}/pretreat`, { method: 'Autoclave' })
    assert.equal(treated.body.stage, 'pretreated')
    assert.equal(treated.body.pretreatedBy, 'Test housekeeping')

    const disposed = await keeper.post(`${api}/waste/${batch.id}/dispose`, { vendor: 'GreenCycle Pvt Ltd', manifestNo: 'MAN-2026-001' })
    assert.equal(disposed.body.stage, 'disposed')
    assert.equal(disposed.body.manifestNo, 'MAN-2026-001')
    assert.equal((await keeper.post(`${api}/waste/${batch.id}/dispose`, { vendor: 'V', manifestNo: 'M2' })).status, 409, 'already disposed')
  })

  it('allows disposal straight from storage when no pre-treatment is needed', async () => {
    const batch = (await t.post(`${api}/waste`, { category: 'yellow', department: 'Ward A', weightKg: 3 })).body
    await t.post(`${api}/waste/${batch.id}/store`, { location: 'BMW Room' })
    assert.equal((await t.post(`${api}/waste/${batch.id}/dispose`, { vendor: 'V', manifestNo: 'M3' })).body.stage, 'disposed')
  })

  it('summarises by colour, filters by stage and limits who can log waste', async () => {
    const summary = (await t.get(`${api}/waste/summary`)).body as { category: string; batches: number; totalKg: number; awaitingDisposal: number }[]
    const yellow = summary.find((s) => s.category === 'yellow')!
    assert.equal(yellow.totalKg, 3)
    assert.equal(yellow.awaitingDisposal, 0)
    const stillOpen = (await t.get(`${api}/waste?stage=segregated`)).body as unknown[]
    assert.equal(stillOpen.length, 0)

    const frontOffice = await t.as('front_office')
    const pharmacist = await t.as('pharmacist')
    assert.equal((await frontOffice.get(`${api}/waste`)).status, 200, 'front office can watch')
    assert.equal((await frontOffice.post(`${api}/waste`, { category: 'red', department: 'X', weightKg: 1 })).status, 403)
    assert.equal((await pharmacist.get(`${api}/waste`)).status, 403)
    assert.equal((await t.post(`${api}/waste`, { category: 'red', department: 'X', weightKg: 0 })).status, 400)
    assert.equal((await t.post(`${api}/waste`, { category: 'green', department: 'X', weightKg: 1 })).status, 400)
  })
})

describe('roster', () => {
  let t: TestApi
  let nurseId: string
  before(async () => {
    t = await startTestApi()
    nurseId = (await t.post(`${api}/staff`, { name: 'Roster Nurse', role: 'nurse', department: 'Ward A' })).body.id
  })
  after(() => t.close())

  it('toggles an assignment on and off, and allows a double shift', async () => {
    const add = await t.post(`${api}/roster/toggle`, { staffId: nurseId, date: '2030-01-07', shift: 'morning', department: 'Ward A' })
    assert.equal(add.body.assigned, true)
    await t.post(`${api}/roster/toggle`, { staffId: nurseId, date: '2030-01-07', shift: 'evening', department: 'Ward A' })

    const week = (await t.get(`${api}/roster?from=2030-01-07&to=2030-01-13`)).body as { shift: string; staffName: string; date: string }[]
    assert.deepEqual(week.map((r) => r.shift), ['morning', 'evening'])
    assert.equal(week[0]!.staffName, 'Roster Nurse')
    assert.equal(week[0]!.date, '2030-01-07')

    const remove = await t.post(`${api}/roster/toggle`, { staffId: nurseId, date: '2030-01-07', shift: 'evening', department: 'Ward A' })
    assert.equal(remove.body.assigned, false)
    assert.equal(((await t.get(`${api}/roster?from=2030-01-07&to=2030-01-13`)).body as unknown[]).length, 1)
  })

  it('copies a week onto another without duplicating', async () => {
    const first = await t.post(`${api}/roster/copy-week`, { fromStart: '2030-01-07', toStart: '2030-01-14' })
    assert.equal(first.body.copied, 1)
    const again = await t.post(`${api}/roster/copy-week`, { fromStart: '2030-01-07', toStart: '2030-01-14' })
    assert.equal(again.body.copied, 0)
    const next = (await t.get(`${api}/roster?from=2030-01-14&to=2030-01-20`)).body as { date: string }[]
    assert.equal(next[0]!.date, '2030-01-14')
    assert.equal((await t.post(`${api}/roster/copy-week`, { fromStart: '2030-01-07', toStart: '2030-01-07' })).status, 400)
  })

  it('lets everyone view but only planners edit, and refuses deactivated staff', async () => {
    const doctor = await t.as('doctor')
    const frontOffice = await t.as('front_office')
    assert.equal((await doctor.get(`${api}/roster?from=2030-01-07&to=2030-01-13`)).status, 200)
    assert.equal((await doctor.post(`${api}/roster/toggle`, { staffId: nurseId, date: '2030-01-09', shift: 'night', department: 'Ward A' })).status, 403)
    assert.equal((await frontOffice.post(`${api}/roster/toggle`, { staffId: nurseId, date: '2030-01-09', shift: 'night', department: 'Ward A' })).status, 200)

    await t.call('PATCH', `${api}/staff/${nurseId}`, { active: false })
    const blocked = await t.post(`${api}/roster/toggle`, { staffId: nurseId, date: '2030-01-10', shift: 'night', department: 'Ward A' })
    assert.equal(blocked.status, 400)
    assert.equal((await t.post(`${api}/roster/toggle`, { staffId: nurseId, date: 'tomorrow', shift: 'night', department: 'A' })).status, 400)
  })
})

describe('attendance and payroll', () => {
  let t: TestApi
  let nurseId: string
  let doctorId: string
  let idleId: string

  before(async () => {
    t = await startTestApi()
    nurseId = (await t.post(`${api}/staff`, { name: 'Pay Nurse', role: 'nurse', department: 'Ward A', monthlySalary: 26000 })).body.id
    idleId = (await t.post(`${api}/staff`, { name: 'No Records Clerk', role: 'front_office', department: 'Registration', monthlySalary: 13000 })).body.id
    doctorId = (await t.post(`${api}/staff`, {
      name: 'Dr. Visiting', role: 'doctor', department: 'General Medicine', employmentType: 'visiting_fee', feePerConsult: 500,
    })).body.id
  })
  after(() => t.close())

  const mark = (staffId: string, day: string, shift: string, status: string) =>
    t.call('PUT', `${api}/payroll/attendance`, { staffId, date: `${thisMonth}-${day}`, shift, status })

  it('keeps only the last four digits of a bank account, visible to administrators only', async () => {
    const created = await t.post(`${api}/staff`, { name: 'Bank Check', role: 'nurse', department: 'Ward B', bankAccountLast4: '4321' })
    assert.equal(created.body.bankAccountLast4, '4321')
    assert.equal((await t.post(`${api}/staff`, { name: 'Bad Bank', role: 'nurse', department: 'Ward B', bankAccountLast4: '123456789012' })).status, 400)
    const updated = await t.call('PATCH', `${api}/staff/${created.body.id}`, { bankAccountLast4: '9876' })
    assert.equal(updated.body.bankAccountLast4, '9876')
    const asNurse = (await (await t.as('nurse')).get(`${api}/staff/${created.body.id}`)).body
    assert.equal(asNurse.bankAccountLast4, null)
  })

  it('records attendance per shift and replaces an earlier mark', async () => {
    assert.equal((await mark(nurseId, '01', 'morning', 'present')).status, 200)
    assert.equal((await mark(nurseId, '01', 'evening', 'present')).status, 200)
    assert.equal((await mark(nurseId, '02', 'morning', 'present')).status, 200)
    assert.equal((await mark(nurseId, '03', 'morning', 'half_day')).status, 200)
    assert.equal((await mark(nurseId, '04', 'morning', 'present')).status, 200)
    assert.equal((await mark(nurseId, '04', 'morning', 'leave')).status, 200, 'the same shift is replaced, not duplicated')

    const rows = (await t.get(`${api}/payroll/attendance?month=${thisMonth}&staffId=${nurseId}`)).body as { date: string; shift: string; status: string }[]
    assert.equal(rows.length, 5)
    assert.equal(rows.find((r) => r.date.endsWith('-04'))!.status, 'leave')
    assert.equal((await mark(nurseId, '05', 'dawn', 'present')).status, 400)
    assert.equal((await t.get(`${api}/payroll/attendance?month=2026-13`)).status, 400)
  })

  it('generates a payroll run from "Attendance", double shifts and consultation fees', async () => {
    // Two finished OPD consultations by the visiting doctor this month.
    for (const name of ['Patient One', 'Patient Two']) {
      const patient = await newPatient(t, { name })
      const visit = (await checkInOpdPaid(t, { patientId: patient.id, department: 'General Medicine', doctorId })).body
      await t.post(`${api}/encounters/${visit.id}/start`)
      assert.equal((await t.post(`${api}/encounters/${visit.id}/close`)).status, 200)
    }
    // A consultation that is still waiting does not count.
    await checkInOpdPaid(t, { patientId: (await newPatient(t, { name: 'Waiting' })).id, department: 'General Medicine', doctorId })

    const created = await t.post(`${api}/payroll/runs`, { month: thisMonth })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const lines = created.body.lines as Record<string, any>[]
    const byStaff = (id: string) => lines.find((l) => l.staffId === id)!

    const nurse = byStaff(nurseId)
    assert.equal(nurse.daysPresent, 3.5) // 2 (double shift) + 1 + 0.5 + 0 (leave)
    assert.equal(nurse.doubleShiftDays, 1)
    assert.equal(nurse.grossPay, 3500)
    assert.equal(nurse.netPay, 3500)

    assert.equal(byStaff(idleId).daysPresent, 26, 'no attendance recorded: full month')
    assert.equal(byStaff(idleId).grossPay, 13000)

    const doctor = byStaff(doctorId)
    assert.equal(doctor.consultCount, 2)
    assert.equal(doctor.grossPay, 1000)

    assert.equal(created.body.status, 'draft')
    assert.equal(created.body.totalGross, lines.reduce((sum, l) => sum + l.grossPay, 0))
  })

  it('allows one run per month and manages deductions on drafts', async () => {
    const run = (await t.get(`${api}/payroll/runs`)).body[0]
    assert.equal(run.month, thisMonth)
    assert.equal((await t.post(`${api}/payroll/runs`, { month: thisMonth })).status, 409)
    assert.equal((await t.post(`${api}/payroll/runs`, { month: '2026-1' })).status, 400)

    assert.equal((await t.call('PATCH', `${api}/payroll/runs/${run.id}/lines/${nurseId}`, { deductions: 4000 })).status, 400, 'more than gross')
    assert.equal((await t.call('PATCH', `${api}/payroll/runs/${run.id}/lines/${nurseId}`, { deductions: -5 })).status, 400)
    const updated = await t.call('PATCH', `${api}/payroll/runs/${run.id}/lines/${nurseId}`, { deductions: 500 })
    assert.equal(updated.body.lines.find((l: any) => l.staffId === nurseId).netPay, 3000)
    assert.equal(updated.body.totalNet, updated.body.totalGross - 500)
  })

  it('moves draft -> finalized -> paid in order, then locks the figures', async () => {
    const run = (await t.get(`${api}/payroll/runs`)).body[0]
    assert.equal((await t.post(`${api}/payroll/runs/${run.id}/pay`)).status, 409, 'must be finalized first')
    assert.equal((await t.post(`${api}/payroll/runs/${run.id}/finalize`)).body.status, 'finalized')
    assert.equal((await t.post(`${api}/payroll/runs/${run.id}/finalize`)).status, 409)

    assert.equal((await t.call('PATCH', `${api}/payroll/runs/${run.id}/lines/${nurseId}`, { deductions: 1 })).status, 409)
    assert.equal((await t.call('DELETE', `${api}/payroll/runs/${run.id}`)).status, 409)
    assert.equal((await mark(nurseId, '06', 'morning', 'present')).status, 409, 'attendance is locked for a finalized month')

    assert.equal((await t.post(`${api}/payroll/runs/${run.id}/pay`)).body.status, 'paid')
    // The saved payslip does not change when a salary changes later.
    await t.call('PATCH', `${api}/staff/${nurseId}`, { monthlySalary: 99999 })
    const saved = (await t.get(`${api}/payroll/runs/${run.id}`)).body
    assert.equal(saved.lines.find((l: any) => l.staffId === nurseId).grossPay, 3500)
  })

  it('lets a draft be deleted and generated again, and is for administrators only', async () => {
    const nextMonth = '2031-02'
    const draft = (await t.post(`${api}/payroll/runs`, { month: nextMonth })).body
    assert.equal((await t.call('DELETE', `${api}/payroll/runs/${draft.id}`)).status, 204)
    assert.equal((await t.post(`${api}/payroll/runs`, { month: nextMonth })).status, 201)

    const nurse = await t.as('nurse')
    assert.equal((await nurse.get(`${api}/payroll/runs`)).status, 403)
    assert.equal((await nurse.get(`${api}/payroll/attendance?month=${thisMonth}`)).status, 403)
    assert.equal((await nurse.post(`${api}/payroll/runs`, { month: '2032-01' })).status, 403)
  })
})

describe('housekeeping log and dashboard', () => {
  let t: TestApi
  let ids: Awaited<ReturnType<typeof seedBasics>>
  before(async () => {
    t = await startTestApi()
    ids = await seedBasics(t)
  })
  after(() => t.close())

  it('logs discharge release and each cleaning step, newest first', async () => {
    const patient = await newPatient(t)
    const stay = (await t.post(`${api}/encounters/ipd`, { patientId: patient.id, department: 'General Medicine', doctorId: ids.doctorId, bedId: ids.bedA })).body

    const dash = (await (await t.as('biller')).get(`${api}/dashboard`)).body
    assert.equal(dash.bedsTotal, 2)
    assert.equal(dash.bedsOccupied, 1)
    assert.equal(dash.occupancyPct, 50)

    assert.equal((await t.post(`${api}/encounters/${stay.id}/discharge`, { summary: 'Recovered well' })).status, 200)
    const keeper = await t.as('housekeeping')
    assert.equal((await keeper.post(`${api}/beds/${ids.bedA}/start-cleaning`)).status, 200)
    assert.equal((await keeper.post(`${api}/beds/${ids.bedA}/complete-cleaning`)).status, 200)

    const log = (await keeper.get(`${api}/beds/housekeeping-log`)).body as { action: string; ward: string; bedNo: string; by: string }[]
    assert.deepEqual(log.map((l) => l.action), ['cleaning_completed', 'cleaning_started', 'discharge_release'])
    assert.equal(log[0]!.bedNo, 'A-01')
    assert.equal(log[0]!.by, 'Test housekeeping')
  })

  it('summarises the day for any signed-in role', async () => {
    const dash = (await (await t.as('pharmacist')).get(`${api}/dashboard`)).body
    for (const key of ['opdWaiting', 'erActive', 'erRedTriage', 'bedsTotal', 'bedsOccupied', 'occupancyPct', 'patients', 'abhaLinkedPct', 'draftBills', 'lowStockDrugs', 'lowStockSupplies', 'wasteAwaitingDisposal']) {
      assert.equal(typeof dash[key], 'number', key)
    }
    assert.equal(dash.draftBills, 1, 'the discharge raised a draft bill')
  })
})

describe('bed transfer and detailed visit lists', () => {
  let t: TestApi
  let ids: Awaited<ReturnType<typeof seedBasics>>
  before(async () => {
    t = await startTestApi()
    ids = await seedBasics(t)
  })
  after(() => t.close())

  it('moves an inpatient to another vacant bed and sends the old bed to housekeeping', async () => {
    const patient = await newPatient(t, { name: 'Transfer Patient' })
    const stay = (await t.post(`${api}/encounters/ipd`, { patientId: patient.id, department: 'General Medicine', doctorId: ids.doctorId, bedId: ids.bedA })).body

    const moved = await t.post(`${api}/encounters/${stay.id}/transfer-bed`, { bedId: ids.bedB })
    assert.equal(moved.status, 200, JSON.stringify(moved.body))
    assert.equal(moved.body.bedId, ids.bedB)

    const beds = (await t.get(`${api}/beds`)).body as { id: string; status: string; encounterId: string | null }[]
    assert.equal(beds.find((b) => b.id === ids.bedB)!.status, 'occupied')
    assert.equal(beds.find((b) => b.id === ids.bedB)!.encounterId, stay.id)
    assert.equal(beds.find((b) => b.id === ids.bedA)!.status, 'dirty')

    const log = (await t.get(`${api}/beds/housekeeping-log`)).body as { action: string; bedNo: string }[]
    assert.equal(log[0]!.action, 'discharge_release')
    assert.equal(log[0]!.bedNo, 'A-01')
  })

  it('refuses a bad transfer', async () => {
    const patient = await newPatient(t, { name: 'Second Patient' })
    const bedC = (await t.post(`${api}/beds`, { ward: 'Ward A', bedNo: 'A-03' })).body.id as string
    const stay = (await t.post(`${api}/encounters/ipd`, { patientId: patient.id, department: 'General Medicine', doctorId: ids.doctorId, bedId: bedC })).body
    // bedB is taken by the first patient, so it is not vacant.
    assert.equal((await t.post(`${api}/encounters/${stay.id}/transfer-bed`, { bedId: ids.bedB })).status, 409)
    assert.equal((await t.post(`${api}/encounters/${stay.id}/transfer-bed`, { bedId: bedC })).status, 400, 'already there')

    const opd = (await checkInOpdPaid(t, { patientId: patient.id, department: 'General Medicine', doctorId: ids.doctorId })).body
    assert.equal((await t.post(`${api}/encounters/${opd.id}/transfer-bed`, { bedId: ids.bedA })).status, 400, 'only inpatients have beds')
  })

  it('lists visits with their full detail in one call', async () => {
    const patient = await newPatient(t, { name: 'Detail Patient' })
    const visit = (await checkInOpdPaid(t, { patientId: patient.id, department: 'General Medicine', doctorId: ids.doctorId })).body
    await t.post(`${api}/encounters/${visit.id}/vitals`, { tempF: 98.6, pulse: 80, bp: '120/80', spo2: 98 })
    await t.post(`${api}/encounters/${visit.id}/orders`, { type: 'lab', name: 'CBC' })

    const plain = (await t.get(`${api}/encounters?patientId=${patient.id}`)).body[0]
    assert.equal(plain.vitals, undefined)
    const detailed = (await t.get(`${api}/encounters?patientId=${patient.id}&detail=true`)).body[0]
    assert.equal(detailed.vitals.length, 1)
    assert.equal(detailed.vitals[0].tempF, 98.6)
    assert.equal(detailed.orders[0].name, 'CBC')
    assert.equal((await t.get(`${api}/encounters?detail=maybe`)).status, 400)
  })
})
