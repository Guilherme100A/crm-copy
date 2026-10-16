// Slot `thread` da tela de chats (contrato da T69, features/chat/slots.ts): a conversa entra aqui sem editar a T69.
// O módulo é carregado junto da rota /chats (glob eager), então os handlers do SSE ficam registrados antes de o shell
// abrir a conexão.
import type { ChatSlot } from '@/features/chat/slots'
import { ChatThread } from './chat-thread'
import { registerThreadRealtime } from './realtime'

registerThreadRealtime()

export const chatSlot: ChatSlot = { area: 'thread', Component: ChatThread }
