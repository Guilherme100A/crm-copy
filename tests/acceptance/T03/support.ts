// Apoio da suíte T03 (não é arquivo de teste). Acesso ao @crm/wa-port só pela superfície pública:
// entrada principal `@crm/wa-port` e subpaths declarados em `exports` do package.json (`./testing`, `./contract`).
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { rootPath } from '../helpers/exec'

export const PKG_DIR = rootPath('packages', 'wa-port')
export const pkgJson = (): any => JSON.parse(readFileSync(resolve(PKG_DIR, 'package.json'), 'utf8'))

/** Alvo de um subpath em `exports` (condição `development` → fonte, como na SPEC 3.1). */
export function exportTarget(sub: string): string | undefined {
  const exp = pkgJson().exports ?? {}
  const entry = exp[`./${sub}`]
  if (!entry) return undefined
  if (typeof entry === 'string') return entry
  const pick = (e: any): string | undefined =>
    typeof e === 'string' ? e : e && (pick(e.development) ?? pick(e.import) ?? pick(e.types) ?? pick(e.default))
  return pick(entry)
}

/** Importa um subpath público do pacote (`testing`, `contract`). */
export async function importSubpath(sub: string): Promise<any> {
  const target = exportTarget(sub)
  if (target) {
    const abs = resolve(PKG_DIR, target)
    if (existsSync(abs)) return import(pathToFileURL(abs).href)
  }
  // Fallback: alias da config (packages/wa-port/src/<sub>/index.ts).
  const fallback = resolve(PKG_DIR, 'src', sub, 'index.ts')
  if (existsSync(fallback)) return import(pathToFileURL(fallback).href)
  throw new Error(`@crm/wa-port não expõe o subpath "./${sub}" (exports do package.json nem src/${sub}/index.ts)`)
}

export const pkgSrcDir = () => resolve(PKG_DIR, 'src')
export const dirOf = (f: string) => dirname(f)

// ---------- FakeWaGateway ----------

export async function newFakeGateway(): Promise<any> {
  const mod = await importSubpath('testing')
  if (typeof mod.FakeWaGateway === 'function') return new mod.FakeWaGateway()
  if (typeof mod.createFakeWaGateway === 'function') return mod.createFakeWaGateway()
  throw new Error('@crm/wa-port/testing não exporta FakeWaGateway')
}

/** Assina os eventos do gateway fake (subscribe | onEvent | on). Devolve a função de cancelamento, se houver. */
export function subscribeEvents(gw: any, fn: (ev: any) => void): unknown {
  if (typeof gw.subscribe === 'function') return gw.subscribe(fn)
  if (typeof gw.onEvent === 'function') return gw.onEvent(fn)
  if (gw.events && typeof gw.events.subscribe === 'function') return gw.events.subscribe(fn)
  if (typeof gw.on === 'function') return gw.on.length >= 2 ? gw.on('event', fn) : gw.on(fn)
  throw new Error('FakeWaGateway sem forma de assinar eventos (subscribe/onEvent/on)')
}

/** Cria uma sessão simulada no fake (quando suportado) e devolve o id. */
export async function ensureSession(gw: any): Promise<string> {
  try {
    const s = await gw.sessions?.create?.({ name: 'Teste T03', phone: '+5511999990000' })
    if (s && typeof s.id === 'string') return s.id
  } catch {
    /* sessão simulada indisponível: usa id fixo */
  }
  return 'sess-t03'
}

export const sendReq = (sessionId: string, text = 'olá') => ({
  sessionId,
  phone: '+5511988887777',
  content: { text },
  actor: 'crm:user-t03',
})

// ---------- WaEvent ----------

export type ParseOutcome = { ok: true; value: any } | { ok: false; error: string }

/** Normaliza parseWaEvent (lança | safeParse | null) num resultado único. */
export function tryParse(parse: (x: unknown) => any, input: unknown): ParseOutcome {
  try {
    const r = parse(input)
    if (r === undefined || r === null || r === false) return { ok: false, error: `devolveu ${String(r)}` }
    if (typeof r === 'object' && 'success' in r && typeof r.success === 'boolean') {
      return r.success ? { ok: true, value: r.data } : { ok: false, error: String(r.error?.message ?? r.error) }
    }
    return { ok: true, value: r }
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

const toCamel = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
function camelize(v: any): any {
  if (Array.isArray(v)) return v.map(camelize)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [toCamel(k), camelize(x)]))
  return v
}

const SID = 'sess-t03'
const JID = '5511999998888@s.whatsapp.net'
const LID = '112233445566@lid'
const MSG_MIN = { id: 'MSG-1', from: JID, from_me: false, timestamp: 1_760_000_000_000, type: 'conversation', text: 'olá' }
const MSG_FULL = { ...MSG_MIN, id: 'MSG-2', alt_jid: LID, push_name: 'Maria', quoted_id: 'MSG-0' }

/** Formas plausíveis (snake_case no fio, SPEC 3.6/3.8) do corpo de cada tipo; o teste exige que ao menos uma seja aceita. */
const BODIES: Record<string, Array<Record<string, unknown>>> = {
  'message.inbound': [{ message: MSG_MIN }, { message: MSG_FULL }],
  'message.status': [
    { message_id: 'out-1', transport_message_id: 'WAID-1', status: 'delivered' },
    { message_id: 'out-1', status: 'delivered' },
  ],
  'session.state': [{ from: 'WARMING', to: 'STABLE' }],
  'session.connection': [{ state: 'close', reason: 'transient' }, { state: 'open' }],
  'session.qr': [{ qr: '2@AbCdEf,GhIj,KlMn' }, { qr: 'data:image/png;base64,iVBORw0KGgo=' }],
  'session.pairing_code': [{ code: 'ABCD1234' }, { pairing_code: 'ABCD1234' }],
  'contact.upsert': [
    { contact: { jid: JID, phone: '+5511999998888', name: 'Maria' } },
    { contact: { jid: JID, phone: '+5511999998888', lid: LID, name: 'Maria', push_name: 'Maria' } },
    { contacts: [{ jid: JID, phone: '+5511999998888', name: 'Maria' }] },
    { jid: JID, phone: '+5511999998888', name: 'Maria' },
  ],
  'contact.lid_mapping': [{ lid: LID, pn: JID }, { lid: LID, pn: '+5511999998888' }],
  'presence.update': [
    { jid: JID, presence: 'composing' },
    { from: JID, presence: 'composing' },
    { jid: JID, state: 'composing' },
  ],
  'history.batch': [{ messages: [MSG_MIN] }, { messages: [MSG_MIN, MSG_FULL] }],
}

export const EVENT_TYPES = Object.keys(BODIES)

/** Candidatos completos (envelope + corpo), em snake_case e camelCase, com e sem `at`. */
export function candidates(type: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const body of BODIES[type] ?? []) {
    const snake = { v: 1, type, session_id: SID, ...body }
    const withAt = { ...snake, at: '2026-10-15T12:00:00.000Z' }
    for (const c of [snake, withAt]) {
      out.push(c)
      const camel = camelize(c)
      camel.type = type
      out.push(camel)
    }
  }
  return out
}

/** Primeiro candidato aceito pelo parser, ou o motivo de rejeição de cada um. */
export function firstAccepted(parse: (x: unknown) => any, type: string) {
  const errors: string[] = []
  for (const c of candidates(type)) {
    const r = tryParse(parse, c)
    if (r.ok) return { input: c, parsed: r.value, errors }
    errors.push(`${JSON.stringify(c)} → ${r.error.slice(0, 300)}`)
  }
  return { input: undefined, parsed: undefined, errors }
}

export const jsonClone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T
