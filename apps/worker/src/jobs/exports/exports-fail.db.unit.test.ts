// AC-T127-07: erro antes do runner (ou que escapa dele) deixa o job `failed` com a mensagem, não `queued` para sempre.
import { randomBytes } from 'node:crypto'
import { FsExportFileStore } from '@crm/core'
import { backgroundJobs, companies, createDb, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRegistry } from '../../registry'
import { configureExports, createExportsProcessor, registerExportsJob } from './index'

let tmp: TempDatabase
let db: Database

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true })
  db = createDb(tmp.url, { max: 3 })
}, 120_000)

afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
})

async function queuedJob(kind = 'contacts_export') {
  const tag = randomBytes(4).toString('hex')
  const [co] = await db.insert(companies).values({ name: `E${tag}`, slug: `e-t127-${tag}` }).returning({ id: companies.id })
  const [job] = await db.insert(backgroundJobs).values({ companyId: co!.id, type: 'export', kind, status: 'queued' }).returning({ id: backgroundJobs.id })
  return job!.id
}
const status = async (jobId: string) => (await db.select().from(backgroundJobs).where(eq(backgroundJobs.id, jobId)))[0]!

describe('exports: falha fora do runner', () => {
  it('erro que escapa do runner (antes do claim) → failed com a mensagem', async () => {
    const jobId = await queuedJob()
    const processor = createExportsProcessor({ db, files: new FsExportFileStore(), now: () => { throw new Error('relógio quebrado') } })
    await expect(processor({ data: { jobId } } as never, '')).rejects.toThrow('relógio quebrado')
    expect(await status(jobId)).toMatchObject({ status: 'failed', error: 'relógio quebrado', finishedAt: expect.any(Date) })
  })

  it('processo sem dependências completas: erro ao montar → failed pelo db configurado', async () => {
    const jobId = await queuedJob()
    const reg = registerExportsJob(createRegistry())
    configureExports({ db, files: { create: () => { throw new Error('disco indisponível') } } as never, now: () => { throw new Error('falha antes do runner') } })
    const exportsWorker = reg.workers.find((w) => w.name === 'exports')!
    await expect(exportsWorker.processor({ data: { jobId } } as never, '')).rejects.toThrow('falha antes do runner')
    expect(await status(jobId)).toMatchObject({ status: 'failed', error: 'falha antes do runner' })
  })

  it('kind sem processor → failed pelo runner; job já terminado não é sobrescrito', async () => {
    const jobId = await queuedJob('t127_sem_kind')
    const processor = createExportsProcessor({ db, files: new FsExportFileStore() })
    await processor({ data: { jobId } } as never, '')
    expect(await status(jobId)).toMatchObject({ status: 'failed', error: 'tipo de exportação não registrado: t127_sem_kind' })
    const broken = createExportsProcessor({ db, files: new FsExportFileStore(), now: () => { throw new Error('outra') } })
    await expect(broken({ data: { jobId } } as never, '')).rejects.toThrow('outra')
    expect((await status(jobId)).error).toBe('tipo de exportação não registrado: t127_sem_kind')
  })
})
