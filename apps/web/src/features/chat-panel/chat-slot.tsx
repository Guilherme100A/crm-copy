// Slot `panel` da tela de chats (contrato da T69, features/chat/slots.ts): o painel lateral entra aqui.
import type { ChatSlot } from '@/features/chat/slots'
import { ChatPanel } from './panel'

export const chatSlot: ChatSlot = { area: 'panel', Component: ChatPanel }
