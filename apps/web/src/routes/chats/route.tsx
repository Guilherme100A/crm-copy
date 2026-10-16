// `/chats` (spec 18; permissão chat.view): filtros nos search params, compartilhados pela lista e pela conversa.
import { createFileRoute, Outlet, useParams } from '@tanstack/react-router'
import { ChatLayout } from '@/features/chat/chat-layout'
import { registerChatListRealtime } from '@/features/chat-list/realtime'
import { chatSearchSchema } from '@/features/chat-list/search'

// Handlers do SSE registrados junto com a árvore de rotas (antes de o shell abrir a conexão).
registerChatListRealtime()

export const Route = createFileRoute('/chats')({
  validateSearch: chatSearchSchema,
  component: ChatsRoute,
})

function ChatsRoute() {
  const search = Route.useSearch()
  const { chatId } = useParams({ strict: false }) as { chatId?: string }
  return (
    <ChatLayout search={search} chatId={chatId}>
      <Outlet />
    </ChatLayout>
  )
}
