// Utilitários da suíte T05 (@crm/node-kit). Contrato público: exports de `@crm/node-kit` (SPEC T05, Entregáveis).
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { vi } from 'vitest'
import { rootPath } from '../helpers/exec'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Kit = Record<string, any>

/**
 * Importa `@crm/node-kit` com cache de módulos limpo: variáveis de ambiente lidas na carga
 * (CREDENTIALS_KEY, STORAGE_DIR, REDIS_URL) passam a valer para esta instância.
 */
export async function freshKit(): Promise<Kit> {
  vi.resetModules()
  return (await import('@crm/node-kit')) as Kit
}

export const validKey = () => randomBytes(32).toString('base64')

/** Executa `fn` (sync ou async) e devolve o erro lançado/rejeitado, ou `null`. */
export async function caught(fn: () => unknown): Promise<unknown> {
  try {
    await fn()
    return null
  } catch (err) {
    return err ?? new Error('throw sem valor')
  }
}

/** zod resolvido a partir do próprio pacote node-kit (mesma instância que `loadConfig` usa). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function zodFromNodeKit(): Promise<any> {
  const req = createRequire(rootPath('packages', 'node-kit', 'package.json'))
  const mod = await import(pathToFileURL(req.resolve('zod')).href)
  return mod.z ?? mod.default ?? mod
}

export function tempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `crm-t05-${prefix}-`))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

export const toBuffer = (v: unknown): Buffer => {
  if (Buffer.isBuffer(v)) return v
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength)
  if (v instanceof ArrayBuffer) return Buffer.from(v)
  throw new TypeError(`esperado Buffer/Uint8Array, veio ${typeof v}`)
}

/** Lê a coleção de mensagens do MemoryMailer (aceita `messages`, `sent`, `outbox` ou métodos equivalentes). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mailerMessages(m: any): any[] {
  for (const k of ['messages', 'sent', 'outbox', 'inbox', 'mails']) {
    const v = typeof m[k] === 'function' ? m[k]() : m[k]
    if (Array.isArray(v)) return v
  }
  for (const k of ['list', 'all', 'getMessages', 'getSent']) {
    if (typeof m[k] === 'function') {
      const v = m[k]()
      if (Array.isArray(v)) return v
    }
  }
  throw new Error('MemoryMailer não expõe as mensagens enviadas (esperado `messages` array)')
}

/** Envia pela porta Mailer (`send`, aceita `sendMail` como alternativa). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function mailerSend(m: any, msg: Record<string, unknown>): Promise<unknown> {
  if (typeof m.send === 'function') return m.send(msg)
  if (typeof m.sendMail === 'function') return m.sendMail(msg)
  throw new Error('Mailer sem método `send`')
}
