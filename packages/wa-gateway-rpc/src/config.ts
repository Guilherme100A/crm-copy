// Montagem do WaGateway a partir do ambiente (SPEC 3.2/3.12): `WA_GATEWAY=rpc` → `createRpcGateway` sobre
// `WA_RPC_URL` + `INTERNAL_TOKEN` + perfil `WA_RPC_PROFILE`; `WA_GATEWAY=fake` → `FakeWaGateway` (dev/E2E).
// Usado pela API (server.ts) e pelo worker (main.ts), para os dois processos falarem com o mesmo backend.
import { WA_EVENTS_STREAM, type WaGateway } from '@crm/wa-port'
import { FakeWaGateway } from '@crm/wa-port/testing'
import type { Redis } from 'ioredis'
import { createRpcGateway, type RpcGatewayOptions, type RpcWaGateway } from './gateway'
import { gatewayProfileNames, resolveGatewayProfile } from './profiles'

export type WaGatewayMode = 'rpc' | 'fake'

export interface WaGatewayEnvConfig {
  mode: WaGatewayMode
  url: string
  token: string
  profile: string
  stream: string
  redisUrl: string | undefined
  timeoutMs: number | undefined
}

export class WaGatewayConfigError extends Error {
  readonly code = 'WA_GATEWAY_CONFIG'
  constructor(message: string) {
    super(message)
    this.name = 'WaGatewayConfigError'
  }
}

type Env = Record<string, string | undefined>
const val = (env: Env, key: string) => env[key]?.trim() || undefined

/** Lê e valida `WA_GATEWAY`, `WA_RPC_URL`, `INTERNAL_TOKEN`, `WA_RPC_PROFILE`, `WA_EVENTS_STREAM`, `WA_RPC_TIMEOUT_MS`. */
export function loadWaGatewayConfig(env: Env = process.env): WaGatewayEnvConfig {
  const mode = (val(env, 'WA_GATEWAY')?.toLowerCase() ?? 'fake') as WaGatewayMode
  if (mode !== 'rpc' && mode !== 'fake') throw new WaGatewayConfigError(`WA_GATEWAY inválido: ${env.WA_GATEWAY} (use rpc ou fake)`)
  const profile = val(env, 'WA_RPC_PROFILE') ?? 'crm'
  const rawTimeout = val(env, 'WA_RPC_TIMEOUT_MS')
  const timeoutMs = rawTimeout === undefined ? undefined : Number(rawTimeout)
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) throw new WaGatewayConfigError(`WA_RPC_TIMEOUT_MS inválido: ${rawTimeout}`)
  const cfg: WaGatewayEnvConfig = {
    mode,
    url: val(env, 'WA_RPC_URL') ?? '',
    token: val(env, 'INTERNAL_TOKEN') ?? '',
    profile,
    stream: val(env, 'WA_EVENTS_STREAM') ?? WA_EVENTS_STREAM,
    redisUrl: val(env, 'REDIS_URL'),
    timeoutMs,
  }
  if (mode === 'rpc') {
    const missing = [!cfg.url && 'WA_RPC_URL', !cfg.token && 'INTERNAL_TOKEN'].filter(Boolean)
    if (missing.length) throw new WaGatewayConfigError(`WA_GATEWAY=rpc exige ${missing.join(' e ')}`)
    try {
      new URL(cfg.url)
    } catch {
      throw new WaGatewayConfigError(`WA_RPC_URL inválida: ${cfg.url}`)
    }
    if (!gatewayProfileNames().includes(profile)) throw new WaGatewayConfigError(`WA_RPC_PROFILE desconhecido: ${profile} (disponíveis: ${gatewayProfileNames().join(', ')})`)
  }
  return cfg
}

export interface WaGatewayFromEnv {
  mode: WaGatewayMode
  gateway: WaGateway
  /** Só no modo rpc. */
  rpc: RpcWaGateway | undefined
  /** Fecha o leitor do stream (rpc). */
  close(): Promise<void>
}

export interface CreateWaGatewayFromEnvOptions {
  /** Redis do stream de eventos; default `REDIS_URL`. */
  redis?: Redis | string
  logger?: RpcGatewayOptions['logger']
  fetch?: RpcGatewayOptions['fetch']
}

export function createWaGatewayFromEnv(env: Env = process.env, opts: CreateWaGatewayFromEnvOptions = {}): WaGatewayFromEnv {
  const cfg = loadWaGatewayConfig(env)
  if (cfg.mode === 'fake') {
    const gateway = new FakeWaGateway()
    return { mode: 'fake', gateway, rpc: undefined, close: async () => undefined }
  }
  const redis = opts.redis ?? cfg.redisUrl
  const rpc = createRpcGateway({
    url: cfg.url,
    token: cfg.token,
    profile: resolveGatewayProfile(cfg.profile),
    stream: cfg.stream,
    ...(redis ? { redis } : {}),
    ...(cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  })
  return { mode: 'rpc', gateway: rpc, rpc, close: () => rpc.close() }
}
