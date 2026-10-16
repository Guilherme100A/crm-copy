// Slots da tela de chats (T69): conversa (T75), compositor (T85) e painel lateral (T91) entram sem editar esta
// tarefa. Cada módulo cria `src/features/<módulo>/chat-slot.tsx` exportando
//   export const chatSlot: ChatSlot = { area: 'thread' | 'composer' | 'panel', Component }
// e o layout descobre o arquivo por glob (Vite). Sem slot, a área mostra um placeholder.
import type { ComponentType } from 'react'
import type { ChatListItem } from '@/features/chat-list/api'

export const CHAT_SLOT_AREAS = ['thread', 'composer', 'panel'] as const
export type ChatSlotArea = (typeof CHAT_SLOT_AREAS)[number]

export interface ChatSlotProps {
  chatId: string
  /** Dados do chat (da lista ou de `GET /api/chats/:id`); `undefined` enquanto carrega. */
  chat: ChatListItem | undefined
  /** Layout atual (no mobile a conversa ocupa a tela inteira). */
  isDesktop: boolean
}

export interface ChatSlot {
  area: ChatSlotArea
  Component: ComponentType<ChatSlotProps>
}

const isSlot = (v: unknown): v is ChatSlot =>
  !!v && typeof v === 'object' && (CHAT_SLOT_AREAS as readonly string[]).includes((v as ChatSlot).area) && typeof (v as ChatSlot).Component === 'function'

/** Monta o mapa área → componente a partir dos módulos encontrados (o último vence, em ordem de caminho). */
export function collectSlots(modules: Record<string, unknown>): Partial<Record<ChatSlotArea, ComponentType<ChatSlotProps>>> {
  const out: Partial<Record<ChatSlotArea, ComponentType<ChatSlotProps>>> = {}
  for (const path of Object.keys(modules).sort()) {
    const slot = (modules[path] as { chatSlot?: unknown } | undefined)?.chatSlot
    if (isSlot(slot)) out[slot.area] = slot.Component
  }
  return out
}

export const CHAT_SLOTS = collectSlots(import.meta.glob('../*/chat-slot.tsx', { eager: true }))
