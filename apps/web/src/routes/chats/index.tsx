// `/chats`: sem chat aberto (no desktop, o painel do meio mostra o estado vazio; no mobile, só a lista).
import { createFileRoute } from '@tanstack/react-router'
import { ChatConversationEmpty } from '@/features/chat/chat-layout'

export const Route = createFileRoute('/chats/')({
  component: ChatConversationEmpty,
})
