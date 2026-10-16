// Postgres real: listagem estendida (etiqueta no chat, etapa do kanban), export `all_except` e exclusão em massa
// em lotes, sem tocar em outra empresa.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createDb, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { ContactsService } from '../contacts/service'
import { FsExportFileStore } from '../exports/files'
import { runExportJob, runImportJob } from '../exports/runner'
import { ExportJobs, type JobActor } from '../exports/service'
import { ContactsBulkService, configureContactsBulk } from './service'
import { SelectionError, parseSelection } from './filters'

let tmp: TempDatabase
let db: Database
let dir: string
let files: FsExportFileStore
let jobs: ExportJobs
let bulk: ContactsBulkService
let contactsSvc: ContactsService
let n = 0
const progress: Array<{ processed: number }> = []
const publisher = {
  publish: async (_c: string, _t: string, data: unknown) => {
    progress.push((data as { progress: { processed: number } }).progress)
    return '1-0'
  },
} as never

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crm-t66-'))
  tmp = await createTempDatabase({ migrate: true })
  db = createDb(tmp.url, { max: 4 })
  files = new FsExportFileStore({ dir })
  jobs = new ExportJobs({ db, files })
  bulk = new ContactsBulkService(jobs)
  contactsSvc = new ContactsService({ db })
}, 60_000)
afterAll(async () => {
  configureContactsBulk({ batchSize: 200 })
  await db?.$client.end()
  await tmp?.drop()
  rmSync(dir, { recursive: true, force: true })
}, 60_000)

const one = async <T>(q: ReturnType<typeof sql>) => (await db.execute(q)).rows[0] as T

async function world() {
  n += 1
  const co = await one<{ id: string }>(sql`insert into crm.companies (name, slug) values (${`C${n}`}, ${`c-t66-${n}-${Date.now()}`}) returning id`)
  const user = await one<{ id: string }>(sql`insert into crm.users (email, password_hash, name) values (${`t66-${n}-${Date.now()}@x.test`}, 'x', 'U') returning id`)
  const conn = await one<{ id: string }>(sql`insert into crm.connections (company_id, session_id, name) values (${co.id}, ${`s-t66-${n}-${Date.now()}`}, 'Conexão teste') returning id`)
  const board = await one<{ id: string }>(sql`insert into crm.crms (company_id, name) values (${co.id}, 'Funil') returning id`)
  const column = await one<{ id: string }>(sql`insert into crm.crm_columns (company_id, crm_id, name, position) values (${co.id}, ${board.id}, 'Etapa', 0) returning id`)
  const label = await one<{ id: string }>(sql`insert into crm.labels (company_id, name, color) values (${co.id}, ${`L${n}`}, '#000000') returning id`)
  const actor: JobActor = { companyId: co.id, userId: user.id, perms: new Set(['contacts.view', 'contacts.edit', 'contacts.delete']) }
  return { co: co.id, conn: conn.id, board: board.id, column: column.id, label: label.id, actor }
}

async function contact(co: string, phone: string, extra: { name?: string; custom?: Record<string, unknown> } = {}) {
  const r = await one<{ id: string }>(
    sql`insert into crm.contacts (company_id, name, phone_e164, custom_fields, consent, consent_source) values (${co}, ${extra.name ?? phone}, ${phone}, ${JSON.stringify(extra.custom ?? {})}::jsonb, true, 'manual') returning id`,
  )
  return r.id
}
async function chat(co: string, conn: string, contactId: string) {
  const r = await one<{ id: string }>(sql`insert into crm.chats (company_id, connection_id, contact_id) values (${co}, ${conn}, ${contactId}) returning id`)
  await db.execute(sql`insert into crm.messages (company_id, chat_id, direction, sender_type, type, body, status) values (${co}, ${r.id}, 'inbound', 'contact', 'text', 'oi', 'received')`)
  return r.id
}
const count = async (table: string, co: string) => (await one<{ n: number }>(sql.raw(`select count(*)::int as n from crm.${table} where company_id = '${co}'`))).n

describe('listagem estendida (T26 + T66)', () => {
  it('etiqueta no contato OU no chat; etapa do kanban; campo personalizado contém sem caixa; busca numérica curta ignorada', async () => {
    const w = await world()
    const direct = await contact(w.co, '+5511900000001', { name: 'Direta' })
    const viaChat = await contact(w.co, '+5511900000002', { name: 'Via chat', custom: { cidade_origem: 'São PAULO' } })
    const none = await contact(w.co, '+5511900000003', { name: 'Nenhuma' })
    await db.execute(sql`insert into crm.contact_labels (company_id, contact_id, label_id) values (${w.co}, ${direct}, ${w.label})`)
    const ch = await chat(w.co, w.conn, viaChat)
    await db.execute(sql`insert into crm.chat_labels (company_id, chat_id, label_id) values (${w.co}, ${ch}, ${w.label})`)
    await db.execute(sql`insert into crm.crm_cards (company_id, crm_id, column_id, chat_id, position) values (${w.co}, ${w.board}, ${w.column}, ${ch}, 1)`)

    const ids = async (q: Parameters<ContactsService['list']>[1]) => (await contactsSvc.list(w.co, q)).items.map((c) => c.id).sort()
    expect(await ids({ page: 1, limit: 20, labelIds: [w.label] })).toEqual([direct, viaChat].sort())
    expect(await ids({ page: 1, limit: 20, crmColumnIds: [w.column] })).toEqual([viaChat])
    expect(await ids({ page: 1, limit: 20, customFieldKey: 'cidade_origem', customFieldValue: 'são paulo' })).toEqual([viaChat])
    expect(await ids({ page: 1, limit: 20, search: '12' })).toHaveLength(3)
    expect(await ids({ page: 1, limit: 20, search: '0003' })).toEqual([none])
    const skip = await contactsSvc.list(w.co, { page: 1, limit: 2, skipTotal: true })
    expect(skip.page).toMatchObject({ total_count: null, has_more: true })
    expect(skip.items).toHaveLength(2)
  })
})

describe('exportação', () => {
  it('all_except respeita filtros e exclui os ids; lista as 3 mais recentes', async () => {
    const w = await world()
    const a = await contact(w.co, '+5511900000011', { custom: { tag: 'x' } })
    const b = await contact(w.co, '+5511900000012', { custom: { tag: 'x' } })
    await contact(w.co, '+5511900000013')
    const job = await bulk.createExport(w.actor, { mode: 'all_except', except_ids: [b], filters: { custom_field_key: 'tag' }, include_custom_fields: true })
    const done = await runExportJob({ db, files }, job.id)
    expect(done).toMatchObject({ status: 'completed', row_count: 1, file_name: `customers_export_${job.id}.csv` })
    const file = await jobs.file(w.actor, job.id)
    const parts: Buffer[] = []
    for await (const c of file.stream) parts.push(c as Buffer)
    const lines = Buffer.concat(parts).toString('utf8').split('\r\n')
    expect(lines[0]).toBe('﻿Nome,Telefone,E-mail,Etiquetas,Estado,Cidade,CEP,Opt-out,Criado em,Campos personalizados')
    expect(lines[1]).toContain('+5511900000011')
    expect(lines[1]).toContain('"{""tag"":""x""}"')
    void a
    for (let i = 0; i < 3; i++) await bulk.createExport(w.actor, { mode: 'ids', ids: [a] })
    const recent = await bulk.recentExports(w.actor)
    expect(recent).toHaveLength(3)
    expect(recent.map((j) => j.id)).not.toContain(job.id)
  })

  it('seleção inválida', () => {
    expect(() => parseSelection({ mode: 'ids' })).toThrow(SelectionError)
    expect(() => parseSelection({ mode: 'tudo' })).toThrow(/mode|use/)
    expect(() => parseSelection({ mode: 'filtered', filters: { created_at_from: '2026-13-40' } })).toThrow(/data inválida/)
    expect(parseSelection({ mode: 'ids', ids: 'A0000000-0000-0000-0000-000000000000', filters: { search: 'x' } })).toEqual({
      mode: 'ids',
      filters: {},
      ids: ['a0000000-0000-0000-0000-000000000000'],
      exceptIds: [],
    })
  })
})

describe('exclusão em massa', () => {
  it('apaga em lotes contatos, chats, mensagens e cards só da empresa; ids de outra empresa ignorados', async () => {
    configureContactsBulk({ batchSize: 2 })
    const w = await world()
    const other = await world()
    const keep = await contact(w.co, '+5511900000020')
    const targets: string[] = []
    for (let i = 1; i <= 5; i++) {
      const id = await contact(w.co, `+551190000003${i}`)
      targets.push(id)
      const ch = await chat(w.co, w.conn, id)
      await db.execute(sql`insert into crm.crm_cards (company_id, crm_id, column_id, chat_id, position) values (${w.co}, ${w.board}, ${w.column}, ${ch}, ${i})`)
    }
    const foreign = await contact(other.co, '+5511900000040')
    await chat(other.co, other.conn, foreign)

    progress.length = 0
    const job = await bulk.createBulkDelete(w.actor, { version: 1, mode: 'all_except', filters: {}, except_ids: [keep, foreign] })
    const done = await runImportJob({ db, files, publisher }, job.id)
    expect(done).toMatchObject({ status: 'completed', counters: { deleted_count: 5, target_count: 5, chats_deleted: 5 } })
    expect(progress.map((p) => p.processed)).toEqual([0, 0, 2, 4, 5, 5])
    expect([await count('contacts', w.co), await count('chats', w.co), await count('messages', w.co), await count('crm_cards', w.co)]).toEqual([1, 0, 0, 0])
    expect([await count('contacts', other.co), await count('chats', other.co), await count('messages', other.co)]).toEqual([1, 1, 1])

    const byIds = await bulk.createBulkDelete(w.actor, { version: 1, mode: 'ids', ids: [keep, foreign] })
    expect((await runImportJob({ db, files }, byIds.id))?.counters).toMatchObject({ deleted_count: 1, target_count: 1 })
    expect(await count('contacts', other.co)).toBe(1)
  })

  it('manifesto inválido', async () => {
    const w = await world()
    await expect(bulk.createBulkDelete(w.actor, null)).rejects.toThrow(/manifesto/)
    await expect(bulk.createBulkDelete(w.actor, { version: 2, mode: 'ids', ids: [] })).rejects.toThrow(/versão/)
    await expect(bulk.createBulkDelete(w.actor, { mode: 'filtered' })).rejects.toThrow(/use ids, all_except/)
    await expect(bulk.createBulkDelete({ ...w.actor, perms: new Set(['contacts.view']) }, { mode: 'ids', ids: ['00000000-0000-0000-0000-000000000000'] })).rejects.toMatchObject({ code: 'forbidden' })
  })
})
