// Catálogo de blocos (06 §3.5; tipos da T10): grupo, ícone e cor de cada tipo. Os rótulos vêm do i18n
// `flow-editor:types.<type>`. `start` não entra na paleta (um só Início por fluxo).
import {
  BadgeDollarSign,
  Bell,
  Bot,
  Building2,
  CreditCard,
  GalleryHorizontalEnd,
  GitBranch,
  Globe,
  Hourglass,
  Kanban,
  LayoutList,
  List,
  MessageSquare,
  MessagesSquare,
  Play,
  QrCode,
  Shuffle,
  Sparkles,
  Tags,
  Target,
  Timer,
  TriangleAlert,
  Workflow,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { NODE_TYPES, type NodeType } from '@crm/shared/flows'

export type BlockGroup = 'messages' | 'interaction' | 'logic' | 'crm' | 'integrations'

export interface BlockInfo {
  type: string
  group: BlockGroup
  icon: LucideIcon
  /** Cor do cabeçalho do nó. */
  color: string
}

const B = (type: NodeType, group: BlockGroup, icon: LucideIcon, color: string): BlockInfo => ({ type, group, icon, color })

export const BLOCKS: Record<NodeType, BlockInfo> = {
  start: B('start', 'logic', Play, '#16a34a'),
  message: B('message', 'messages', MessageSquare, '#2563eb'),
  tags: B('tags', 'crm', Tags, '#9333ea'),
  pix: B('pix', 'messages', QrCode, '#0d9488'),
  interactive_menu: B('interactive_menu', 'interaction', LayoutList, '#ea580c'),
  menu: B('menu', 'interaction', List, '#ea580c'),
  carousel: B('carousel', 'interaction', GalleryHorizontalEnd, '#ea580c'),
  wait_response: B('wait_response', 'interaction', Hourglass, '#ca8a04'),
  chat_controller: B('chat_controller', 'crm', MessagesSquare, '#9333ea'),
  notification: B('notification', 'crm', Bell, '#9333ea'),
  condition: B('condition', 'logic', GitBranch, '#475569'),
  distributor: B('distributor', 'logic', Shuffle, '#475569'),
  connection_flow: B('connection_flow', 'logic', Workflow, '#475569'),
  pixel: B('pixel', 'integrations', Target, '#db2777'),
  smart_interval: B('smart_interval', 'logic', Timer, '#475569'),
  department: B('department', 'crm', Building2, '#9333ea'),
  integration: B('integration', 'integrations', Globe, '#db2777'),
  ai: B('ai', 'integrations', Sparkles, '#7c3aed'),
  ai_agent: B('ai_agent', 'integrations', Bot, '#7c3aed'),
  kanban: B('kanban', 'crm', Kanban, '#9333ea'),
  manipulator: B('manipulator', 'crm', Wrench, '#9333ea'),
  approved_sale: B('approved_sale', 'integrations', BadgeDollarSign, '#16a34a'),
  payment: B('payment', 'integrations', CreditCard, '#16a34a'),
}

export const UNSUPPORTED_BLOCK: BlockInfo = { type: 'unsupported', group: 'logic', icon: TriangleAlert, color: '#b91c1c' }

export const blockOf = (type: string | undefined): BlockInfo => (type && type in BLOCKS ? BLOCKS[type as NodeType] : UNSUPPORTED_BLOCK)

export const GROUP_ORDER: readonly BlockGroup[] = ['messages', 'interaction', 'logic', 'crm', 'integrations']

/** Blocos oferecidos na paleta (todos os suportados menos o Início). */
export const PALETTE_TYPES: readonly NodeType[] = NODE_TYPES.filter((t) => t !== 'start')

const normalize = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()

/** Filtro da busca "Buscar blocos…" pelo rótulo (sem acento/caixa) ou pelo tipo. */
export function searchBlocks(types: readonly NodeType[], query: string, label: (type: NodeType) => string): NodeType[] {
  const q = normalize(query.trim())
  if (!q) return [...types]
  return types.filter((t) => normalize(label(t)).includes(q) || t.includes(q))
}

/** Tipo arrastado da paleta (06 §2.2: `dataTransfer "application/reactflow"`). */
export const DND_MIME = 'application/reactflow'
