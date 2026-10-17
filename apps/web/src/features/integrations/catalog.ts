// Catálogo do hub de integrações (SPEC 2.4, compartilhado ADITIVO; 19 §2.2–§2.4): as abas de categoria, os itens fixos
// ("Disponíveis", com o botão Configurar) e as fontes de registros da conta ("Conectadas na sua conta", com status
// Ativo/Inativo). A T59 registra a categoria IA (chaves BYOK da T38); Vendas e Rastreamento recebem os cards da T114.
//
// Para acrescentar uma integração (ex.: T114), adicione linhas em `CATALOG` e/ou `RECORD_SOURCES` com a categoria,
// rótulos i18n do seu módulo e `loadModal` (o modal é da tarefa dona; `modalKind: 'ai'` é atendido pelo próprio hub).
import type { ComponentType } from 'react'
import { AI_KEY_PROVIDERS, AI_KEYS_KEY, fetchAiKeys, type AiKeyDto, type AiKeyProvider } from './api'

export const INTEGRATION_CATEGORIES = ['ai', 'sales', 'tracking'] as const
export type IntegrationCategory = (typeof INTEGRATION_CATEGORIES)[number]
export const DEFAULT_CATEGORY: IntegrationCategory = 'ai'

/** Qual modal o "Configurar"/"Editar" abre (19 §5.1 item 1). */
export type ModalKind = 'ai' | 'payments' | 'invoice' | 'utmify'

/** Props do modal de uma integração que não é do hub (`loadModal`). */
export interface IntegrationModalProps {
  action: 'create' | 'edit' | 'delete'
  /** Item do catálogo (Configurar). */
  item?: CatalogItem
  /** Registro da conta (Editar/Excluir). */
  record?: IntegrationRecord
  onClose: () => void
}

type LoadModal = () => Promise<{ default: ComponentType<IntegrationModalProps> }>

export interface CatalogItem {
  /** Único no catálogo (vira testid `integrations-catalog-<id>`). */
  id: string
  category: IntegrationCategory
  /** `<módulo>:<chave>` no i18n. */
  titleKey: string
  descriptionKey: string
  /** Código do provedor/gateway (pré-seleciona o modal). */
  provider: string
  /** Nome do provedor para a busca e o subtítulo (nome próprio, sem tradução). */
  providerLabel: string
  /** Fallback do logo (iniciais). */
  initials: string
  modalKind: ModalKind
  /** Qualquer uma basta para Configurar; owner sempre pode. */
  editPermissions?: readonly string[]
  /** Chip "Em breve" no lugar do botão. */
  comingSoon?: boolean
  /** Modal da tarefa dona quando `modalKind !== 'ai'`. */
  loadModal?: LoadModal
}

/** Registro da conta mostrado como card com status (19 §2.4). */
export interface IntegrationRecord {
  id: string
  /** `RecordSource.id` de onde veio. */
  sourceId: string
  category: IntegrationCategory
  title: string
  /** Nome do provedor (subtítulo). */
  providerLabel: string
  provider: string
  initials: string
  /** Ativo/Inativo (19 §4.1). */
  active: boolean
  /** Linha extra (ex.: dica mascarada do segredo `…abcd`). */
  detail?: string
  /** Chave efetiva do provedor (T38 `in_use`: a ativa mais recente). */
  inUse?: boolean
  modalKind: ModalKind
}

export interface RecordSource {
  id: string
  category: IntegrationCategory
  /** Para listar (owner sempre vê). */
  viewPermissions: readonly string[]
  editPermissions: readonly string[]
  deletePermissions: readonly string[]
  query: () => { queryKey: readonly unknown[]; queryFn: () => Promise<IntegrationRecord[]> }
  /** Modal da tarefa dona quando os registros não são do hub. */
  loadModal?: LoadModal
}

const INTEGRATIONS_EDIT = ['settings.integrations.edit'] as const

export const AI_PROVIDER_LABEL: Record<AiKeyProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google Gemini',
  openrouter: 'OpenRouter',
  elevenlabs: 'ElevenLabs',
  groq: 'Groq',
}

export const AI_PROVIDER_INITIALS: Record<AiKeyProvider, string> = {
  anthropic: 'AN',
  openai: 'OA',
  google: 'GM',
  openrouter: 'OR',
  elevenlabs: 'EL',
  groq: 'GQ',
}

/** Cartão da chave BYOK: status pelo `active` (a T38 devolve `configured: true` sempre). */
export function aiKeyRecord(k: AiKeyDto): IntegrationRecord {
  return {
    id: k.id,
    sourceId: 'ai-keys',
    category: 'ai',
    title: k.name,
    provider: k.provider,
    providerLabel: AI_PROVIDER_LABEL[k.provider] ?? k.provider,
    initials: AI_PROVIDER_INITIALS[k.provider] ?? k.provider.slice(0, 2).toUpperCase(),
    active: k.active,
    detail: k.hint,
    inUse: k.in_use,
    modalKind: 'ai',
  }
}

/** Itens fixos, na ordem de exibição. */
export const CATALOG: CatalogItem[] = [
  // T59: IA (os 6 provedores das chaves BYOK da T38).
  ...AI_KEY_PROVIDERS.map(
    (p): CatalogItem => ({
      id: p,
      category: 'ai',
      titleKey: `integrations:catalog.${p}.title`,
      descriptionKey: `integrations:catalog.${p}.description`,
      provider: p,
      providerLabel: AI_PROVIDER_LABEL[p],
      initials: AI_PROVIDER_INITIALS[p],
      modalKind: 'ai',
      editPermissions: INTEGRATIONS_EDIT,
    }),
  ),
  // T114: Vendas (pagamentos, NF) e Rastreamento (UTMify) entram aqui.
]

/** Fontes de registros da conta. */
export const RECORD_SOURCES: RecordSource[] = [
  // T59: chaves de IA (T38).
  {
    id: 'ai-keys',
    category: 'ai',
    viewPermissions: ['settings.integrations.view'],
    editPermissions: INTEGRATIONS_EDIT,
    deletePermissions: ['settings.integrations.delete'],
    // Chave própria (outra forma de dado que `aiKeysQuery`); invalidar `AI_KEYS_KEY` recarrega as duas.
    query: () => ({ queryKey: [...AI_KEYS_KEY, 'records'], queryFn: async () => (await fetchAiKeys()).map(aiKeyRecord) }),
  },
]
