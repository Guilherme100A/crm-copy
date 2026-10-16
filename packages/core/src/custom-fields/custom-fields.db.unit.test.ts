// Postgres real (SPEC 3.10): descrição de campo de sistema editável por empresa (T58, AC-T58-04; 17 §3.D).
import { randomBytes } from 'node:crypto'
import { companies, createDb, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ContactsError } from '../contacts/errors'
import { CustomFieldsService, SYSTEM_CUSTOM_FIELDS } from './service'

let temp: TempDatabase
let db: Database

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 4 })
}, 120_000)

afterAll(async () => {
  await db?.$client.end()
  await temp?.drop()
})

async function company(): Promise<string> {
  const slug = `c-${randomBytes(4).toString('hex')}`
  const [row] = await db.insert(companies).values({ name: slug, slug }).returning({ id: companies.id })
  return row!.id
}

const codeOf = async (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => (e instanceof ContactsError ? e.code : 'other'),
  )

describe('CustomFieldsService — campos de sistema (AC-T58-04)', () => {
  it('descrição de sistema editável por empresa; lista continua com 8 de sistema e sem duplicar', async () => {
    const fields = new CustomFieldsService(db)
    const a = await company()
    const b = await company()
    const updated = await fields.updateDescription(a, 'Response.Type', '  MIME da resposta  ')
    expect(updated).toEqual({
      key: 'response.type',
      description: 'MIME da resposta',
      example_value: null,
      system: true,
    })
    await fields.updateDescription(a, 'full_name', 'Nome do cliente')
    await fields.updateDescription(a, 'full_name', 'Nome completo do cliente') // segunda edição sobrescreve

    const list = await fields.list(a)
    expect(list.filter((f) => f.system)).toHaveLength(SYSTEM_CUSTOM_FIELDS.length)
    expect(list.filter((f) => !f.system)).toHaveLength(0)
    expect(list.find((f) => f.key === 'full_name')).toMatchObject({
      description: 'Nome completo do cliente',
      system: true,
    })
    expect(list.find((f) => f.key === 'response.type')?.description).toBe('MIME da resposta')
    // outra empresa mantém a padrão
    expect((await fields.list(b)).find((f) => f.key === 'full_name')?.description).toBe('Nome Completo')
  })

  it('descrição vazia volta à padrão; criar com chave de sistema segue proibido', async () => {
    const fields = new CustomFieldsService(db)
    const a = await company()
    await fields.updateDescription(a, 'hora', 'Hora local')
    expect((await fields.updateDescription(a, 'hora', '   ')).description).toBe('Hora (HH:mm)')
    expect((await fields.list(a)).find((f) => f.key === 'hora')?.description).toBe('Hora (HH:mm)')
    expect(await codeOf(fields.create(a, { key: 'full_name' }))).toBe('validation')
  })
})
