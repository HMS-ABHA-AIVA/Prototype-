import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { newPatient, seedBasics, startTestApi, stopServer } from './helpers.js'

// This file runs the application with no document storage configured (the production default until one is chosen).
after(stopServer)

const api = '/api/v1'
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n')

describe('Documents when no storage is set up', () => {
  it('say so plainly instead of pretending to save', async () => {
    const t = await startTestApi(undefined, { FILE_STORE: 'none' })
    try {
      const { doctorId, bedA } = await seedBasics(t)
      const patient = await newPatient(t, { name: 'No Store' })
      const stay = (await t.post(`${api}/encounters/ipd`, { patientId: patient.id, department: 'Medicine', doctorId, bedId: bedA })).body.id
      const response = await fetch(`${t.api.url}${api}/ipd/${stay}/documents?title=Anything`, { method: 'POST', headers: { 'Content-Type': 'application/pdf', Authorization: `Bearer ${t.token}` }, body: new Uint8Array(PDF) })
      assert.equal(response.status, 503)
      assert.equal(((await response.json()) as any).error.code, 'STORAGE_NOT_CONFIGURED')
    } finally {
      await t.close()
    }
  })
})
