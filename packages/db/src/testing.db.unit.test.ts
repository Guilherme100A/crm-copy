// T126: teardown seguro do banco temporário e prefixo de fila por arquivo de teste.
import pg from 'pg'
import { describe, expect, it } from 'vitest'
import { createTempDatabase, databaseConnections, isolateTestQueues, testQueuePrefix } from './testing'

const baseUrl = process.env.DATABASE_URL ?? 'postgres://wsm:wsm@127.0.0.1:5432/crm'

const exists = async (name: string) => {
  const c = new pg.Client({ connectionString: baseUrl })
  await c.connect()
  try {
    return (await c.query('select 1 from pg_database where datname = $1', [name])).rowCount === 1
  } finally {
    await c.end()
  }
}

describe('TempDatabase.drop()', () => {
  it('sem conexões: remove o banco; idempotente', async () => {
    const t = await createTempDatabase()
    expect(await exists(t.name)).toBe(true)
    await t.drop()
    expect(await exists(t.name)).toBe(false)
    await t.drop()
  })

  it('espera um pool que está terminando e então remove (sem 57P01 para quem fechava)', async () => {
    const t = await createTempDatabase({ dropWaitMs: 10_000 })
    const client = new pg.Client({ connectionString: t.url })
    const errors: unknown[] = []
    client.on('error', (e) => errors.push(e))
    await client.connect()
    await client.query('select 1')
    expect(await databaseConnections(baseUrl, t.name)).toBe(1)
    // o "pool" fecha só depois que o drop já começou a esperar
    const closing = new Promise<void>((r) => setTimeout(() => void client.end().then(r), 400))
    await t.drop()
    await closing
    expect(errors).toEqual([])
    expect(await exists(t.name)).toBe(false)
  })

  it('conexão que não fecha: NÃO derruba (sem FORCE), avisa e mantém o banco', async () => {
    const t = await createTempDatabase({ dropWaitMs: 500 })
    const client = new pg.Client({ connectionString: t.url })
    const errors: unknown[] = []
    client.on('error', (e) => errors.push(e))
    await client.connect()
    const warnings: string[] = []
    const onWarning = (w: Error) => void warnings.push(w.message)
    process.on('warning', onWarning)
    try {
      await t.drop()
      await new Promise((r) => setImmediate(r))
      expect(await exists(t.name)).toBe(true)
      expect((await client.query<{ ok: number }>('select 1 as ok')).rows[0]!.ok).toBe(1)
      expect(errors).toEqual([])
      expect(warnings.some((w) => w.includes(t.name))).toBe(true)
    } finally {
      process.off('warning', onWarning)
      await client.end()
      await t.drop()
    }
    expect(await exists(t.name)).toBe(false)
  })
})

describe('isolateTestQueues', () => {
  it('o setupFiles deste pacote já deu prefixo próprio a este arquivo', () => {
    const { crm, wa } = testQueuePrefix()
    expect(crm).toMatch(/^crm-t-.+-f[0-9a-f]{8}-[0-9a-f]{4}$/)
    expect(wa).toMatch(/^wsm-t-.+-f[0-9a-f]{8}-[0-9a-f]{4}$/)
  })

  it('arquivos diferentes → prefixos diferentes sobre o mesmo prefixo da execução; idempotente no mesmo arquivo', () => {
    const base = { CRM_QUEUE_PREFIX: 'crm-t-run1', WA_QUEUE_PREFIX: 'wsm-t-run1' }
    const a = { ...base }
    const b = { ...base }
    const pa = isolateTestQueues('/repo/a.unit.test.ts', a)
    const pb = isolateTestQueues('/repo/b.unit.test.ts', b)
    expect(pa.crm).toMatch(/^crm-t-run1-f[0-9a-f]{8}-[0-9a-f]{4}$/)
    expect(pa.crm).not.toBe(pb.crm)
    expect(pa.crm.slice(0, 19)).not.toBe(pb.crm.slice(0, 19))
    expect(a).toEqual({ CRM_QUEUE_PREFIX: pa.crm, WA_QUEUE_PREFIX: pa.wa })
    expect(isolateTestQueues('/repo/a.unit.test.ts', a)).toEqual(pa)
    expect(isolateTestQueues(undefined, {}).crm).toMatch(/^crm-t-\d+-f[0-9a-f]{8}-/)
  })
})
