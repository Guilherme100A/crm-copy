// Modal Criar cartão (04 §2 `dAt`): busca os chats ainda sem card neste quadro (paginados, "Carregar mais chats"),
// seleção de um chat e criação do card na coluna escolhida.
import { useInfiniteQuery } from '@tanstack/react-query'
import { Loader2, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { CardDto } from '@/features/crms/api'
import { formatPhone } from '@/features/crms/format'
import { useT } from '@/i18n'
import { HttpError } from '@/lib/http'
import { cn } from '@/lib/utils'
import { availableChats, createCard } from './api'
import { fieldClass, ModalShell } from './dialog'

const SEARCH_DEBOUNCE_MS = 300

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms)
    return () => clearTimeout(id)
  }, [value, ms])
  return v
}

export function CardModal({
  crmId,
  columnId,
  onClose,
  onCreated,
}: {
  crmId: string
  /** `null` = fechado. */
  columnId: string | null
  onClose: () => void
  onCreated: (card: CardDto) => void
}) {
  const t = useT('kanban-tools')
  const open = !!columnId
  const [search, setSearch] = useState('')
  const term = useDebounced(search.trim(), SEARCH_DEBOUNCE_MS)
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (open) {
      setSearch('')
      setSelected(null)
      setError(null)
    }
  }, [open])

  const q = useInfiniteQuery({
    queryKey: ['crms', 'available-chats', crmId, term] as const,
    enabled: open,
    initialPageParam: 1,
    staleTime: 0,
    queryFn: ({ pageParam }) => availableChats(crmId, term, pageParam),
    getNextPageParam: (last) => (last.page.has_more ? last.page.page + 1 : undefined),
  })
  const items = q.data?.pages.flatMap((p) => p.items) ?? []

  const save = async () => {
    if (!columnId || !selected) return
    setPending(true)
    setError(null)
    try {
      onCreated(await createCard(crmId, selected, columnId))
      onClose()
    } catch (err) {
      setError(err instanceof HttpError ? err.message : t('common.error'))
    } finally {
      setPending(false)
    }
  }

  return (
    <ModalShell open={open} onOpenChange={(o) => !o && onClose()} testId="kt-card-modal" title={t('card.title')}>
      <label className="relative block">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <input
          data-testid="kt-card-search"
          type="search"
          className={cn(fieldClass, 'pl-9')}
          placeholder={t('card.search')}
          aria-label={t('card.search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>

      <div className="flex max-h-80 min-h-24 flex-col gap-1 overflow-y-auto" aria-busy={q.isFetching}>
        {q.isPending ? (
          <p className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden /> {t('card.loading')}
          </p>
        ) : q.isError ? (
          <p className="p-3 text-sm text-destructive">{t('common.error')}</p>
        ) : items.length === 0 ? (
          term ? (
            <p data-testid="kt-card-no-results" className="p-3 text-center text-sm text-muted-foreground">
              {t('card.noResults')}
            </p>
          ) : (
            <p data-testid="kt-card-empty" className="p-3 text-center text-sm text-muted-foreground">
              {t('card.empty')}
            </p>
          )
        ) : (
          items.map((c) => (
            <button
              key={c.id}
              type="button"
              data-testid={`kt-card-chat-${c.id}`}
              aria-pressed={selected === c.id}
              onClick={() => setSelected(c.id)}
              className={cn(
                'flex min-w-0 flex-col rounded-lg border px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring',
                selected === c.id ? 'border-primary bg-primary/10' : 'hover:bg-accent',
              )}
            >
              <span className="truncate text-sm font-medium">{c.customer_name}</span>
              <span className="truncate text-xs text-muted-foreground">
                {[formatPhone(c.customer_phone), c.last_message_preview].filter(Boolean).join(' · ')}
              </span>
            </button>
          ))
        )}
        {q.hasNextPage ? (
          <Button data-testid="kt-card-load-more" variant="ghost" size="sm" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            {q.isFetchingNextPage ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {t('card.loadMore')}
          </Button>
        ) : null}
      </div>

      {error ? (
        <p data-testid="kt-card-error" role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button variant="outline" data-testid="kt-card-cancel" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button data-testid="kt-card-save" disabled={!selected || pending} onClick={() => void save()}>
          {t('card.save')}
        </Button>
      </div>
    </ModalShell>
  )
}
