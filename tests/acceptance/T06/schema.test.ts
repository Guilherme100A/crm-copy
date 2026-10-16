// AC-T06-01: após migrar `wa` num banco vazio, tabelas, colunas (nome, tipo, nulidade) e enums de `public`
// são idênticos à fixture extraída do ai-manager (fixtures/ai-manager-public.json, gerada por
// fixtures/extract-ai-manager-schema.ts a partir das migrations 0000..0007 do ai-manager).
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type TempDb, createTempDb, dropTempDb } from '../helpers/pg'
import { publicSchema, type PublicSchema } from './schema-snapshot'
import { closeDb, loadDb } from './support'

const FIXTURE: PublicSchema & { source: string } = JSON.parse(
  readFileSync(new URL('./fixtures/ai-manager-public.json', import.meta.url), 'utf8'),
)

/** Tabelas do schema `wa` exigidas pela SPEC T06. */
const WA_TABLES = [
  'contacts',
  'health_events',
  'message_events',
  'messages',
  'proxies',
  'proxy_settings',
  'session_credentials',
  'session_limits',
  'sessions',
]

let tmp: TempDb
let got: PublicSchema

beforeAll(async () => {
  const mod = await loadDb()
  tmp = createTempDb('crm_acc_t06')
  const db = mod.createDb(tmp.url)
  try {
    await mod.runMigrations(db, { set: 'wa' })
  } finally {
    await closeDb(db)
  }
  got = publicSchema(tmp.url)
})

afterAll(() => dropTempDb(tmp))

describe('T06 — schema public.* igual ao ai-manager', () => {
  it('AC-T06-01 as 9 tabelas do WhatsApp existem em public', () => {
    expect(WA_TABLES.filter((t) => !got.tables.includes(t))).toEqual([])
  })

  it('AC-T06-01 nenhuma tabela em public que não exista no ai-manager', () => {
    expect(got.tables.filter((t) => !FIXTURE.tables.includes(t))).toEqual([])
  })

  it('AC-T06-01 colunas (nome, tipo, nulidade) idênticas às do ai-manager em todas as tabelas de public', () => {
    for (const t of got.tables) {
      expect(got.columns[t], `colunas de public.${t}`).toEqual(FIXTURE.columns[t])
    }
  })

  for (const t of WA_TABLES) {
    it(`AC-T06-01 public.${t} tem exatamente as colunas do ai-manager`, () => {
      expect(got.columns[t], `public.${t} não existe`).toBeDefined()
      expect(got.columns[t]).toEqual(FIXTURE.columns[t])
    })
  }

  it('AC-T06-01 enums usados pelas tabelas do WhatsApp existem com os mesmos rótulos e ordem', () => {
    const used = new Set(
      WA_TABLES.flatMap((t) => (FIXTURE.columns[t] ?? []).filter((c) => c.data_type === 'USER-DEFINED').map((c) => c.udt_name)),
    )
    expect(used.size).toBeGreaterThan(0)
    for (const e of used) expect(got.enums[e], `enum ${e}`).toEqual(FIXTURE.enums[e])
  })

  it('AC-T06-01 todo enum de public é idêntico ao do ai-manager (nenhum enum inventado)', () => {
    for (const [name, labels] of Object.entries(got.enums)) {
      expect(FIXTURE.enums[name], `enum ${name} não existe no ai-manager`).toBeDefined()
      expect(labels, `enum ${name}`).toEqual(FIXTURE.enums[name])
    }
  })
})
