// AC-T122-01 e AC-T122-03 — Redis do harness por worktree (contrato combinado com o Bigorna):
// scripts/e2e/ports.mjs: e2eRedis(root, env) → { url, db, stream, queuePrefix, source } (mesmo hash de e2ePorts;
// E2E_PORTS_ROOT finge outro root); serve.mjs grava "redis": { url, db, stream, queue_prefix, source } no e2e-server.json
// (E2E_SERVER_INFO) e reserva o db (chave e2e:harness:owner); E2E_REDIS_URL = usa exatamente aquela URL (source 'env').
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { rootPath } from '../helpers/exec'
import { http, inboundEvent, startServe, type ServeProc } from '../T17/serve'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const ports = async (): Promise<Any> => import(pathToFileURL(rootPath('scripts', 'e2e', 'ports.mjs')).href)
const tmp = mkdtempSync(join(tmpdir(), 'crm-t122-'))
const procs: ServeProc[] = []

afterAll(async () => {
  for (const p of procs) await p.stop().catch(() => p.kill())
  rmSync(tmp, { recursive: true, force: true })
}, 120_000)

async function redisOf(url: string) {
  const kit: Any = await import('@crm/node-kit')
  const r = kit.redisConnection({ url })
  r.on?.('error', () => {})
  return r
}

/** Sessão da conexão do seed do harness (o message.inbound mínimo da T17 precisa dela). */
async function seedSession(p: ServeProc): Promise<string> {
  const info = await http(p.info.apiUrl, 'GET', '/__e2e')
  const sid = info.body?.seed?.session_id ?? info.body?.seed?.sessionId ?? info.body?.seed?.connections?.[0]?.session_id
  return sid ?? 'sessao-t122'
}

/** Emite n message.inbound e confirma, um a um, que o worker DESTE harness os recebeu (acked + handled). */
async function emitAndConfirm(p: ServeProc, n: number, tag: string) {
  const session = await seedSession(p)
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const emit = await http(p.info.apiUrl, 'POST', '/__e2e/wa/emit', { event: inboundEvent(session, `t122-${tag}-${i}-${Date.now()}`, `msg ${tag} ${i}`) })
    expect(emit.status, emit.text).toBe(202)
    ids.push(emit.body.stream_id)
  }
  const lost: string[] = []
  for (const id of ids) {
    const d = await http(p.info.apiUrl, 'GET', `/__e2e/wa/deliveries?stream_id=${encodeURIComponent(id)}&wait_ms=10000`)
    const handled = (d.body?.handled ?? []).some((h: Any) => h.stream_id === id)
    if (!(d.status === 200 && d.body.acked && handled)) lost.push(`${id}: ${d.text.slice(0, 200)}`)
  }
  return { ids, lost }
}

const readInfo = (file: string) => JSON.parse(readFileSync(file, 'utf8'))

describe('T122 — e2eRedis', () => {
  it('AC-T122-01 e2eRedis deriva db (2..15), stream e prefixo estáveis do worktree; worktrees diferentes têm streams diferentes', async () => {
    const { e2eRedis } = await ports()
    expect(typeof e2eRedis).toBe('function')
    const a = e2eRedis('C:/Users/x/leonas-crm-wt/T122', {})
    const b = e2eRedis('C:/Users/x/leonas-crm-wt/T123', {})
    expect(a).toEqual(e2eRedis('C:\\Users\\X\\leonas-crm-wt\\T122\\', {}))
    for (const r of [a, b]) {
      expect(r.source).toBe('derived')
      expect(r.db).toBeGreaterThanOrEqual(2)
      expect(r.db).toBeLessThanOrEqual(15)
      expect(r.url).toBe(`redis://127.0.0.1:6379/${r.db}`)
      expect(r.stream).toMatch(/^wsm:events:e2e-[0-9a-f]{8}$/)
      expect(r.queuePrefix).toMatch(/^crm-e2e-[0-9a-f]{8}$/)
    }
    expect(a.stream).not.toBe(b.stream)
    expect(a.queuePrefix).not.toBe(b.queuePrefix)
    const env = e2eRedis('C:/qualquer', { E2E_REDIS_URL: 'redis://127.0.0.1:6379/9' })
    expect(env).toMatchObject({ url: 'redis://127.0.0.1:6379/9', db: 9, source: 'env' })
  })
})

describe('T122 — dois harnesses ao mesmo tempo', () => {
  it('AC-T122-01 dois harnesses de worktrees diferentes: 20 message.inbound em cada um, todos entregues ao worker do próprio harness (0 perdas)', async () => {
    const roots = [`C:/t122-sim/wt-a-${process.pid}`, `C:/t122-sim/wt-b-${process.pid}`]
    const infos = roots.map((_, i) => join(tmp, `ac01-${i}.json`))
    const [pa, pb] = await Promise.all(roots.map((r, i) => startServe({ E2E_PORTS_ROOT: r, E2E_SERVER_INFO: infos[i]!, E2E_SKIP_WEB: '1' }, 240_000)))
    procs.push(pa!, pb!)
    const [ia, ib] = infos.map(readInfo)
    expect(ia.redis, JSON.stringify(ia)).toBeTruthy()
    expect(ib.redis, JSON.stringify(ib)).toBeTruthy()
    // isolamento: db e stream distintos
    expect(ia.redis.db).not.toBe(ib.redis.db)
    expect(ia.redis.stream).not.toBe(ib.redis.stream)
    for (const i of [ia, ib]) {
      expect(i.redis.source).toBe('derived')
      expect(i.redis.url).toMatch(new RegExp(`/${i.redis.db}$`))
    }
    // o GET /__e2e de cada um mostra o stream efetivo dele
    expect((await http(pa!.info.apiUrl, 'GET', '/__e2e')).body.stream).toBe(ia.redis.stream)
    expect((await http(pb!.info.apiUrl, 'GET', '/__e2e')).body.stream).toBe(ib.redis.stream)

    // emissões simultâneas nos dois
    const [ra, rb] = await Promise.all([emitAndConfirm(pa!, 20, 'a'), emitAndConfirm(pb!, 20, 'b')])
    expect(ra.lost, ra.lost.join('\n')).toEqual([])
    expect(rb.lost, rb.lost.join('\n')).toEqual([])
    expect(ra.ids).toHaveLength(20)
    expect(rb.ids).toHaveLength(20)
    // nenhum evento de A chega ao stream de B
    const redisB = await redisOf(ib.redis.url)
    try {
      const entries: Any[] = await redisB.xrange(ib.redis.stream, '-', '+')
      const bodies = entries.map((e: Any) => JSON.stringify(e[1]))
      expect(bodies.filter((b: string) => b.includes('t122-a-'))).toEqual([])
      expect(bodies.filter((b: string) => b.includes('t122-b-')).length).toBe(20)
    } finally {
      await Promise.resolve(redisB.quit?.()).catch(() => redisB.disconnect?.())
    }
    for (const p of [pa!, pb!]) expect((await p.stop())?.code).toBe(0)
  }, 600_000)
})

describe('T122 — E2E_REDIS_URL', () => {
  it('AC-T122-03 com E2E_REDIS_URL o harness usa exatamente aquele Redis (db/stream) e o e2e-server.json registra o Redis efetivo', async () => {
    const db = 2 + Math.floor(Math.random() * 14)
    const url = `redis://127.0.0.1:6379/${db}`
    const infoFile = join(tmp, 'ac03.json')
    const p = await startServe({ E2E_PORTS_ROOT: `C:/t122-sim/env-${process.pid}`, E2E_SERVER_INFO: infoFile, E2E_SKIP_WEB: '1', E2E_REDIS_URL: url }, 240_000)
    procs.push(p)
    const info = readInfo(infoFile)
    expect(info.redis).toMatchObject({ url, db, source: 'env' })
    expect(info.redis.stream).toMatch(/^wsm:events:e2e-[0-9a-f]{8}$/)
    expect(p.output()).toContain(`E2E_REDIS_URL=${url}`)
    expect(p.output()).toContain(`E2E_WA_EVENTS_STREAM=${info.redis.stream}`)

    const r = await redisOf(url)
    try {
      const before = Number(await r.xlen(info.redis.stream).catch(() => 0))
      const { ids, lost } = await emitAndConfirm(p, 3, 'env')
      expect(lost, lost.join('\n')).toEqual([])
      expect(Number(await r.xlen(info.redis.stream))).toBe(before + 3)
      const entries: Any[] = await r.xrange(info.redis.stream, ids[0], ids[2])
      expect(entries.map((e: Any) => e[0])).toEqual(ids)
    } finally {
      await Promise.resolve(r.quit?.()).catch(() => r.disconnect?.())
    }
    // nada foi para o db derivado do mesmo root
    const { e2eRedis } = await ports()
    const derived = e2eRedis(`C:/t122-sim/env-${process.pid}`, {})
    if (derived.db !== db) {
      const d = await redisOf(derived.url)
      try {
        expect(Number(await d.xlen(info.redis.stream).catch(() => 0))).toBe(0)
      } finally {
        await Promise.resolve(d.quit?.()).catch(() => d.disconnect?.())
      }
    }
    expect((await p.stop())?.code).toBe(0)
    expect(existsSync(infoFile), 'e2e-server.json não foi apagado ao sair').toBe(false)
  }, 420_000)
})
