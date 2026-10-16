// Postgres real: export `kanban_cards` (T76) com os filtros do quadro, ordem das etapas, etiquetas e outra empresa.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chatLabels, chats, companies, connections, contacts, createDb, labels, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { FsExportFileStore } from '../exports/files'
import { getExportKind } from '../exports/registry'
import { runExportJob } from '../exports/runner'
import { ExportJobs, type JobActor } from '../exports/service'
import { KanbanError } from './errors'
import { KANBAN_EXPORT_KIND, parseKanbanExportFilters } from './export'
import { KanbanService, systemActor } from './service'

let tmp: TempDatabase
let db: Database
let dir: string
let files: FsExportFileStore
let jobs: ExportJobs
let n = 0

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crm-t76-'))
  tmp = await createTempDatabase({ migrate: true })
  db = createDb(tmp.url, { max: 4 })
  files = new FsExportFileStore({ dir })
  jobs = new ExportJobs({ db, files })
}, 60_000)
afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
  rmSync(dir, { recursive: true, force: true })
}, 60_000)

async function company() {
  n += 1
  const [c] = await db.insert(companies).values({ name: `E${n}`, slug: `e-t76-${n}-${Date.now()}` }).returning()
  return c!.id
}

async function chat(companyId: string, name: string) {
  n += 1
  const [ct] = await db.insert(contacts).values({ companyId, name, phoneE164: `+55119666${String(n).padStart(5, '0')}` }).returning()
  const [conn] = await db.insert(connections).values({ companyId, sessionId: `s-${crypto.randomUUID()}`, name: 'Conexão' }).returning()
  const [ch] = await db.insert(chats).values({ companyId, connectionId: conn!.id, contactId: ct!.id }).returning()
  return ch!.id
}

async function csv(actor: JobActor, filters: Record<string, unknown>) {
  const job = await jobs.create(actor, KANBAN_EXPORT_KIND, filters)
  const done = await runExportJob({ db, files }, job.id)
  if (done?.status !== 'completed') return { done, lines: [] as string[] }
  const file = await jobs.file(actor, job.id)
  const parts: Buffer[] = []
  for await (const c of file.stream) parts.push(c as Buffer)
  return { done, lines: Buffer.concat(parts).toString('utf8').replace(/^\uFEFF/, '').split('\r\n').filter(Boolean) }
}

describe('export kanban_cards', () => {
  it('registrado com permissão kanban.view', () => {
    expect(getExportKind(KANBAN_EXPORT_KIND)?.permission).toBe('kanban.view')
  })

  it('exporta na ordem do quadro, com etiquetas e valor; respeita etapa e etiquetas; não vaza outra empresa', async () => {
    const co = await company()
    const other = await company()
    const svc = new KanbanService({ db })
    const sys = systemActor(co)
    const board = await svc.createBoard(sys, { name: 'Vendas' })
    const [novo, , ganho] = board.columns
    const a = await chat(co, 'Ana')
    const b = await chat(co, 'Bruno')
    const c = await chat(co, 'Carla')
    await svc.createCard(sys, board.id, { chatId: c, columnId: ganho!.id, valueCents: 150_050 })
    await svc.createCard(sys, board.id, { chatId: a, columnId: novo!.id, valueCents: 1000 })
    await svc.createCard(sys, board.id, { chatId: b, columnId: novo!.id })
    const [vip] = await db.insert(labels).values({ companyId: co, name: 'VIP', color: '#22c55e' }).returning()
    const [quente] = await db.insert(labels).values({ companyId: co, name: 'Quente', color: '#ef4444' }).returning()
    await db.insert(chatLabels).values([
      { companyId: co, chatId: a, labelId: vip!.id },
      { companyId: co, chatId: a, labelId: quente!.id },
      { companyId: co, chatId: c, labelId: vip!.id },
    ])
    // Outra empresa com quadro próprio: não entra.
    const otherBoard = await svc.createBoard(systemActor(other), { name: 'X' })
    await svc.createCard(systemActor(other), otherBoard.id, { chatId: await chat(other, 'Zé') })

    const actor: JobActor = { companyId: co, userId: null, perms: new Set(['kanban.view']) }
    const all = await csv(actor, { crm_id: board.id })
    expect(all.done).toMatchObject({ status: 'completed', row_count: 3, file_name: expect.stringMatching(/^kanban_leads_.+\.csv$/) })
    expect(all.lines[0]).toBe('Nome,Telefone,Etapa,Valor,Moeda,Etiquetas,Atualizado em')
    expect(all.lines.slice(1).map((l) => l.split(',').slice(0, 4))).toEqual([
      ['Ana', expect.stringMatching(/^\+55/), 'Novo', '10.00'],
      ['Bruno', expect.stringMatching(/^\+55/), 'Novo', '0.00'],
      ['Carla', expect.stringMatching(/^\+55/), 'Ganho', '1500.50'],
    ])
    expect(all.lines[1]).toContain('Quente | VIP')

    expect((await csv(actor, { crm_id: board.id, column_id: ganho!.id })).lines.slice(1).map((l) => l.split(',')[0])).toEqual(['Carla'])
    expect((await csv(actor, { crm_id: board.id, label_ids: [quente!.id] })).lines.slice(1).map((l) => l.split(',')[0])).toEqual(['Ana'])
    expect((await csv(actor, { crm_id: board.id, updated_from: '2099-01-01T00:00:00.000Z' })).done).toMatchObject({ status: 'completed', row_count: 0 })
    // Quadro de outra empresa: o job falha (não encontrado).
    expect((await csv(actor, { crm_id: otherBoard.id })).done?.status).toBe('failed')
  })

  it('filtros validados', () => {
    expect(() => parseKanbanExportFilters({})).toThrow(KanbanError)
    expect(() => parseKanbanExportFilters({ crm_id: 'x' })).toThrow(KanbanError)
    const id = crypto.randomUUID()
    expect(() => parseKanbanExportFilters({ crm_id: id, updated_from: '2026-02-01', updated_to: '2026-01-01' })).toThrow(/antes do início/)
    expect(() => parseKanbanExportFilters({ crm_id: id, assigned_to: 'fulano' })).toThrow(KanbanError)
    expect(parseKanbanExportFilters({ crm_id: id, label_ids: `${id},${id}`, assigned_to: 'me', column_id: '' })).toEqual({ crm_id: id, label_ids: [id], assigned_to: 'me' })
  })
})
