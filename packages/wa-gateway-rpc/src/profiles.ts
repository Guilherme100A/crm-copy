// Perfis do gateway RPC (SPEC T46; AI-MANAGER-MAP §13.6): mapa método do `WaGateway` → `target.method` do
// `POST /internal/rpc`. O CRM roda sobre o wa-worker próprio (perfil `crm`) ou sobre o worker do ai-manager (perfil
// `ai-manager`, T98, em `profiles/ai-manager/**`) trocando só o perfil. Método sem rota = capacidade ausente: o
// gateway lança `CapabilityNotSupportedError` sem chamar a rede (métodos opcionais da porta nem aparecem).
import { defaultCapabilities, type WaCapabilities } from '@crm/wa-port'

/** Métodos do `WaGateway` que viram chamada RPC (`subscribe` lê o stream; não passa pelo RPC). */
export const GATEWAY_METHODS = [
  'sessions.create',
  'sessions.list',
  'sessions.get',
  'sessions.startQr',
  'sessions.getQr',
  'sessions.requestPairingCode',
  'sessions.pause',
  'sessions.resume',
  'sessions.restart',
  'sessions.logout',
  'sessions.remove',
  'send',
  'sendGroup',
  'cancel',
  'fetchGroups',
  'downloadMedia',
  'presence',
  'react',
  'deleteForEveryone',
  'listContacts',
  'recordConsent',
  'optOut',
  'markRead',
  'profile.get',
  'profile.setName',
  'profile.setStatus',
  'profile.setPicture',
  /** Capacidades consultadas no worker (`refreshCapabilities`); sem rota valem as do perfil. */
  'capabilities',
] as const
export type GatewayMethod = (typeof GATEWAY_METHODS)[number]

/**
 * Rota de um método: `'target.method'` (os argumentos do `WaGateway` vão na mesma ordem) ou um objeto com
 * adaptadores, para backends cuja assinatura difere (ex.: ai-manager).
 */
export type RpcRoute =
  | `${string}.${string}`
  | {
      rpc: `${string}.${string}`
      /** Argumentos do método do `WaGateway` → `args` do RPC. */
      args?: (args: unknown[]) => unknown[]
      /** Resultado do RPC → retorno do método do `WaGateway`. */
      result?: (raw: unknown) => unknown
    }

export interface GatewayProfile {
  name: string
  methods: Partial<Record<GatewayMethod, RpcRoute | undefined>>
  /** Capacidades usadas até (ou sem) a consulta ao worker. */
  capabilities: WaCapabilities
}

/**
 * Perfil `crm`: o wa-worker do próprio CRM (apps/wa-worker/src/rpc/targets.ts, T29). Completo: todo método da porta
 * tem rota. `capabilities` → `meta.capabilities` (ainda não exposto pelo wa-worker: o gateway cai nas do perfil).
 */
export const crmProfile: GatewayProfile = {
  name: 'crm',
  methods: {
    'sessions.create': 'sessions.create',
    'sessions.list': 'sessions.list',
    'sessions.get': 'sessions.get',
    'sessions.startQr': 'sessions.startQr',
    'sessions.getQr': 'sessions.getQr',
    'sessions.requestPairingCode': { rpc: 'sessions.requestPairingCode', args: ([id, phone]) => [id, phone ?? null] },
    'sessions.pause': 'sessions.pause',
    'sessions.resume': 'sessions.resume',
    'sessions.restart': 'sessions.restart',
    'sessions.logout': 'sessions.logout',
    'sessions.remove': 'sessions.remove',
    send: 'messages.enqueue',
    sendGroup: 'messages.sendGroup',
    cancel: 'messages.cancel',
    fetchGroups: 'sessions.fetchGroups',
    downloadMedia: 'media.download',
    presence: 'presence.update',
    react: 'messages.react',
    deleteForEveryone: 'messages.deleteForEveryone',
    listContacts: 'contacts.list',
    recordConsent: 'contacts.recordConsent',
    optOut: 'contacts.optOut',
    markRead: 'messages.markRead',
    'profile.get': 'profile.get',
    'profile.setName': 'profile.setName',
    'profile.setStatus': 'profile.setStatus',
    'profile.setPicture': 'profile.setPicture',
    capabilities: 'meta.capabilities',
  },
  // O transporte Baileys do wa-worker não tem recursos nativos; perfil comercial (nome/recado/foto) responde 501.
  capabilities: defaultCapabilities(),
}

const registry = new Map<string, GatewayProfile>([[crmProfile.name, crmProfile]])

/** Registra um perfil (ex.: `ai-manager`, T98). Substitui o de mesmo nome. */
export function registerGatewayProfile(profile: GatewayProfile): void {
  registry.set(profile.name, profile)
}

export function gatewayProfileNames(): string[] {
  return [...registry.keys()]
}

export class UnknownGatewayProfileError extends Error {
  readonly code = 'UNKNOWN_GATEWAY_PROFILE'
  constructor(name: string) {
    super(`perfil de gateway desconhecido: ${name} (disponíveis: ${gatewayProfileNames().join(', ')})`)
    this.name = 'UnknownGatewayProfileError'
  }
}

/** Nome registrado → perfil; objeto → ele mesmo. */
export function resolveGatewayProfile(profile: string | GatewayProfile = crmProfile.name): GatewayProfile {
  if (typeof profile !== 'string') return profile
  const found = registry.get(profile)
  if (!found) throw new UnknownGatewayProfileError(profile)
  return found
}

/** `'target.method'` e os adaptadores de uma rota. */
export interface ResolvedRoute {
  target: string
  method: string
  args: ((args: unknown[]) => unknown[]) | undefined
  result: ((raw: unknown) => unknown) | undefined
}

export function routeOf(route: RpcRoute): ResolvedRoute {
  const spec = typeof route === 'string' ? { rpc: route, args: undefined, result: undefined } : route
  const dot = spec.rpc.indexOf('.')
  return { target: spec.rpc.slice(0, dot), method: spec.rpc.slice(dot + 1), args: spec.args, result: spec.result }
}
