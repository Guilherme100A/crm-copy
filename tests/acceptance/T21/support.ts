// Apoio da suíte T21 (não é arquivo de teste). Superfície pública (combinada com o Operário):
// '@crm/wa-engine/events': attachEventOutbox(manager, queue, redis, opts) → { detach(), flush(), pending }
// '@crm/wa-engine/media': MediaService({ blobStore, download?, reupload?, getTransport? })
// '@crm/wa-engine/transport': FakeTransport   '@crm/wa-port': parseWaEvent   '@crm/node-kit': FsBlobStore, redisConnection
// O manager é um EventEmitter com o shape do SessionManager (connected/disconnected/state/qr/pairing-code),
// e a fila um EventEmitter com o shape da MessageQueue ('status' + get(id)).
import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1'
export const rand = (n = 4) => randomBytes(n).toString('hex')
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export const sha256hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

export const eventsMod = (): Promise<any> => import('@crm/wa-engine/events')
export const mediaMod = (): Promise<any> => import('@crm/wa-engine/media')
export const transportMod = (): Promise<any> => import('@crm/wa-engine/transport')
export const port = (): Promise<any> => import('@crm/wa-port')
export const portTesting = (): Promise<any> => import('@crm/wa-port/testing')
export const kit = (): Promise<any> => import('@crm/node-kit')

export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 10_000, what = 'condição'): Promise<void> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await cond()) return
    await sleep(20)
  }
  throw new Error(`timeout (${timeoutMs} ms) esperando ${what}`)
}

/** Manager mínimo com o shape do SessionManager (T13). */
export const fakeManager = () => new EventEmitter()

/** Fila mínima com o shape da MessageQueue (T14): evento 'status' e get(id). */
export function fakeQueue() {
  const rows = new Map<string, { id: string; sessionId: string; transportMessageId: string | null; status: string }>()
  const q = Object.assign(new EventEmitter(), {
    rows,
    async get(id: string) {
      const r = rows.get(id)
      if (!r) throw new Error(`message ${id} not found`)
      return r
    },
  })
  return q
}

export async function newRedis(): Promise<any> {
  const k = await kit()
  return k.redisConnection({ url: REDIS_URL })
}

/** Lê e valida (parseWaEvent) todos os eventos do stream, na ordem. */
export async function readEvents(redis: any, stream: string): Promise<any[]> {
  const { parseWaEvent } = await port()
  const rows: Array<[string, string[]]> = await redis.xrange(stream, '-', '+')
  return rows.map(([, flat]) => {
    const i = flat.indexOf('event')
    if (i < 0) throw new Error(`entrada sem campo 'event': ${JSON.stringify(flat)}`)
    return parseWaEvent(JSON.parse(flat[i + 1]!))
  })
}

export function tempBlobDir() {
  const dir = mkdtempSync(join(tmpdir(), 'crm-t21-blob-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

export const JID = (n: string) => `${n}@s.whatsapp.net`
