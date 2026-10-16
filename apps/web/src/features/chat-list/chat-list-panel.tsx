// Coluna da lista de chats (T69; spec 03 F01–F14 e "Observado no app"): abas por status com contadores, busca,
// filtros rápidos (Tudo / Não lidas / Não respondidas), filtros avançados (modal), itens e rolagem infinita.
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { SlidersHorizontal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useI18n, useT } from '@/i18n'
import { cn } from '@/lib/utils'
import { chatListQuery, connectionNamesQuery, type ChatListItem } from './api'
import { ChatFiltersDialog } from './filters-dialog'
import { activeTab, advancedCount, CHAT_TABS, cleanSearch, type ChatSearch, type ChatTab, type QuickFilter } from './search'

export const SEARCH_DEBOUNCE_MS = 300

/** Iniciais do nome; sem nome, `+DDI` do telefone. */
export function avatarText(c: ChatListItem['contact']): string {
  // Só palavras que começam com letra ("Cliente 17" → "C", não "C1").
  const words = (c.name ?? '').trim().split(/\s+/).filter((w) => /^\p{L}/u.test(w))
  if (words.length)
    return words
      .slice(0, 2)
      .map((p) => p[0]!.toUpperCase())
      .join('')
  const phone = c.phone_e164 ?? ''
  return phone ? `+${phone.replace(/\D/g, '').slice(0, 2)}` : '?'
}

export const contactLabel = (c: ChatListItem['contact']) => c.name?.trim() || c.phone_e164 || c.wa_lid || '—'

/** Hora se hoje; senão data curta. */
export function formatListTime(iso: string | null, locale: string, now = new Date()): string {
  if (!iso) return ''
  const d = new Date(iso)
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  return sameDay ? d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString(locale, { day: '2-digit', month: '2-digit' })
}

function ChatRow({ chat, selected, connectionName }: { chat: ChatListItem; selected: boolean; connectionName?: string }) {
  const t = useT('chat-list')
  const { locale } = useI18n()
  const unread = chat.unread_count > 0
  return (
    <li>
      <Link
        to="/chats/$chatId"
        params={{ chatId: chat.id }}
        search={(s) => s}
        data-testid={`chat-list-item-${chat.id}`}
        data-unread={chat.unread_count}
        aria-current={selected ? 'true' : undefined}
        className={cn('flex min-w-0 items-start gap-3 rounded-lg px-3 py-2.5 hover:bg-accent', selected && 'bg-accent')}
      >
        <span className="relative flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary" aria-hidden>
          {avatarText(chat.contact)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span data-testid={`chat-list-item-name-${chat.id}`} className={cn('min-w-0 flex-1 truncate text-sm', unread ? 'font-semibold' : 'font-medium')}>
              {contactLabel(chat.contact)}
            </span>
            <time className="shrink-0 text-xs text-muted-foreground" dateTime={chat.last_message_at ?? chat.created_at}>
              {formatListTime(chat.last_message_at ?? chat.created_at, locale)}
            </time>
          </span>
          <span className="mt-0.5 flex items-center gap-2">
            <span data-testid={`chat-list-item-preview-${chat.id}`} className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {chat.last_message_preview || t('item.noMessages')}
            </span>
            {unread ? (
              <span
                data-testid={`chat-list-item-unread-${chat.id}`}
                className="shrink-0 rounded-full bg-primary px-1.5 py-0.5 text-[10px] leading-none font-semibold text-primary-foreground"
                aria-label={t('item.unread', { count: chat.unread_count })}
              >
                {chat.unread_count > 99 ? '99+' : chat.unread_count}
              </span>
            ) : null}
          </span>
          {connectionName || chat.assigned_user ? (
            <span className="mt-1 flex min-w-0 flex-wrap gap-1">
              {connectionName ? <span className="max-w-full truncate rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{connectionName}</span> : null}
              {chat.assigned_user ? (
                <span className="max-w-full truncate rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{chat.assigned_user.name}</span>
              ) : null}
            </span>
          ) : null}
        </span>
      </Link>
    </li>
  )
}

function useSearchSetter(search: ChatSearch) {
  const navigate = useNavigate()
  return (patch: Partial<ChatSearch>) => void navigate({ to: '.', search: cleanSearch({ ...search, ...patch }), replace: true })
}

export function ChatListPanel({ search, selectedId }: { search: ChatSearch; selectedId?: string }) {
  const t = useT('chat-list')
  const setSearch = useSearchSetter(search)
  const tab = activeTab(search)
  const q = useInfiniteQuery(chatListQuery(search))
  const names = useQuery(connectionNamesQuery()).data ?? {}
  const items = q.data?.pages.flatMap((p) => p.items) ?? []
  const counts = q.data?.pages[0]?.counts
  const [text, setText] = useState(search.search ?? '')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)

  // Busca com debounce; a URL só muda depois da pausa.
  useEffect(() => {
    const next = text.trim() || undefined
    if (next === search.search) return
    const id = setTimeout(() => setSearch({ search: next }), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [text]) // só a digitação dispara

  // Rolagem infinita: a sentinela no fim do contêiner pede a próxima página (AC-T69-03).
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = q
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || !hasNextPage) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !isFetchingNextPage) void fetchNextPage()
      },
      { root: listRef.current, rootMargin: '120px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, items.length])

  const quick: (QuickFilter | 'all')[] = ['all', 'unread', 'unanswered']
  const nAdvanced = advancedCount(search)

  return (
    <section data-testid="chat-list-panel" className="flex h-full min-h-0 min-w-0 flex-col gap-3">
      <div className="flex items-center gap-2">
        <input
          type="search"
          data-testid="chat-search"
          aria-label={t('search')}
          placeholder={t('search')}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm"
        />
        <Button variant="outline" size="sm" data-testid="chat-filters-open" onClick={() => setFiltersOpen(true)} aria-label={t('filters.open')} className="relative shrink-0">
          <SlidersHorizontal aria-hidden />
          <span className="hidden sm:inline">{t('filters.button')}</span>
          {nAdvanced ? (
            <span data-testid="chat-filters-count" className="rounded-full bg-primary px-1.5 text-[10px] leading-4 font-semibold text-primary-foreground">
              {nAdvanced}
            </span>
          ) : null}
        </Button>
      </div>

      <div role="tablist" aria-label={t('tabs.label')} className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
        {CHAT_TABS.map((s: ChatTab) => {
          const active = s === tab
          return (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`chat-tab-${s}`}
              data-active={active ? 'true' : 'false'}
              onClick={() => setSearch({ status: s === 'waiting' ? undefined : s })}
              className={cn(
                'flex min-w-0 items-center justify-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium text-muted-foreground',
                active && 'bg-background text-foreground shadow-sm',
              )}
            >
              <span className="truncate">{t(`tabs.${s}`)}</span>
              <span data-testid={`chat-tab-count-${s}`} className="shrink-0 rounded-full bg-muted-foreground/15 px-1.5 text-[10px] leading-4">
                {counts ? counts[s] : '·'}
              </span>
            </button>
          )
        })}
      </div>

      <div className="flex flex-wrap gap-1" role="group" aria-label={t('quick.label')}>
        {quick.map((f) => {
          const active = (search.quick ?? 'all') === f
          return (
            <button
              key={f}
              type="button"
              data-testid={`chat-quick-${f}`}
              aria-pressed={active}
              onClick={() => setSearch({ quick: f === 'all' ? undefined : f })}
              className={cn('rounded-full border px-3 py-1 text-xs', active ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent')}
            >
              {t(`quick.${f}`)}
            </button>
          )
        })}
      </div>

      <div ref={listRef} data-testid="chat-list" className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
        {q.isPending ? (
          <div data-testid="chat-list-loading" className="flex flex-col gap-2" aria-busy="true">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flex items-center gap-3 px-3 py-2">
                <div className="size-10 animate-pulse rounded-full bg-muted" />
                <div className="flex flex-1 flex-col gap-1.5">
                  <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
                  <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
                </div>
              </div>
            ))}
          </div>
        ) : q.isError ? (
          <div data-testid="chat-list-error" className="flex flex-col items-start gap-2 p-3 text-sm">
            <p className="text-destructive">{t('errors.load')}</p>
            <Button variant="outline" size="sm" onClick={() => void q.refetch()}>
              {t('errors.retry')}
            </Button>
          </div>
        ) : items.length === 0 ? (
          <div data-testid="chat-list-empty" data-status={tab} className="flex flex-col items-center gap-1 px-4 py-10 text-center text-sm text-muted-foreground">
            <p className="font-medium text-foreground">{t(`empty.${tab}`)}</p>
            <p>{search.search || search.quick || nAdvanced ? t('empty.filtered') : t('empty.hint')}</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5" aria-label={t('list.label')}>
            {items.map((c) => (
              <ChatRow key={c.id} chat={c} selected={c.id === selectedId} connectionName={names[c.connection_id]} />
            ))}
          </ul>
        )}
        {hasNextPage ? <div ref={sentinelRef} data-testid="chat-list-sentinel" className="h-4" aria-hidden /> : null}
        {isFetchingNextPage ? (
          <p data-testid="chat-list-loading-more" className="py-3 text-center text-xs text-muted-foreground">
            {t('list.loadingMore')}
          </p>
        ) : null}
      </div>

      <ChatFiltersDialog open={filtersOpen} onOpenChange={setFiltersOpen} search={search} onApply={(f) => setSearch(f)} />
    </section>
  )
}
