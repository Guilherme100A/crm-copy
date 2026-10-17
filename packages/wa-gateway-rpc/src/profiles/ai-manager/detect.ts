// Detecção de capacidades ausentes no worker do ai-manager (SPEC T98). Cada alvo aditivo (A3/A7/A8) é sondado UMA vez
// com `args: []`: a lista fechada do `POST /internal/rpc` responde `UNKNOWN_METHOD` antes de chamar qualquer handler
// quando o alvo não existe; com o alvo, o handler rejeita a chamada vazia (validação) sem efeito colateral. O perfil
// devolvido não tem as rotas ausentes: o gateway lança `CapabilityNotSupportedError` sem chamar a rede.
import { CapabilityNotSupportedError, WorkerUnavailableError } from '../../errors'
import { createRpcGateway, DEFAULT_RPC_TIMEOUT_MS, type RpcGatewayOptions, type RpcWaGateway } from '../../gateway'
import {
  GATEWAY_METHODS,
  resolveGatewayProfile,
  routeOf,
  type GatewayMethod,
  type GatewayProfile,
} from '../../profiles'
import { createRpcClient, type FetchLike } from '../../rpc-client'
import {
  AI_MANAGER_ADDITIVE_ROUTES,
  aiManagerProfile,
  withoutRoutes,
  type AiManagerAdditiveMethod,
  type AiManagerChange,
} from './profile'

export interface DetectAiManagerOptions {
  /** `WA_RPC_URL` do worker do ai-manager. */
  url: string
  /** `INTERNAL_TOKEN` (o mesmo do ai-manager). */
  token: string
  /** Perfil de partida. Default: `aiManagerProfile`. */
  profile?: GatewayProfile
  timeoutMs?: number
  fetch?: FetchLike
}

export interface AiManagerCapabilityReport {
  /** Perfil sem as rotas ausentes. */
  profile: GatewayProfile
  /** Métodos do gateway com rota no worker. */
  supported: GatewayMethod[]
  /** Métodos sem rota (no perfil ou no worker): capacidade ausente. */
  missing: GatewayMethod[]
  /** Mudanças aditivas que faltam aplicar no ai-manager para cobrir os métodos ausentes. */
  missingChanges: AiManagerChange[]
}

/** Sonda os alvos aditivos do perfil e devolve o perfil efetivo do worker. Falha de rede propaga (`WorkerUnavailableError`). */
export async function detectAiManagerCapabilities(opts: DetectAiManagerOptions): Promise<AiManagerCapabilityReport> {
  const base = opts.profile ?? aiManagerProfile
  const client = createRpcClient({
    url: opts.url,
    token: opts.token,
    timeoutMs: opts.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS,
    profile: base.name,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  })
  const absent = new Set<GatewayMethod>()
  const probed = new Map<string, Promise<boolean>>()
  const exists = (target: string, method: string) => {
    const rpc = `${target}.${method}`
    let p = probed.get(rpc)
    if (!p) {
      p = client.call(target, method, []).then(
        () => true,
        (err: unknown) => {
          if (err instanceof CapabilityNotSupportedError) return false
          if (err instanceof WorkerUnavailableError) throw err
          return true // o handler existe e recusou a chamada vazia
        },
      )
      probed.set(rpc, p)
    }
    return p
  }
  await Promise.all(
    (Object.keys(AI_MANAGER_ADDITIVE_ROUTES) as AiManagerAdditiveMethod[]).map(async (method) => {
      const spec = base.methods[method]
      if (!spec) return
      const route = routeOf(spec)
      if (!(await exists(route.target, route.method))) absent.add(method)
    }),
  )
  const profile = withoutRoutes(base, absent)
  const supported = GATEWAY_METHODS.filter((m) => profile.methods[m] !== undefined)
  const missing = GATEWAY_METHODS.filter((m) => profile.methods[m] === undefined)
  const missingChanges = [
    ...new Set([...absent].map((m) => AI_MANAGER_ADDITIVE_ROUTES[m as AiManagerAdditiveMethod].change)),
  ].sort()
  return { profile, supported, missing, missingChanges }
}

export interface AiManagerGateway extends RpcWaGateway {
  readonly capabilityReport: AiManagerCapabilityReport
}

/** `createRpcGateway` com o perfil `ai-manager` já reduzido ao que o worker tem (detecção no boot). */
export async function createAiManagerGateway(
  opts: Omit<RpcGatewayOptions, 'profile'> & { profile?: GatewayProfile },
): Promise<AiManagerGateway> {
  const report = await detectAiManagerCapabilities({
    url: opts.url,
    token: opts.token,
    ...(opts.profile ? { profile: opts.profile } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  })
  const gateway = createRpcGateway({ ...opts, profile: report.profile })
  return Object.assign(gateway, { capabilityReport: report })
}

export interface LazyAiManagerGateway extends RpcWaGateway {
  /** Relatório da detecção; dispara a sonda se ainda não rodou. */
  capabilityReport(): Promise<AiManagerCapabilityReport>
}

/**
 * Versão síncrona de `createAiManagerGateway` (usada por `createWaGatewayFromEnv`): o gateway nasce com o perfil
 * completo e a detecção roda UMA vez, na primeira chamada de um método aditivo (A3/A7/A8). Depois dela, as rotas
 * ausentes saem do perfil e o método lança `CapabilityNotSupportedError` sem rede. Falha da sonda (worker fora, token
 * recusado) propaga para a chamada e a próxima tenta de novo. Sessões, cancel e grupos nunca esperam a sonda.
 */
export function createLazyAiManagerGateway(opts: RpcGatewayOptions): LazyAiManagerGateway {
  const base = resolveGatewayProfile(opts.profile ?? aiManagerProfile)
  // Cópia mutável: o gateway lê `profile.methods` a cada chamada, então remover a rota basta.
  const profile: GatewayProfile = { ...base, methods: { ...base.methods }, capabilities: { ...base.capabilities } }
  const gateway = createRpcGateway({ ...opts, profile })
  let detection: Promise<AiManagerCapabilityReport> | undefined
  const detect = () =>
    (detection ??= detectAiManagerCapabilities({
      url: opts.url,
      token: opts.token,
      profile: base,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    }).then(
      (report) => {
        for (const method of report.missing) delete profile.methods[method]
        return report
      },
      (err: unknown) => {
        detection = undefined
        throw err
      },
    ))
  const lazy = gateway as unknown as Record<AiManagerAdditiveMethod, (...args: unknown[]) => Promise<unknown>>
  for (const method of Object.keys(AI_MANAGER_ADDITIVE_ROUTES) as AiManagerAdditiveMethod[]) {
    const call = lazy[method]
    lazy[method] = async (...args: unknown[]) => {
      await detect()
      return call(...args)
    }
  }
  return Object.assign(gateway, { capabilityReport: detect })
}
