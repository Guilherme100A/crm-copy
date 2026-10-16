// `/chats/$chatId`: conversa aberta (painel do meio no desktop; tela cheia no mobile).
import { createFileRoute } from '@tanstack/react-router'
import { ChatConversation } from '@/features/chat/chat-layout'

export const Route = createFileRoute('/chats/$chatId')({
  component: ChatRoute,
})

function ChatRoute() {
  const { chatId } = Route.useParams()
  const search = Route.useSearch()
  return <ChatConversation key={chatId} chatId={chatId} search={search} />
}
