// Processo `node scripts/e2e/serve.mjs` controlado pelo teste (contrato combinado com o Torno):
// stdout com E2E_API_URL=…, E2E_WEB_URL=…, E2E_WEB=up|absent, E2E_DATABASE=…, E2E_READY; 'q' + Enter encerra limpo.
import { spawn, type ChildProcess } from 'node:child_process'
import { ROOT } from '../helpers/exec'

export interface ServeInfo {
  apiUrl: string
  webUrl: string
  web: string
  database: string
}

export interface ServeProc {
  child: ChildProcess
  info: ServeInfo
  readyMs: number
  output: () => string
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  stop: (timeoutMs?: number) => Promise<{ code: number | null; signal: NodeJS.Signals | null } | null>
  kill: () => Promise<void>
}

export async function startServe(env: NodeJS.ProcessEnv = {}, readyTimeoutMs = 60_000): Promise<ServeProc> {
  const t0 = Date.now()
  const child = spawn(process.execPath, ['scripts/e2e/serve.mjs'], {
    cwd: ROOT,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let out = ''
  const vars = new Map<string, string>()
  let ready = false
  let onReady: () => void = () => {}
  const readyP = new Promise<void>((r) => (onReady = r))
  let pending = ''
  child.stdout!.on('data', (d) => {
    const s = String(d)
    out += s
    pending += s
    let i: number
    while ((i = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, i).replace(/\r$/, '').trim()
      pending = pending.slice(i + 1)
      const m = /^(E2E_[A-Z_]+)=(.*)$/.exec(line)
      if (m) vars.set(m[1]!, m[2]!)
      if (line === 'E2E_READY') {
        ready = true
        onReady()
      }
    }
  })
  child.stderr!.on('data', (d) => (out += String(d)))
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  )
  const output = () => out.split('\n').slice(-60).join('\n')

  const result = await Promise.race([
    readyP.then(() => 'ready' as const),
    exited.then(() => 'exited' as const),
    new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), readyTimeoutMs)),
  ])
  const kill = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await exited
    }
  }
  if (result !== 'ready' || !ready) {
    await kill()
    throw new Error(`serve.mjs não ficou pronto (${result}) em ${Date.now() - t0} ms:\n${output()}`)
  }
  const info: ServeInfo = {
    apiUrl: (vars.get('E2E_API_URL') ?? '').replace(/\/$/, ''),
    webUrl: vars.get('E2E_WEB_URL') ?? '',
    web: vars.get('E2E_WEB') ?? '',
    database: vars.get('E2E_DATABASE') ?? '',
  }
  const stop = async (timeoutMs = 30_000) => {
    child.stdin!.write('q\n')
    child.stdin!.end()
    return Promise.race([exited, new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))])
  }
  return { child, info, readyMs: Date.now() - t0, output, exited, stop, kill }
}

export interface Json {
  status: number
  body: any
  text: string
  headers: Headers
}

export async function http(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Json> {
  const h: Record<string, string> = { accept: 'application/json', ...headers }
  if (method !== 'GET') h['x-requested-with'] = 'crm'
  if (body !== undefined) h['content-type'] = 'application/json'
  const res = await fetch(`${base}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let parsed: any = text
  try {
    parsed = text ? JSON.parse(text) : undefined
  } catch {
    /* texto */
  }
  return { status: res.status, body: parsed, text, headers: res.headers }
}

/** `message.inbound` válido (WaEvent v1 do @crm/wa-port). */
export function inboundEvent(sessionId: string, id: string, text = 'olá do e2e') {
  return {
    v: 1,
    type: 'message.inbound',
    session_id: sessionId,
    at: new Date().toISOString(),
    message: { id, from: '5599900000001@s.whatsapp.net', from_me: false, timestamp: Date.now(), text, type: 'conversation' },
  }
}
