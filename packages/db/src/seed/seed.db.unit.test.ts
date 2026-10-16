import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { verifyPassword } from '@crm/node-kit'
import { createDb, type Database } from '../client.js'
import { companies, companyMembers, users } from '../schema/index.js'
import { createTempDatabase, type TempDatabase } from '../testing.js'
import { listSeedModules, registerSeedModule, resetAndSeed, resetDatabase, runSeeds, SEED_BASE, type SeedModule } from './index.js'

let temp: TempDatabase
let db: Database

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 2 })
}, 60_000)

afterAll(async () => {
  await db?.$client.end()
  await temp?.drop()
})

describe('seed-base', () => {
  it('admin da plataforma, Empresa Demo e owner/admin/member com a senha conhecida', async () => {
    await resetAndSeed(db, { modules: [] })
    const [co] = await db.select().from(companies)
    expect(co).toMatchObject({ id: SEED_BASE.company.id, name: 'Empresa Demo', slug: 'empresa-demo' })
    const rows = await db
      .select({ email: users.email, systemRole: users.systemRole, hash: users.passwordHash, role: companyMembers.role, lastCompanyId: users.lastCompanyId })
      .from(users)
      .innerJoin(companyMembers, eq(companyMembers.userId, users.id))
    const by = Object.fromEntries(rows.map((r) => [r.email, r]))
    expect(by['platform@demo.test']).toMatchObject({ systemRole: 'platform_admin' })
    expect(by['owner@demo.test']).toMatchObject({ role: 'owner', systemRole: 'user', lastCompanyId: SEED_BASE.company.id })
    expect(by['admin@demo.test']).toMatchObject({ role: 'admin' })
    expect(by['member@demo.test']).toMatchObject({ role: 'member' })
    for (const r of rows) expect(await verifyPassword(r.hash, SEED_BASE.password)).toBe(true)
  })

  it('resetDatabase esvazia as tabelas e mantém as migrations', async () => {
    await resetAndSeed(db, { modules: [] })
    const tables = await resetDatabase(db)
    expect(tables.some((t) => t.includes('users'))).toBe(true)
    expect(tables.some((t) => t.includes('__drizzle_migrations'))).toBe(false)
    expect(await db.select().from(users)).toEqual([])
    // seed de novo depois do reset: mesmos ids
    await runSeeds(db, { modules: [] })
    const [owner] = await db.select({ id: users.id }).from(users).where(eq(users.email, SEED_BASE.users.owner.email))
    expect(owner!.id).toBe(SEED_BASE.users.owner.id)
  })

  // T126: o reset passou de TRUNCATE para DELETE (sem recriar arquivos/índices). O estado final tem de ser o mesmo.
  it('resetDatabase deixa o mesmo estado do TRUNCATE … RESTART IDENTITY CASCADE, sem recriar os arquivos das tabelas', async () => {
    const C = SEED_BASE.company.id
    // seeds + FK RESTRICT (chats → connections), SET NULL (flow_runs → flow_versions, que recusa UPDATE) e bigserial
    // em crm e public
    const populate = async () => {
      await resetAndSeed(db)
      await db.execute(sql`
        with conn as (insert into crm.connections (company_id, session_id, name) values (${C}, 's-t126', 'Número T126') returning id),
        ct as (insert into crm.contacts (company_id, name, phone_e164) values (${C}, 'Contato', '+5511900000126') returning id),
        ch as (insert into crm.chats (company_id, contact_id, connection_id) select ${C}, ct.id, conn.id from ct, conn returning id),
        fl as (insert into crm.flows (company_id, name) values (${C}, 'Fluxo T126') returning id),
        fv as (insert into crm.flow_versions (company_id, flow_id, version, definition) select ${C}, fl.id, 1, '{}'::jsonb from fl returning id, flow_id),
        fr as (insert into crm.flow_runs (company_id, flow_id, contact_id, version_id) select ${C}, fv.flow_id, ct.id, fv.id from fv, ct returning id),
        wh as (insert into crm.inbound_webhooks (company_id, name, public_token) values (${C}, 'Webhook T126', repeat('t', 43)) returning id),
        wr as (insert into crm.inbound_webhook_requests (company_id, webhook_id) select ${C}, wh.id from wh, generate_series(1, 3) returning id)
        insert into public.audit_logs (actor, action) select 't126', 'x' from generate_series(1, 5)`)
    }
    const state = async (tables: string[]) => {
      const counts = (await db.execute<{ t: string; n: number }>(sql.raw(tables.map((t) => `select '${t}' as t, count(*)::int as n from ${t}`).join(' union all ')))).rows
      const seqs = (
        await db.execute<{ s: string; v: string | null }>(sql`select schemaname || '.' || sequencename as s, last_value::text as v from pg_sequences where schemaname in ('crm', 'public') order by 1`)
      ).rows
      return { counts: Object.fromEntries(counts.map((r) => [r.t, r.n])), seqs }
    }
    const files = async () => (await db.execute<{ r: string; f: string }>(sql`select oid::regclass::text as r, relfilenode::text as f from pg_class where relnamespace in ('crm'::regnamespace, 'public'::regnamespace) and relkind in ('r', 'i') order by 1`)).rows
    const nextSeq = async () => Number((await db.execute<{ n: string }>(sql`select nextval(pg_get_serial_sequence('crm.inbound_webhook_requests', 'seq'))::text as n`)).rows[0]!.n)

    // referência: o TRUNCATE de antes da T126
    await populate()
    const tables = (await db.execute<{ t: string }>(sql`select quote_ident(table_schema) || '.' || quote_ident(table_name) as t from information_schema.tables where table_type = 'BASE TABLE' and table_schema in ('crm', 'public')`)).rows
      .map((r) => r.t)
      .filter((t) => !t.includes('__drizzle_migrations'))
    await db.execute(sql.raw(`truncate table ${tables.join(', ')} restart identity cascade`))
    const expected = await state(tables)
    expect(await nextSeq()).toBe(1)

    await populate()
    const dirty = await state(tables)
    expect(dirty.counts['crm.chats']).toBe(1)
    expect(dirty.counts['public.audit_logs']).toBe(5)
    const OWNED = ['crm.inbound_webhook_requests_seq_seq', 'public.audit_logs_id_seq']
    for (const s of OWNED) expect(dirty.seqs.find((x) => x.s === s)?.v).toEqual(expect.any(String))
    const before = await files()
    expect(await resetDatabase(db)).toEqual(expect.arrayContaining(tables))
    const after = await state(tables)
    expect(after).toEqual(expected)
    expect(Object.entries(after.counts).filter(([, n]) => n !== 0)).toEqual([])
    // sequências das tabelas (bigserial) voltam ao início; as avulsas ficam como o TRUNCATE deixa (comparado acima)
    for (const s of OWNED) expect(after.seqs.find((x) => x.s === s)).toEqual({ s, v: null })
    expect(await nextSeq()).toBe(1)
    // DELETE, não TRUNCATE (que troca o relfilenode de cada tabela e índice): nenhum arquivo recriado
    expect(await files()).toEqual(before)
    // e o seed volta a funcionar por cima
    await runSeeds(db, { modules: [] })
    expect((await db.select({ id: users.id }).from(users).where(eq(users.email, SEED_BASE.users.owner.email)))[0]!.id).toBe(SEED_BASE.users.owner.id)
  }, 60_000)
})

describe('AC-T17-05 seeds de módulo', () => {
  it('ordem determinística (order, depois nome), igual em toda execução', async () => {
    const ran: string[] = []
    const mod = (name: string, order?: number): SeedModule => ({ name, order, run: () => void ran.push(name) })
    const offs = [mod('zeta'), mod('alpha', 200), mod('beta', 10), mod('gamma'), mod('aaa', 10)].map((m) => registerSeedModule(m))
    try {
      // T37: seeds reais registrados (ex.: ai-prices) ficam fora da comparação; a ordem dos do teste é a prova.
      const mine = (names: string[]) => names.filter((n) => n === 'base' || ['aaa', 'beta', 'gamma', 'zeta', 'alpha'].includes(n))
      expect(mine(listSeedModules().map((m) => m.name))).toEqual(['aaa', 'beta', 'gamma', 'zeta', 'alpha'])
      for (let i = 0; i < 2; i++) {
        ran.length = 0
        const { applied } = await resetAndSeed(db)
        expect(mine(applied)).toEqual(['base', 'aaa', 'beta', 'gamma', 'zeta', 'alpha'])
        expect(ran).toEqual(['aaa', 'beta', 'gamma', 'zeta', 'alpha'])
      }
    } finally {
      for (const off of offs) off()
    }
    expect(listSeedModules().filter((m) => ['aaa', 'beta', 'gamma', 'zeta', 'alpha'].includes(m.name))).toEqual([])
  })

  it('nome repetido ou reservado → erro; módulo recebe db e passwordHash', async () => {
    const off = registerSeedModule({ name: 'dup', run: () => undefined })
    try {
      expect(() => registerSeedModule({ name: 'dup', run: () => undefined })).toThrow(/já registrado/)
      expect(() => registerSeedModule({ name: 'base', run: () => undefined })).toThrow()
    } finally {
      off()
    }
    let hash = ''
    await resetDatabase(db)
    await runSeeds(db, { modules: [{ name: 'x', run: async (ctx) => void (hash = await ctx.passwordHash('abc12345')) }] })
    expect(await verifyPassword(hash, 'abc12345')).toBe(true)
  })
})
