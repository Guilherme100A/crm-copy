// Conversa (T75; spec 03 F23–F30, F41–F47): histórico em rolagem reversa (subir carrega mais 25 mantendo a posição),
// marca como lido ao abrir, mensagens novas do SSE no fim (rola só se já estava no fim), menu por mensagem.
import { Dialog } from '@base-ui/react/dialog'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, Reply, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { ChatSlotProps } from '@/features/chat/slots'
import { applyToCache } from '@/features/chat-list/realtime'
import { useI18n, useT } from '@/i18n'
import { HttpError } from '@/lib/http'
import { profileQuery } from '@/lib/session'
import { notify } from '@/lib/toast'
import { messagesQuery, notesQuery, threadApi, threadKey, type MessageDto } from './api'
import { ForwardDialog } from './forward-dialog'
import { MessageBubble, NoteBubble, type MessageActions } from './message-bubble'
import { onThreadAppend } from './realtime'
import { clearReplyTarget, setReplyTarget, useReplyTarget } from './reply-store'
import { applyReaction, buildTimeline, copyText, findMessage, findQuoted, flattenMessages, patchMessage, type ThreadData } from './timeline'

/** Distância do fim (px) que ainda conta como "no fim". */
export const BOTTOM_SLACK_PX = 80

export const isNearBottom = (el: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>, slack = BOTTOM_SLACK_PX) =>
  el.scrollHeight - el.scrollTop - el.clientHeight <= slack

function ReplyPreview({ chatId }: { chatId: string }) {
  const t = useT('chat-thread')
  const target = useReplyTarget(chatId)
  if (!target) return null
  return (
    <div data-testid="chat-reply-preview" data-message-id={target.id} className="flex items-center gap-2 border-t bg-muted/50 px-3 py-2 text-sm">
      <Reply className="size-4 shrink-0 text-primary" aria-hidden />
      <div className="min-w-0 flex-1 border-l-2 border-primary/60 pl-2">
        <p className="text-xs font-medium text-primary">{t('replyingTo')}</p>
        <p className="truncate text-xs text-muted-foreground">{target.body?.trim() || t(`types.${target.type}`)}</p>
      </div>
      <button type="button" data-testid="chat-reply-cancel" aria-label={t('cancel')} onClick={() => clearReplyTarget(chatId)} className="rounded-md p-1 hover:bg-accent">
        <X className="size-4" aria-hidden />
      </button>
    </div>
  )
}

export function ChatThread({ chatId }: ChatSlotProps) {
  const t = useT('chat-thread')
  const { locale } = useI18n()
  const qc = useQueryClient()
  const me = useQuery(profileQuery()).data?.user.id ?? null
  const q = useInfiniteQuery(messagesQuery(chatId))
  const notes = useQuery(notesQuery(chatId))
  const messages = useMemo(() => flattenMessages(q.data as ThreadData | undefined), [q.data])
  const timeline = useMemo(() => buildTimeline(messages, notes.data ?? [], !!q.hasNextPage), [messages, notes.data, q.hasNextPage])

  const scrollRef = useRef<HTMLDivElement>(null)
  const topRef = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const anchor = useRef<{ height: number; top: number } | null>(null)
  const pendingScroll = useRef(false)
  const initialized = useRef(false)
  const [unseen, setUnseen] = useState(0)
  const [forwarding, setForwarding] = useState<MessageDto | null>(null)
  const [deleting, setDeleting] = useState<MessageDto | null>(null)

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    atBottom.current = true
    setUnseen(0)
  }, [])

  const markRead = useCallback(() => {
    threadApi
      .markRead(chatId)
      .then((r) => applyToCache(qc, r.chat as never))
      .catch(() => undefined)
  }, [chatId, qc])

  // Abrir o chat marca como lido (AC-T75-01).
  useEffect(() => markRead(), [markRead])

  // 1ª carga: começa no fim.
  useLayoutEffect(() => {
    if (initialized.current || !q.data) return
    initialized.current = true
    scrollToBottom()
  }, [q.data, scrollToBottom])

  // Página antiga chegou: mantém a mensagem que estava no topo no mesmo lugar (AC-T75-01).
  const pages = q.data?.pages.length ?? 0
  useLayoutEffect(() => {
    const el = scrollRef.current
    const a = anchor.current
    if (!el || !a) return
    el.scrollTop = el.scrollHeight - a.height + a.top
    anchor.current = null
  }, [pages])

  // Mensagem nova no fim: rola só se já estava no fim (ou se fui eu que enviei); senão conta "novas" (AC-T75-05).
  useLayoutEffect(() => {
    if (!pendingScroll.current) return
    pendingScroll.current = false
    scrollToBottom()
  }, [messages.length, scrollToBottom])

  useEffect(
    () =>
      onThreadAppend((id, m) => {
        if (id !== chatId) return
        const mine = m.direction === 'outbound' && !!me && m.sender_user_id === me
        if (atBottom.current || mine) {
          pendingScroll.current = true
          if (m.direction === 'inbound') markRead()
        } else if (m.direction === 'inbound') setUnseen((n) => n + 1)
      }),
    [chatId, me, markRead],
  )

  // Topo visível: carrega a página anterior.
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = q
  useEffect(() => {
    const el = topRef.current
    const root = scrollRef.current
    if (!el || !root || !hasNextPage) return
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting) || isFetchingNextPage || !initialized.current) return
        anchor.current = { height: root.scrollHeight, top: root.scrollTop }
        void fetchNextPage()
      },
      { root, rootMargin: '80px 0px 0px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, pages])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    atBottom.current = isNearBottom(el)
    if (atBottom.current && unseen) setUnseen(0)
  }

  const patch = (id: string, p: Partial<MessageDto>) => qc.setQueryData<ThreadData>(threadKey(chatId), (d) => (d ? patchMessage(d, id, p) : d))
  const fail = (err: unknown, key: string) => notify('chat-thread-error', err instanceof HttpError && err.status < 500 && err.message ? err.message : t(key))

  const actions: MessageActions = {
    onReply: (m) => setReplyTarget(chatId, m),
    onForward: (m) => setForwarding(m),
    onCopy: (m) => {
      void navigator.clipboard
        ?.writeText(copyText(m))
        .then(() => notify('chat-copied', t('copied')))
        .catch(() => notify('chat-thread-error', t('errors.copy')))
    },
    onDelete: (m) => setDeleting(m),
    onReact: (m, emoji) => {
      const current = findMessage(qc.getQueryData<ThreadData>(threadKey(chatId)), m.id) ?? m
      const mine = current.reactions?.find((r) => r.user_id && r.user_id === me)?.emoji
      const next = mine === emoji ? '' : emoji
      const before = current.reactions
      patch(m.id, { reactions: applyReaction(before, { emoji: next, user_id: me }) })
      threadApi.react(chatId, m.id, next).catch((err) => {
        patch(m.id, { reactions: before ?? [] })
        fail(err, 'errors.react')
      })
    },
    onRetry: (m) => {
      patch(m.id, { status: 'queued', error: null })
      threadApi
        .retry(chatId, m.id)
        .then((r) => patch(m.id, { status: r.message.status, error: r.message.error, pipeline_message_id: r.message.pipeline_message_id }))
        .catch((err) => {
          patch(m.id, { status: 'failed' })
          fail(err, 'errors.retry')
        })
    },
  }

  const confirmDelete = async () => {
    const m = deleting
    if (!m) return
    setDeleting(null)
    try {
      const r = await threadApi.deleteForEveryone(chatId, m.id)
      patch(m.id, { deleted_at: r.message.deleted_at ?? new Date().toISOString() })
    } catch (err) {
      fail(err, 'errors.delete')
    }
  }

  const dayLabel = (iso: string) => new Date(iso).toLocaleDateString(locale, { day: '2-digit', month: 'long', year: 'numeric' })

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div ref={scrollRef} data-testid="chat-thread" data-chat-id={chatId} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto py-3" aria-live="polite">
        {hasNextPage ? <div ref={topRef} data-testid="chat-thread-top" className="h-1" aria-hidden /> : null}
        {isFetchingNextPage ? (
          <p data-testid="chat-thread-loading-older" className="py-2 text-center text-xs text-muted-foreground">
            {t('loadingOlder')}
          </p>
        ) : null}
        {q.isPending ? (
          <div data-testid="chat-thread-loading" className="flex flex-col gap-3 px-3" aria-busy="true">
            {[60, 40, 70, 50].map((w, i) => (
              <div key={i} className={`flex ${i % 2 ? 'justify-end' : ''}`}>
                <div className="h-12 animate-pulse rounded-xl bg-muted" style={{ width: `${w}%` }} />
              </div>
            ))}
          </div>
        ) : q.isError ? (
          <div data-testid="chat-thread-error" className="flex flex-col items-center gap-2 p-6 text-center text-sm">
            <p className="text-destructive">{t('errors.load')}</p>
            <Button variant="outline" size="sm" onClick={() => void q.refetch()}>
              {t('errors.retryLoad')}
            </Button>
          </div>
        ) : timeline.length === 0 ? (
          <p data-testid="chat-thread-empty" className="p-6 text-center text-sm text-muted-foreground">
            {t('empty')}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {timeline.map((it) =>
              it.kind === 'day' ? (
                <div key={`d-${it.day}`} className="flex justify-center">
                  <span className="rounded-full bg-muted px-3 py-0.5 text-[11px] text-muted-foreground">{dayLabel(it.at)}</span>
                </div>
              ) : it.kind === 'note' ? (
                <NoteBubble key={`n-${it.note.id}`} id={it.note.id} body={it.note.body} author={it.note.author?.name ?? null} at={it.note.created_at} />
              ) : (
                <MessageBubble key={it.message.id} m={it.message} chatId={chatId} quoted={findQuoted(messages, it.message)} actions={actions} />
              ),
            )}
          </div>
        )}
      </div>

      {unseen > 0 ? (
        <button
          type="button"
          data-testid="chat-thread-new-messages"
          onClick={scrollToBottom}
          className="absolute bottom-16 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-lg"
        >
          <ArrowDown className="size-3.5" aria-hidden /> {t('newMessages', { count: unseen })}
        </button>
      ) : null}

      <ReplyPreview chatId={chatId} />

      <ForwardDialog
        open={!!forwarding}
        onOpenChange={(o) => !o && setForwarding(null)}
        currentChatId={chatId}
        onForward={async (target) => {
          if (!forwarding) return
          await threadApi.forward(chatId, forwarding.id, target)
          notify('chat-forwarded', t('forward.done'))
        }}
      />

      <Dialog.Root open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/40" />
          <Dialog.Popup
            data-testid="chat-delete-confirm"
            className="fixed top-1/2 left-1/2 z-50 flex w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-xl border bg-background p-5 shadow-xl outline-none"
          >
            <Dialog.Title className="text-lg font-semibold">{t('delete.title')}</Dialog.Title>
            <Dialog.Description className="text-sm text-muted-foreground">{t('delete.body')}</Dialog.Description>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDeleting(null)}>
                {t('cancel')}
              </Button>
              <Button variant="destructive" data-testid="chat-delete-confirm-submit" onClick={() => void confirmDelete()}>
                {t('delete.submit')}
              </Button>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}
