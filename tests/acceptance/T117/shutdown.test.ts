// AC-T117-03 — o processo real da API (apps/api/src/server.ts) com um cliente SSE conectado encerra com exit 0 em < 5 s após SIGTERM.
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { afterAll, describe, expect, it } from 'vitest'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { ROOT, rootPath } from '../helpers/exec'
import { waitForHttp } from '../helpers/http'
import type { Fetcher, SseConnection } from '../helpers/sse'
import { login, openStream, register } from './setup'

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })

interface Proc {
  child: ChildProcess
  output: () => string
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>
}

function startServer(env: NodeJS.ProcessEnv): Proc {
  const harness = rootPath('tests', 'acceptance', 'T117', 'fixtures', 'server-harness.ts')
  const server = rootPath('apps', 'api', 'src', 'server.ts')
  const child = spawn(process.execPath, ['--conditions=development', '--import', 'tsx', harness, server], {
    cwd: ROOT,
    env: { ...process.env, ...env, FORCE_COLOR: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout!.on('data', (d) => (out += String(d)))
  child.stderr!.on('data', (d) => (out += String(d)))
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal, at: Date.now() })),
  )
  return { child, output: () => out.split('\n').slice(-40).join('\n'), exited }
}

describe('T117 — shutdown do processo da API', () => {
  let tmp: TempDatabase | undefined
  let proc: Proc | undefined
  let sse: SseConnection | undefined

  afterAll(async () => {
    await sse?.close().catch(() => {})
    if (proc && proc.child.exitCode === null && proc.child.signalCode === null) {
      proc.child.kill('SIGKILL')
      await proc.exited
    }
    await tmp?.drop()
  })

  it('AC-T117-03 server.ts com cliente SSE conectado encerra com exit 0 em < 5 s após SIGTERM', async () => {
    tmp = await createTempDatabase({ migrate: false })
    const port = await freePort()
    const base = `http://127.0.0.1:${port}`
    proc = startServer({
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      HOST: '127.0.0.1',
      PORT: String(port),
      DATABASE_URL: tmp.url,
      REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1',
      CREDENTIALS_KEY: randomBytes(32).toString('base64'),
      MAIL_TRANSPORT: 'memory',
      WEB_PUBLIC_URL: 'http://web.t117.test',
      API_PUBLIC_URL: base,
    })
    const early = await Promise.race([waitForHttp(`${base}/health`, 90_000).then(() => null), proc.exited])
    expect(early, `servidor saiu antes de responder:\n${proc.output()}`).toBeNull()
    const health = await fetch(`${base}/health`)
    expect(health.status, proc.output()).toBe(200)

    // cliente SSE real (sessão criada pelo login HTTP)
    const fetcher: Fetcher = (path, init) => fetch(`${base}${path}`, init)
    const acc = await register(fetcher)
    const cookie = await login(fetcher, acc)
    sse = await openStream(fetcher, cookie, acc.companyId)
    expect(sse.isEnded()).toBe(false)

    const t0 = Date.now()
    proc.child.stdin!.write('SIGTERM\n')
    const res = await Promise.race([proc.exited, new Promise<null>((r) => setTimeout(() => r(null), 12_000))])
    expect(res, `processo não encerrou em 12 s após SIGTERM:\n${proc.output()}`).not.toBeNull()
    const took = res!.at - t0
    expect(res!.code, `exit code ${res!.code} (signal ${res!.signal}) em ${took} ms:\n${proc.output()}`).toBe(0)
    expect(took, `encerrou em ${took} ms:\n${proc.output()}`).toBeLessThan(5_000)
    // o stream do cliente foi encerrado pelo servidor
    await Promise.race([sse.ended, new Promise((r) => setTimeout(r, 2_000))])
    expect(sse.isEnded()).toBe(true)
  }, 180_000)
})
