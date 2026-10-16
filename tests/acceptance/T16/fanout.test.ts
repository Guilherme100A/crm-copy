// AC-T16-05: com duas instâncias da API (processos reais), um evento publicado por qualquer processo
// chega aos clientes das duas.
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ROOT } from '../helpers/exec'
import { credentialsKey } from '../helpers/factories'
import { waitForHttp } from '../helpers/http'
import { appFetcher, openStream, seedMember, startEnv, updated, type Env } from './setup'
import { envelopeOf, type Fetcher, type SseConnection } from './sse'

let env: Env
const procs: Array<{ child: ChildProcess; url: string; log: string[] }> = []
const conns: SseConnection[] = []

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number }
      srv.close(() => resolve(port))
    })
  })
}

async function startApi(databaseUrl: string) {
  const port = await freePort()
  const log: string[] = []
  const child = spawn(process.execPath, ['--conditions=development', '--import', 'tsx', 'apps/api/src/server.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'warn',
      HOST: '127.0.0.1',
      PORT: String(port),
      DATABASE_URL: databaseUrl,
      REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1',
      CREDENTIALS_KEY: credentialsKey(),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', (d) => log.push(String(d)))
  child.stderr?.on('data', (d) => log.push(String(d)))
  const url = `http://127.0.0.1:${port}`
  const p = { child, url, log }
  procs.push(p)
  try {
    await waitForHttp(`${url}/health`, 60_000)
  } catch (e) {
    throw new Error(`API não subiu em ${url}: ${String(e)}\n${log.join('').slice(-2000)}`)
  }
  return p
}

const remote =
  (base: string): Fetcher =>
  (path, init) =>
    fetch(`${base}${path}`, init)

beforeAll(async () => {
  env = await startEnv()
  await startApi(env.tmp.url)
  await startApi(env.tmp.url)
}, 180_000)

afterAll(async () => {
  for (const c of conns) await c.close()
  for (const p of procs) {
    p.child.kill('SIGTERM')
    await new Promise((r) => {
      if (p.child.exitCode !== null) return r(null)
      const t = setTimeout(() => (p.child.kill('SIGKILL'), r(null)), 5_000)
      p.child.once('exit', () => (clearTimeout(t), r(null)))
    })
  }
  await env?.close()
})

const byName = (name: string) => (m: { event: string; data: string }) => m.event === 'company.updated' && envelopeOf(m as any).data?.name === name

describe('fan-out entre instâncias', () => {
  it('AC-T16-05 evento publicado por um terceiro processo chega aos clientes das duas instâncias', async () => {
    const m = await seedMember(env, 'owner')
    const other = await seedMember(env, 'member', m.companyId)
    const [a, b] = procs
    const s1 = await openStream(remote(a!.url), m)
    const s2 = await openStream(remote(b!.url), other)
    const s3 = await openStream(remote(b!.url), m)
    conns.push(s1, s2, s3)

    const id = await env.publisher.publish(m.companyId, 'company.updated', updated('fanout-1'))
    for (const s of [s1, s2, s3]) {
      const got = await s.waitFor(byName('fanout-1'), 10_000)
      expect(got.id).toBe(id)
    }
  })

  it('AC-T16-05 eventos de várias origens chegam a todas as instâncias, inclusive a uma API em processo', async () => {
    const m = await seedMember(env, 'owner')
    const [a, b] = procs
    const local = env.makeApp()
    const s1 = await openStream(remote(a!.url), m)
    const s2 = await openStream(remote(b!.url), m)
    const s3 = await openStream(appFetcher(local), m)
    conns.push(s1, s2, s3)

    // dois publishers independentes (conexões Redis distintas)
    const p2 = new env.core.RealtimePublisher({ redis: env.redis() })
    await env.publisher.publish(m.companyId, 'company.updated', updated('origem-1'))
    await p2.publish(m.companyId, 'company.updated', updated('origem-2'))
    for (const s of [s1, s2, s3]) {
      await s.waitFor(byName('origem-1'), 10_000)
      await s.waitFor(byName('origem-2'), 10_000)
      expect(s.events('company.updated').map((x) => envelopeOf(x).data.name)).toEqual(['origem-1', 'origem-2'])
    }
  })

  it('AC-T16-05 o isolamento por empresa vale também entre instâncias', async () => {
    const m = await seedMember(env, 'owner')
    const x = await seedMember(env, 'owner')
    const [a, b] = procs
    const sm = await openStream(remote(a!.url), m)
    const sx = await openStream(remote(b!.url), x)
    conns.push(sm, sx)
    await env.publisher.publish(x.companyId, 'company.updated', updated('so-x'))
    await env.publisher.publish(m.companyId, 'company.updated', updated('so-m'))
    await sx.waitFor(byName('so-x'))
    await sm.waitFor(byName('so-m'))
    expect(sm.events().some(byName('so-x'))).toBe(false)
    expect(sx.events().some(byName('so-m'))).toBe(false)
  })
})
