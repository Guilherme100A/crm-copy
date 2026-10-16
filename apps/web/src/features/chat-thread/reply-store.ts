// Alvo de "Responder" por chat (T75; spec 03 F41). A thread define e mostra a citação; o compositor (T85) lê com
// `useReplyTarget(chatId)`/`getReplyTarget(chatId)`, envia com `quoted_id = target.id` e limpa com `clearReplyTarget`.
import { useSyncExternalStore } from 'react'
import type { MessageDto } from './api'

export type ReplyTarget = Pick<MessageDto, 'id' | 'type' | 'body' | 'direction' | 'sender_type'>

const targets = new Map<string, ReplyTarget>()
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export function setReplyTarget(chatId: string, message: ReplyTarget): void {
  targets.set(chatId, { id: message.id, type: message.type, body: message.body, direction: message.direction, sender_type: message.sender_type })
  emit()
}

export function clearReplyTarget(chatId: string): void {
  if (targets.delete(chatId)) emit()
}

export const getReplyTarget = (chatId: string): ReplyTarget | null => targets.get(chatId) ?? null

export function useReplyTarget(chatId: string): ReplyTarget | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => getReplyTarget(chatId),
    () => null,
  )
}
