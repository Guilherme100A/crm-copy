// AC-T05-06 — bullConnection(): opções para BullMQ com maxRetriesPerRequest: null e db da REDIS_URL.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rootPath } from '../helpers/exec'
import { freshKit } from './kit'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
const opened: Any[] = []

/** Normaliza: objeto de opções puro ou instância de cliente (ioredis expõe `.options`). */
function optionsOf(conn: Any): Any {
  if (conn && typeof conn === 'object' && conn.options && typeof conn.options === 'object') {
    opened.push(conn)
    return conn.options
  }
  return conn
}

async function bullOpts(url: string): Promise<Any> {
  vi.stubEnv('REDIS_URL', url)
  const kit = await freshKit()
  return optionsOf(await kit.bullConnection())
}

describe('T05 — bullConnection', () => {
  afterEach(async () => {
    vi.unstubAllEnvs()
    for (const c of opened.splice(0)) await Promise.resolve(c.disconnect?.()).catch(() => {})
  })

  it('AC-T05-06 bullConnection() devolve opções com maxRetriesPerRequest: null', async () => {
    const opts = await bullOpts('redis://127.0.0.1:6379/1')
    expect(opts).toBeTruthy()
    expect(opts).toHaveProperty('maxRetriesPerRequest')
    expect(opts.maxRetriesPerRequest).toBeNull()
  })

  it('AC-T05-06 respeita o número do banco da REDIS_URL (/1)', async () => {
    const opts = await bullOpts('redis://127.0.0.1:6379/1')
    expect(Number(opts.db)).toBe(1)
    expect(opts.host ?? '127.0.0.1').toBe('127.0.0.1')
    expect(Number(opts.port ?? 6379)).toBe(6379)
  })

  it('AC-T05-06 outro número de banco na REDIS_URL (/5) também é respeitado', async () => {
    const opts = await bullOpts('redis://127.0.0.1:6379/5')
    expect(Number(opts.db)).toBe(5)
    expect(opts.maxRetriesPerRequest).toBeNull()
  })

  it('AC-T05-06 opções de bullConnection() conectam no Redis local e operam no db 1', async () => {
    const opts = await bullOpts('redis://127.0.0.1:6379/1')
    // Cliente ioredis do próprio node-kit (mesma dependência que o BullMQ usa).
    const req = createRequire(rootPath('packages', 'node-kit', 'package.json'))
    const mod: Any = await import(pathToFileURL(req.resolve('ioredis')).href)
    const Redis = mod.Redis ?? mod.default
    const client = new Redis({ ...opts, lazyConnect: true })
    opened.push(client)
    await client.connect()
    expect(await client.ping()).toBe('PONG')
    const info: string = await client.call('CLIENT', 'INFO')
    expect(info).toMatch(/\bdb=1\b/)
    await client.quit()
  })
})
