// Tela de chats (T69): desktop com 3 painéis (lista | conversa | painel lateral); mobile com telas separadas
// (lista em /chats, conversa em tela cheia em /chats/$chatId com botão de voltar) — AC-T69-04.
import { useQuery, type InfiniteData } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowLeft, MessagesSquare } from 'lucide-react'
import type { ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { chatDetailQuery, CHAT_LIST_KEY, type ChatListItem, type ChatListPage } from '@/features/chat-list/api'
import { ChatListPanel, contactLabel } from '@/features/chat-list/chat-list-panel'
import type { ChatSearch } from '@/features/chat-list/search'
import { useT } from '@/i18n'
import { useIsDesktop } from '@/lib/use-media-query'
import { cn } from '@/lib/utils'
import { CHAT_SLOTS } from './slots'

/** Altura útil abaixo do header/breadcrumbs do shell (a página não rola; cada painel rola sozinho). */
const PANE_HEIGHT = 'h-[calc(100dvh-13.5rem)] min-h-80 lg:h-[calc(100dvh-5.5rem)]'

/** O chat da lista em cache (sem esperar o `GET /api/chats/:id`). */
function useCachedChat(chatId: string): ChatListItem | undefined {
  const queryClient = useQueryClient()
  for (const [, data] of queryClient.getQueriesData<InfiniteData<ChatListPage>>({ queryKey: CHAT_LIST_KEY })) {
    const hit = data?.pages?.flatMap((p) => p.items).find((c) => c.id === chatId)
    if (hit) return hit
  }
  return undefined
}

export function ChatConversation({ chatId, search }: { chatId: string; search: ChatSearch }) {
  const t = useT('chat')
  const isDesktop = useIsDesktop()
  const cached = useCachedChat(chatId)
  const detail = useQuery({ ...chatDetailQuery(chatId), placeholderData: cached })
  const chat = detail.data ?? cached
  const Thread = CHAT_SLOTS.thread
  const Composer = CHAT_SLOTS.composer

  return (
    <section data-testid="chat-conversation" data-chat-id={chatId} className="flex h-full min-h-0 min-w-0 flex-col rounded-lg border bg-card">
      <header className="flex items-center gap-2 border-b px-3 py-2">
        {isDesktop ? null : (
          <Link
            to="/chats"
            search={search}
            data-testid="chat-back"
            aria-label={t('back')}
            className="-ml-1 rounded-md p-2 hover:bg-accent"
          >
            <ArrowLeft className="size-5" aria-hidden />
          </Link>
        )}
        <div className="min-w-0 flex-1">
          <h2 data-testid="chat-conversation-name" className="truncate text-sm font-semibold">
            {chat ? contactLabel(chat.contact) : detail.isError ? t('notFound') : '…'}
          </h2>
          {chat?.contact.phone_e164 && chat.contact.name ? <p className="truncate text-xs text-muted-foreground">{chat.contact.phone_e164}</p> : null}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {Thread ? (
          <Thread chatId={chatId} chat={chat} isDesktop={isDesktop} />
        ) : (
          <div data-testid="chat-thread-placeholder" className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
            {t('threadSoon')}
          </div>
        )}
      </div>
      {Composer ? (
        <div className="border-t">
          <Composer chatId={chatId} chat={chat} isDesktop={isDesktop} />
        </div>
      ) : null}
    </section>
  )
}

export function ChatConversationEmpty() {
  const t = useT('chat')
  return (
    <section data-testid="chat-conversation-empty" className="flex h-full min-h-0 flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
      <MessagesSquare className="size-8" aria-hidden />
      <p className="font-medium text-foreground">{t('empty.title')}</p>
      <p>{t('empty.hint')}</p>
    </section>
  )
}

/** `children` = o conteúdo da rota filha (conversa ou estado vazio). */
export function ChatLayout({ search, chatId, children }: { search: ChatSearch; chatId?: string; children: ReactNode }) {
  const t = useT('chat')
  const isDesktop = useIsDesktop()
  const Panel = CHAT_SLOTS.panel

  if (!isDesktop)
    return (
      <div data-testid="chat-page" data-layout="mobile" className={cn('flex min-w-0 flex-col', PANE_HEIGHT)}>
        <h1 className="sr-only">{t('title')}</h1>
        {chatId ? children : <ChatListPanel search={search} />}
      </div>
    )

  return (
    <div data-testid="chat-page" data-layout="desktop" className={cn('grid min-w-0 gap-4', PANE_HEIGHT, Panel && chatId ? 'grid-cols-[22rem_minmax(0,1fr)_20rem]' : 'grid-cols-[22rem_minmax(0,1fr)]')}>
      <h1 className="sr-only">{t('title')}</h1>
      <ChatListPanel search={search} selectedId={chatId} />
      <div data-testid="chat-conversation-panel" className="min-h-0 min-w-0">
        {children}
      </div>
      {Panel && chatId ? (
        <aside data-testid="chat-panel-slot" className="min-h-0 overflow-y-auto rounded-lg border bg-card">
          <Panel chatId={chatId} chat={undefined} isDesktop />
        </aside>
      ) : null}
    </div>
  )
}
