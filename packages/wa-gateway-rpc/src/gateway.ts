// `createRpcGateway`: a implementação de produção do `WaGateway` (SPEC T46), igual para o wa-worker próprio (perfil
// `crm`) e para o worker do ai-manager (perfil `ai-manager`, T98). Comandos via `POST /internal/rpc` (perfil →
// `target.method`), eventos pelo Redis Stream `wsm:events`. Nada aqui envia direto: `send`, `sendGroup`, `react` e
// `deleteForEveryone` caem no SendPipeline do worker (SPEC 1.4 nº 2).
import type {
  CreateSessionInput,
  DeleteForEveryoneRequest,
  GroupSummary,
  MediaBody,
  MediaHandle,
  MessageView,
  OptOutInput,
  PresenceKind,
  ReactRequest,
  RecordConsentInput,
  SendGroupRequest,
  SendRequest,
  SessionView,
  WaCapabilities,
  WaContactSummary,
  WaEventListener,
  WaGateway,
  WaProfile,
  WaProfileControl,
  WaSessionsControl,
  MediaRef,
} from '@crm/wa-port'
import type { Redis } from 'ioredis'
import { CapabilityNotSupportedError } from './errors'
import { resolveGatewayProfile, routeOf, type GatewayMethod, type GatewayProfile } from './profiles'
import { createRpcClient, type FetchLike, type RpcCallOptions } from './rpc-client'
import { EventStreamTail, type StreamLogger } from './stream'

export const DEFAULT_RPC_TIMEOUT_MS = 30_000
/** O pareamento espera o código do transporte (ai-manager: 60 s). */
export const DEFAULT_PAIRING_TIMEOUT_MS = 60_000

export interface RpcGatewayOptions {
  /** Base do worker (`WA_RPC_URL`), ex.: `http://127.0.0.1:3100`. */
  url: string
  /** `INTERNAL_TOKEN`. */
  token: string
  /** Nome registrado (`crm`, `ai-manager`) ou perfil próprio. Default `crm`. */
  profile?: string | GatewayProfile
  /** Redis do stream de eventos (instância ou URL). Necessário só para `subscribe`. */
  redis?: Redis | string
  /** Default `wsm:events` (`WA_EVENTS_STREAM`). */
  stream?: string
  /** Timeout de cada chamada. Default 30 s. */
  timeoutMs?: number
  /** Timeout de `sessions.requestPairingCode`. Default 60 s. */
  pairingTimeoutMs?: number
  /** BLOCK do XREAD do `subscribe`. Default 1000 ms. */
  blockMs?: number
  fetch?: FetchLike
  logger?: StreamLogger & { debug?(obj: object, msg?: string): void }
}

export interface RpcWaGateway extends WaGateway {
  readonly gatewayProfile: GatewayProfile
  /** Chamada crua ao RPC (diagnóstico). */
  call<T = unknown>(target: string, method: string, args?: unknown[], opts?: RpcCallOptions): Promise<T>
  /**
   * Consulta as capacidades no worker (rota `capabilities` do perfil) e atualiza `capabilities` no lugar. Sem rota,
   * ou se o worker não conhece o alvo, mantém as do perfil. Falha de rede propaga (`WorkerUnavailableError`).
   */
  refreshCapabilities(): Promise<WaCapabilities>
  /** Fecha o leitor do stream. Idempotente. */
  close(): Promise<void>
}

const CAPABILITY_KEYS = ['nativeButtons', 'nativeCarousel', 'calls', 'labelsSync', 'businessProfile'] as const

/** Bytes que atravessam o RPC em base64 (`media.download` → `{ data }`). */
function toMediaBody(raw: unknown): MediaBody {
  if (raw instanceof Uint8Array) return raw
  const data = typeof raw === 'string' ? raw : raw && typeof raw === 'object' ? (raw as { data?: unknown }).data : undefined
  if (typeof data !== 'string') throw new TypeError('media.download: resposta sem `data` em base64')
  return new Uint8Array(Buffer.from(data, 'base64'))
}

const toProfile = (raw: unknown): WaProfile => {
  const p = (raw ?? {}) as Partial<Record<keyof WaProfile, unknown>>
  const str = (v: unknown) => (typeof v === 'string' ? v : null)
  return { name: str(p.name), status: str(p.status), pictureUrl: str(p.pictureUrl) }
}

export function createRpcGateway(opts: RpcGatewayOptions): RpcWaGateway {
  const profile = resolveGatewayProfile(opts.profile)
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS
  const pairingTimeoutMs = opts.pairingTimeoutMs ?? Math.max(DEFAULT_PAIRING_TIMEOUT_MS, timeoutMs)
  const client = createRpcClient({ url: opts.url, token: opts.token, timeoutMs, profile: profile.name, ...(opts.fetch ? { fetch: opts.fetch } : {}) })
  const capabilities: WaCapabilities = { ...profile.capabilities }
  let tail: EventStreamTail | undefined
  let closed = false

  const has = (method: GatewayMethod) => profile.methods[method] !== undefined

  /** Chama a rota do perfil; sem rota lança CapabilityNotSupportedError sem tocar a rede. */
  async function invoke<T>(method: GatewayMethod, args: unknown[], callOpts?: RpcCallOptions): Promise<T> {
    const spec = profile.methods[method]
    if (!spec) throw new CapabilityNotSupportedError(method, profile.name)
    const route = routeOf(spec)
    const raw = await client.call(route.target, route.method, route.args ? route.args(args) : args, callOpts)
    return (route.result ? route.result(raw) : raw) as T
  }
  const run = async (method: GatewayMethod, args: unknown[]) => {
    await invoke(method, args)
  }

  const sessions: WaSessionsControl = {
    create: (input: CreateSessionInput) => invoke<SessionView>('sessions.create', [input]),
    list: () => invoke<SessionView[]>('sessions.list', []),
    get: (id) => invoke<SessionView>('sessions.get', [id]),
    startQr: (id) => invoke<SessionView>('sessions.startQr', [id]),
    getQr: (id) => invoke<{ qr: string | null; generatedAt: string | null }>('sessions.getQr', [id]),
    requestPairingCode: (id, phone) => invoke<{ code: string }>('sessions.requestPairingCode', [id, phone], { timeoutMs: pairingTimeoutMs }),
    pause: (id) => invoke<SessionView>('sessions.pause', [id]),
    resume: (id) => invoke<SessionView>('sessions.resume', [id]),
    restart: (id) => invoke<SessionView>('sessions.restart', [id]),
    logout: (id) => invoke<SessionView>('sessions.logout', [id]),
    remove: (id) => invoke<{ deletedProxyId: string | null }>('sessions.remove', [id]),
  }

  let profileControl: WaProfileControl | undefined
  if (has('profile.get')) {
    profileControl = { get: async (sessionId) => toProfile(await invoke('profile.get', [sessionId])) }
    if (has('profile.setName')) profileControl.setName = (sessionId: string, name: string) => run('profile.setName', [sessionId, name])
    if (has('profile.setStatus')) profileControl.setStatus = (sessionId: string, status: string) => run('profile.setStatus', [sessionId, status])
    if (has('profile.setPicture')) profileControl.setPicture = (sessionId: string, picture: MediaRef) => run('profile.setPicture', [sessionId, picture])
  }

  const gateway: RpcWaGateway = {
    capabilities,
    gatewayProfile: profile,
    sessions,
    // O pedido vai inteiro: clientMessageId (idempotência), quoted e viewOnce chegam ao worker (T49/T21).
    send: (req: SendRequest) => invoke<MessageView>('send', [req]),
    sendGroup: (req: SendGroupRequest) => invoke<MessageView>('sendGroup', [req]),
    cancel: (messageId) => invoke<MessageView>('cancel', [messageId]),
    fetchGroups: (sessionId) => invoke<GroupSummary[]>('fetchGroups', [sessionId]),
    downloadMedia: async (sessionId, ref: MediaHandle) => toMediaBody(await invoke('downloadMedia', [sessionId, ref])),
    presence: (sessionId, to, kind: PresenceKind) => run('presence', [sessionId, to, kind]),
    react: (req: ReactRequest) => invoke<MessageView>('react', [req]),
    deleteForEveryone: (req: DeleteForEveryoneRequest) => invoke<MessageView>('deleteForEveryone', [req]),
    listContacts: (sessionId) => invoke<WaContactSummary[]>('listContacts', [sessionId]),
    recordConsent: (input: RecordConsentInput) => run('recordConsent', [input]),
    optOut: (input: OptOutInput) => run('optOut', [input]),
    ...(has('markRead') ? { markRead: (sessionId: string, chatJid: string, messageIds: string[]) => run('markRead', [sessionId, chatJid, messageIds]) } : {}),
    ...(profileControl ? { profile: profileControl } : {}),
    subscribe(listener: WaEventListener) {
      if (closed) throw new Error('gateway fechado: subscribe indisponível')
      if (!opts.redis) throw new Error('createRpcGateway: `redis` é obrigatório para subscribe (stream de eventos)')
      tail ??= new EventStreamTail({
        redis: opts.redis,
        ...(opts.stream ? { stream: opts.stream } : {}),
        ...(opts.blockMs !== undefined ? { blockMs: opts.blockMs } : {}),
        ...(opts.logger ? { logger: opts.logger } : {}),
      })
      return tail.subscribe(listener)
    },
    call: (target, method, args = [], callOpts) => client.call(target, method, args, callOpts),
    async refreshCapabilities() {
      if (!has('capabilities')) return capabilities
      let remote: unknown
      try {
        remote = await invoke('capabilities', [])
      } catch (err) {
        if (err instanceof CapabilityNotSupportedError) {
          opts.logger?.debug?.({ profile: profile.name }, 'worker sem consulta de capacidades; valem as do perfil')
          return capabilities
        }
        throw err
      }
      const r = (remote ?? {}) as Partial<Record<keyof WaCapabilities, unknown>>
      for (const key of CAPABILITY_KEYS) if (typeof r[key] === 'boolean') capabilities[key] = r[key]
      return capabilities
    },
    async close() {
      closed = true
      await tail?.close()
    },
  }
  return gateway
}
