// Perfil `ai-manager` do gateway RPC (SPEC T98; AI-MANAGER-MAP §13.5–13.6): o CRM roda sobre o worker do ai-manager
// trocando só configuração (`WA_GATEWAY=rpc` + `WA_RPC_PROFILE=ai-manager`). Os alvos de hoje do `bridgeHandlers`
// (apps/worker/src/boot/internal-server.ts) têm o mesmo nome e assinatura que o wa-worker do CRM; o resto depende
// das mudanças aditivas propostas em docs/extension/ai-manager.md (A3, A7 e A8). Sem o alvo, o worker responde
// `UNKNOWN_METHOD` e o gateway lança `CapabilityNotSupportedError` (ou nem chama a rede, depois da detecção).
import { defaultCapabilities } from '@crm/wa-port'
import type { GatewayMethod, GatewayProfile, RpcRoute } from '../../profiles'

export const AI_MANAGER_PROFILE_NAME = 'ai-manager'

/** Mudança aditiva no ai-manager de que cada rota depende (docs/extension/ai-manager.md). */
export type AiManagerChange = 'A3' | 'A7' | 'A8'

/**
 * Alvos que o ai-manager expõe hoje no `POST /internal/rpc` (lista fechada `bridgeHandlers`), usados pelo perfil.
 * `messages.enqueue` existe, mas é a `MessageQueue` crua (sem os gates do SendPipeline): o perfil NUNCA o usa.
 */
export const AI_MANAGER_CURRENT_ROUTES = {
  'sessions.create': 'sessions.create',
  'sessions.list': 'sessions.list',
  'sessions.get': 'sessions.get',
  'sessions.startQr': 'sessions.startQr',
  'sessions.getQr': 'sessions.getQr',
  // O handler do ai-manager troca null/undefined por "sem telefone".
  'sessions.requestPairingCode': { rpc: 'sessions.requestPairingCode', args: ([id, phone]) => [id, phone ?? null] },
  'sessions.pause': 'sessions.pause',
  'sessions.resume': 'sessions.resume',
  'sessions.restart': 'sessions.restart',
  'sessions.logout': 'sessions.logout',
  'sessions.remove': 'sessions.remove',
  cancel: 'messages.cancel',
  fetchGroups: 'sessions.fetchGroups',
} as const satisfies Partial<Record<GatewayMethod, RpcRoute>>

/** Rotas que só existem com as mudanças aditivas (alvo RPC proposto + mudança). */
export const AI_MANAGER_ADDITIVE_ROUTES = {
  // A8: envio pelo SendPipeline (gates → fila → antiban), com idempotência por clientMessageId.
  send: { rpc: 'messages.send', change: 'A8' },
  sendGroup: { rpc: 'messages.sendGroup', change: 'A8' },
  // A3: mídia sob demanda (bytes em base64 em `{ data }`) e presença.
  downloadMedia: { rpc: 'media.download', change: 'A3' },
  presence: { rpc: 'presence.update', change: 'A3' },
  // A7: consentimento/opt-out sobre o ContactsService e agenda da sessão.
  listContacts: { rpc: 'contacts.list', change: 'A7' },
  recordConsent: { rpc: 'contacts.recordConsent', change: 'A7' },
  optOut: { rpc: 'contacts.optOut', change: 'A7' },
} as const satisfies Partial<Record<GatewayMethod, { rpc: `${string}.${string}`; change: AiManagerChange }>>

export type AiManagerAdditiveMethod = keyof typeof AI_MANAGER_ADDITIVE_ROUTES

/**
 * Perfil completo (alvos de hoje + aditivos). Sem rota nem proposta: `react`, `deleteForEveryone` (obrigatórios da
 * porta → 501 sem rede), `markRead` e `profile.*` (opcionais → ausentes do gateway) e `capabilities` (sem
 * `meta.capabilities`, valem as do perfil).
 */
export const aiManagerProfile: GatewayProfile = {
  name: AI_MANAGER_PROFILE_NAME,
  methods: {
    ...AI_MANAGER_CURRENT_ROUTES,
    ...Object.fromEntries(Object.entries(AI_MANAGER_ADDITIVE_ROUTES).map(([method, r]) => [method, r.rpc])),
  },
  // O transporte Baileys do ai-manager não tem botões/carrossel nativos, chamadas, etiquetas nem perfil comercial.
  capabilities: defaultCapabilities(),
}

/** Cópia do perfil sem as rotas `missing` (chamá-las lança `CapabilityNotSupportedError` sem tocar a rede). */
export function withoutRoutes(profile: GatewayProfile, missing: Iterable<GatewayMethod>): GatewayProfile {
  const methods = { ...profile.methods }
  for (const method of missing) delete methods[method]
  return { ...profile, methods, capabilities: { ...profile.capabilities } }
}
