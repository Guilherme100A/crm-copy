// Postgres real + arquivos em diretório temporário: criação, execução em streaming, progresso, falha sem arquivo
// parcial, acesso (criador/permissão/outra empresa) e lista dos mais recentes.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { companies, createDb, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { FsExportFileStore } from './files'
import { registerExportKind, registerImportKind } from './registry'
import { runExportJob, runImportJob } from './runner'
import { ExportJobs, JobsError, type JobActor } from './service'

let tmp: TempDatabase
let db: Database
let dir: string
let files: FsExportFileStore
let jobs: ExportJobs
const enqueued: string[] = []
const published: Array<{ companyId: string; type: string; data: { progress: { processed: number; percent: number | null } } & Record<string, unknown>; userId?: string }> = []
const publisher = {
  publish: async (companyId: string, type: string, data: unknown, opts: { userId?: string } = {}) => {
    published.push({ companyId, type, data: data as (typeof published)[number]['data'], userId: opts.userId })
    return '1-0'
  },
} as never
const offs: Array<() => void> = []
let n = 0

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crm-t27-'))
  tmp = await createTempDatabase({ migrate: true })
  db = createDb(tmp.url, { max: 4 })
  files = new FsExportFileStore({ dir })
  jobs = new ExportJobs({ db, files, enqueue: async (_t, d) => void enqueued.push(d.jobId) })
  offs.push(
    registerExportKind<{ id: number; name: string }>('t27u_rows', {
      permission: 'contacts.view',
      columns: [
        { key: 'id', header: 'ID' },
        { key: 'name', header: 'Nome', format: (v) => String(v).toUpperCase() },
      ],
      count: async (ctx) => Number(ctx.filters.n),
      async *query(ctx) {
        for (let i = 1; i <= Number(ctx.filters.n); i++) yield { id: i, name: `n${i}` }
      },
      fileName: (id) => `linhas_${id}.csv`,
    }),
    registerExportKind('t27u_nocount', {
      permission: 'contacts.view',
      columns: [{ key: 'id', header: 'ID' }],
      async *query() {
        for (let i = 1; i <= 2500; i++) yield { id: i }
      },
    }),
    registerExportKind('t27u_boom', {
      permission: 'contacts.view',
      columns: [{ key: 'id', header: 'ID' }],
      count: async () => 100,
      async *query() {
        for (let i = 1; i <= 40; i++) yield { id: i }
        throw new Error('falhou no meio')
      },
    }),
    registerImportKind('t27u_import', {
      permission: 'contacts.edit',
      run: async (ctx) => {
        for (let i = 1; i <= 10; i++) await ctx.progress({ processed: i, total: 10, counters: { created: i } })
        return { counters: { created: 10, skipped: 0 }, rowCount: 10 }
      },
    }),
  )
}, 60_000)
afterAll(async () => {
  for (const off of offs) off()
  await db?.$client.end()
  await tmp?.drop()
  rmSync(dir, { recursive: true, force: true })
}, 60_000)

async function company() {
  n += 1
  const [c] = await db.insert(companies).values({ name: `C${n}`, slug: `c-t27-${n}-${Date.now()}` }).returning()
  return c!.id
}
async function user() {
  n += 1
  const [u] = await db.insert(users).values({ email: `t27-${n}-${Date.now()}@x.test`, passwordHash: 'x', name: 'U' }).returning()
  return u!.id
}
const actor = (companyId: string, userId: string | null, perms: string[] = ['contacts.view', 'contacts.edit']): JobActor => ({ companyId, userId, perms: new Set(perms) })
const deps = () => ({ db, files, publisher })

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const parts: Buffer[] = []
  for await (const c of stream) parts.push(c as Buffer)
  return Buffer.concat(parts).toString('utf8')
}

describe('export', () => {
  it('10 000 linhas: completed, row_count, CSV com BOM e progresso a cada 10% + fim só para o criador', async () => {
    const co = await company()
    const u = await user()
    const job = await jobs.create(actor(co, u), 't27u_rows', { n: 10_000 }, { delimiter: ';' })
    expect(job.status).toBe('queued')
    expect(enqueued).toContain(job.id)
    published.length = 0

    const done = await runExportJob(deps(), job.id)
    expect(done).toMatchObject({ status: 'completed', row_count: 10_000, file_name: `linhas_${job.id}.csv`, download_url: `/api/jobs/${job.id}/file` })
    const percents = published.map((p) => p.data.progress.percent)
    expect(percents).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100])
    expect(published.every((p) => p.type === 'job.progress' && p.userId === u && p.companyId === co)).toBe(true)
    expect(published.at(-1)!.data).toMatchObject({ status: 'completed', row_count: 10_000 })

    const file = await jobs.file(actor(co, u), job.id)
    const text = await readAll(file.stream)
    const lines = text.split('\r\n')
    expect(lines[0]).toBe('﻿ID;Nome')
    expect(lines[1]).toBe('1;N1')
    expect(lines).toHaveLength(10_002)
    expect(file.size).toBe(Buffer.byteLength(text))
    expect(file.contentType).toBe('text/csv; charset=utf-8')
  })

  it('sem count publica a cada 1000 linhas e no fim', async () => {
    const co = await company()
    const u = await user()
    const job = await jobs.create(actor(co, u), 't27u_nocount')
    published.length = 0
    const done = await runExportJob(deps(), job.id)
    expect(done?.row_count).toBe(2500)
    expect(published.map((p) => p.data.progress.processed)).toEqual([0, 1000, 2000, 2500])
  })

  it('falha: failed com a mensagem, sem arquivo (nem temporário) e /file em conflito', async () => {
    const co = await company()
    const u = await user()
    const job = await jobs.create(actor(co, u), 't27u_boom')
    const done = await runExportJob(deps(), job.id)
    expect(done).toMatchObject({ status: 'failed', error: 'falhou no meio', file_size: null, row_count: null, download_url: null })
    expect(readdirSync(join(dir, co))).toEqual([])
    await expect(jobs.file(actor(co, u), job.id)).rejects.toMatchObject({ code: 'conflict' })
    // Job terminado não roda de novo.
    expect(await runExportJob(deps(), job.id)).toBeNull()
  })

  it('kind sem registro no processo vira failed', async () => {
    const co = await company()
    const u = await user()
    const off = registerExportKind('t27u_gone', { permission: 'contacts.view', columns: [{ key: 'id', header: 'ID' }], async *query() {} })
    const job = await jobs.create(actor(co, u), 't27u_gone')
    off()
    expect(await runExportJob(deps(), job.id)).toMatchObject({ status: 'failed', error: 'tipo de exportação não registrado: t27u_gone' })
  })

  it('criar exige a permissão do kind, kind conhecido e delimitador válido', async () => {
    const co = await company()
    const u = await user()
    await expect(jobs.create(actor(co, u, []), 't27u_rows')).rejects.toMatchObject({ code: 'forbidden' })
    await expect(jobs.create(actor(co, u), 'nao_existe')).rejects.toMatchObject({ code: 'invalid' })
    await expect(jobs.create(actor(co, u), 't27u_rows', {}, { delimiter: '|' })).rejects.toBeInstanceOf(JobsError)
  })
})

describe('acesso e lista', () => {
  it('criador ou permissão do kind; mesma empresa sem acesso → forbidden; outra empresa → not_found', async () => {
    const co = await company()
    const other = await company()
    const creator = await user()
    const colleague = await user()
    const job = await jobs.create(actor(co, creator), 't27u_rows', { n: 3 })
    await runExportJob(deps(), job.id)

    expect((await jobs.get(actor(co, creator, []), job.id)).id).toBe(job.id)
    expect((await jobs.get(actor(co, colleague), job.id)).id).toBe(job.id)
    await expect(jobs.get(actor(co, colleague, []), job.id)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(jobs.file(actor(co, colleague, []), job.id)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(jobs.get(actor(other, creator), job.id)).rejects.toMatchObject({ code: 'not_found' })
    await expect(jobs.file(actor(other, creator), job.id)).rejects.toMatchObject({ code: 'not_found' })
    await expect(jobs.get(actor(co, creator), 'nao-e-uuid')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('lista os mais recentes do kind na empresa, só os visíveis', async () => {
    const co = await company()
    const a = await user()
    const b = await user()
    const ids: string[] = []
    for (let i = 0; i < 5; i++) ids.push((await jobs.create(actor(co, a), 't27u_rows', { n: i })).id)
    await jobs.create(actor(co, a), 't27u_nocount')
    await jobs.create(actor(await company(), a), 't27u_rows')

    const items = await jobs.list(actor(co, a), { kind: 't27u_rows', limit: 3 })
    expect(items.map((j) => j.id)).toEqual(ids.slice(-3).reverse())
    expect(await jobs.list(actor(co, b, []), { kind: 't27u_rows' })).toEqual([])
    expect((await jobs.list(actor(co, a))).length).toBe(3)
  })
})

describe('import', () => {
  it('roda o kind, grava contadores e publica progresso', async () => {
    const co = await company()
    const u = await user()
    const job = await jobs.createImport(actor(co, u), 't27u_import', { inputKey: `${co}/in.csv`, options: { mode: 'upsert' } })
    expect(job.type).toBe('import')
    published.length = 0
    const done = await runImportJob(deps(), job.id)
    expect(done).toMatchObject({ status: 'completed', row_count: 10, counters: { created: 10, skipped: 0 } })
    expect(published.map((p) => p.data.progress.percent)).toEqual([null, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 100])
    await expect(jobs.createImport(actor(co, u, ['contacts.view']), 't27u_import')).rejects.toMatchObject({ code: 'forbidden' })
    expect(await runExportJob(deps(), job.id)).toBeNull()
  })
})
