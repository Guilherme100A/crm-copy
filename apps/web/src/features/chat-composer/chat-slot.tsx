// Slot `composer` da tela de chats (contrato da T69, features/chat/slots.ts): o compositor entra aqui sem editar a T69.
import type { ChatSlot } from '@/features/chat/slots'
import { ChatComposer } from './composer'

export const chatSlot: ChatSlot = { area: 'composer', Component: ChatComposer }
