// Apoio da suíte T13 (não é arquivo de teste). Contrato combinado com o Operário:
// - @crm/wa-engine: SessionManager, canTransition, ProxyService (e subpaths ./session, ./proxy).
// - @crm/wa-engine/transport: FakeTransport, BaileysTransport (socket fake injetado; nunca Baileys real).
// - @crm/db: createDb(url), runMigrations(db, { set: 'wa' }); banco descartável por suíte (SPEC 3.10).
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createTempDb, dropTempDb, lit, sqlOk, type TempDb } from '../helpers/pg'

// Chave de teste própria (32 bytes base64), antes de qualquer uso do cifrador.
process.env.CREDENTIALS_KEY = randomBytes(32).toString('base64')

export async function engine(): Promise<Record<string, any>> {
  const mod: any = await import('@crm/wa-engine')
  for (const n of ['SessionManager', 'canTransition', 'ProxyService'])
    if (mod[n] === undefined) throw new Error(`@crm/wa-engine não exporta ${n} (exports: ${Object.keys(mod).join(', ')})`)
  return mod
}

export async function transport(): Promise<Record<string, any>> {
  return (await import('@crm/wa-engine/transport')) as any
}

const poolOf = (db: any): any => db?.$client ?? db?.pool ?? db?.client

export interface WaDb {
  tmp: TempDb
  db: any
  url: string
  close(): Promise<void>
}

/** Banco descartável com as migrations `wa` aplicadas. */
export async function migratedWaDb(prefix = 'crm_acc_t13'): Promise<WaDb> {
  const mod: any = await import('@crm/db')
  const tmp = createTempDb(prefix)
  const db = mod.createDb(tmp.url)
  try {
    await mod.runMigrations(db, { set: 'wa' })
  } catch (e) {
    await poolOf(db)?.end?.().catch(() => {})
    dropTempDb(tmp)
    throw e
  }
  return {
    tmp,
    db,
    url: tmp.url,
    close: async () => {
      const pool = poolOf(db)
      pool?.on?.('error', () => {})
      await pool?.end?.().catch(() => {})
      dropTempDb(tmp)
    },
  }
}

export const status = (url: string, id: string) => sqlOk(url, `SELECT status FROM public.sessions WHERE id = ${lit(id)};`)[0]?.[0]
export const credCount = (url: string, id: string) =>
  Number(sqlOk(url, `SELECT count(*) FROM public.session_credentials WHERE session_id = ${lit(id)};`)[0]![0])
export const healthTypes = (url: string, id: string) =>
  sqlOk(url, `SELECT type FROM public.health_events WHERE session_id = ${lit(id)} ORDER BY id;`).map((r) => r[0]!)

export const flush = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0))
}

/** Manager com FakeTransport por sessão, sleep instantâneo registrado e eventos gravados. */
export async function fakeManager(db: any, extra: Record<string, unknown> = {}) {
  const { SessionManager } = await engine()
  const { FakeTransport } = await transport()
  const fakes = new Map<string, any[]>()
  const sleeps: number[] = []
  const manager = new SessionManager({
    db,
    transportFactory: (sessionId: string) => {
      const f = new FakeTransport()
      fakes.set(sessionId, [...(fakes.get(sessionId) ?? []), f])
      return f
    },
    sleep: async (ms: number) => {
      sleeps.push(ms)
    },
    ...extra,
  })
  const events: Array<{ event: string; payload: any }> = []
  for (const e of ['connected', 'disconnected', 'state', 'qr', 'pairing-code', 'reconnect']) manager.on(e, (p: any) => events.push({ event: e, payload: p }))
  const fake = (id: string) => {
    const list = fakes.get(id)
    if (!list?.length) throw new Error(`nenhum transporte criado para ${id}`)
    return list.at(-1)
  }
  const of = (event: string, id?: string) => events.filter((e) => e.event === event && (!id || e.payload?.sessionId === id)).map((e) => e.payload)
  const idle = async () => {
    await flush()
    await manager.whenIdle()
    await flush()
  }
  return { manager, fakes, fake, sleeps, events, of, idle }
}

/** Socket fake no formato BaileysSocketLike (para o AC-T13-04, com BaileysTransport real e sem rede). */
export function mockSocket() {
  const ev = new EventEmitter()
  const pairingCalls: string[] = []
  return {
    ev,
    pairingCalls,
    async requestPairingCode(phone: string) {
      pairingCalls.push(phone)
      return 'PAIR1234'
    },
    async sendMessage() {
      return { key: { id: 'WAMID-1' } }
    },
    async groupFetchAllParticipating() {
      return {}
    },
    async logout() {},
    end() {},
  }
}
