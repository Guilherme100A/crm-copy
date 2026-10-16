import { readFileSync } from 'node:fs'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, runMigrations } from '../../client.js'
import { createTempDatabase, type TempDatabase } from '../../testing.js'
import { snapshotPublicSchema, type PublicSchemaSnapshot } from './introspect.js'
import { sessionCredentials, sessions } from './tables/index.js'

// Postgres real (SPEC 3.10). A fixture veio das migrations ORIGINAIS do ai-manager (fixtures/generate.ts).
const fixture = JSON.parse(readFileSync(new URL('./fixtures/ai-manager-public.json', import.meta.url), 'utf8')) as PublicSchemaSnapshot

async function query<T extends pg.QueryResultRow>(url: string, text: string, values: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: url })
  await c.connect()
  try {
    return (await c.query<T>(text, values)).rows
  } finally {
    await c.end()
  }
}

describe('migrations wa (Postgres real)', () => {
  let t: TempDatabase

  beforeAll(async () => {
    t = await createTempDatabase()
    await runMigrations(t.url, { set: 'wa' })
  }, 120_000)

  afterAll(async () => {
    await t?.drop()
  })

  it('o schema public fica idêntico ao do ai-manager (tabelas, colunas, enums, constraints e índices)', async () => {
    const snapshot = await snapshotPublicSchema(t.url)
    expect(snapshot.tables).toEqual(fixture.tables)
    expect(snapshot.enums).toEqual(fixture.enums)
    expect(snapshot.columns).toEqual(fixture.columns)
    expect(snapshot.constraints).toEqual(fixture.constraints)
    expect(snapshot.indexes).toEqual(fixture.indexes)
  })

  it('o controle fica em drizzle.__drizzle_migrations com as 8 migrations do ai-manager', async () => {
    const rows = await query<{ created_at: string }>(t.url, 'select created_at from drizzle.__drizzle_migrations order by id')
    const journal = JSON.parse(readFileSync(new URL('../../../drizzle/wa/meta/_journal.json', import.meta.url), 'utf8')) as {
      entries: { when: number }[]
    }
    expect(rows.map((r) => Number(r.created_at))).toEqual(journal.entries.map((e) => e.when))
    expect(rows).toHaveLength(8)
  })

  it("'all' depois de 'wa' é idempotente e cria o crm sem tocar em public", async () => {
    const before = await snapshotPublicSchema(t.url)
    await runMigrations(t.url, { set: 'all' })
    await runMigrations(t.url, { set: 'all' })
    expect(await snapshotPublicSchema(t.url)).toEqual(before)
    const [crm] = await query<{ n: string }>(t.url, `select count(*) n from information_schema.tables where table_schema = 'crm'`)
    expect(Number(crm?.n)).toBeGreaterThan(0)
  })

  it('session_credentials só guarda material cifrado (bytea) além da chave da linha', () => {
    const cols = fixture.columns.filter((c) => c.table === 'session_credentials')
    expect(cols.map((c) => `${c.column}:${c.type}`).sort()).toEqual(
      ['auth_tag:bytea', 'ciphertext:bytea', 'iv:bytea', 'key_id:text', 'key_type:text', 'key_version:integer', 'session_id:uuid', 'updated_at:timestamp with time zone'].sort(),
    )
  })

  it('createDb lê e grava as tabelas wa (o objeto `wa` na raiz não quebra o client)', async () => {
    const db = createDb(t.url, { max: 1 })
    try {
      const [s] = await db.insert(sessions).values({ name: 'x' }).returning()
      expect(s).toMatchObject({ name: 'x', status: 'NEW', phone: null })
      await db.insert(sessionCredentials).values({
        sessionId: s!.id,
        keyType: 'creds',
        keyId: 'creds',
        ciphertext: Buffer.from([1]),
        iv: Buffer.alloc(12),
        authTag: Buffer.alloc(16),
        keyVersion: 1,
      })
      const [row] = await db.select().from(sessionCredentials)
      expect(Buffer.isBuffer(row?.ciphertext)).toBe(true)
    } finally {
      await db.$client.end()
    }
  })
})
