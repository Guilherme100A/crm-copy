// `/crms/$crmId` (04 §2 "Quadro"): breadcrumb e o quadro arrastável. Mover card/coluna é otimista (contagens e somas
// na hora); erro do servidor recarrega o quadro e avisa (AC-T70-02). Clicar no card abre a conversa.
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import { notify } from '@/lib/toast'
import { boardKey, boardQuery, boardsKey, fetchMoreCards, labelsQuery, moveCardRequest, moveColumnRequest, type CardDto } from './api'
import { KanbanBoard } from './board-dnd'
import { appendCards, applyTotals, moveCard, moveColumn, replaceCard, type BoardState } from './board-state'

export function CrmBoardPage({ crmId }: { crmId: string }) {
  const t = useT('crms')
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const q = useQuery(boardQuery(queryClient, crmId))
  const labels = useQuery(labelsQuery())
  const [loadingMore, setLoadingMore] = useState<Record<string, boolean>>({})

  const key = useMemo(() => boardKey(crmId), [crmId])
  const current = useCallback(() => queryClient.getQueryData<BoardState>(key), [queryClient, key])

  const reload = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: key })
    void queryClient.invalidateQueries({ queryKey: boardsKey })
  }, [queryClient, key])

  const onMoveCard = useCallback(
    (cardId: string, toColumnId: string, toIndex?: number) => {
      const state = current()
      const r = state && moveCard(state, cardId, toColumnId, toIndex)
      if (!r) return
      void queryClient.cancelQueries({ queryKey: key })
      queryClient.setQueryData<BoardState>(key, r.state)
      moveCardRequest(crmId, cardId, r.body).then(
        ({ card, totals }) => {
          const s = current()
          if (s) queryClient.setQueryData<BoardState>(key, replaceCard(applyTotals(s, totals), card))
          void queryClient.invalidateQueries({ queryKey: boardsKey })
        },
        () => {
          notify('crms-move-error', t('board.moveError'))
          reload()
        },
      )
    },
    [crmId, current, key, queryClient, reload, t],
  )

  const onMoveColumn = useCallback(
    (columnId: string, toIndex: number) => {
      const state = current()
      const next = state && moveColumn(state, columnId, toIndex)
      if (!next) return
      void queryClient.cancelQueries({ queryKey: key })
      queryClient.setQueryData<BoardState>(key, next)
      moveColumnRequest(crmId, columnId, toIndex).then(
        () => void queryClient.invalidateQueries({ queryKey: boardsKey }),
        () => {
          notify('crms-column-move-error', t('board.columnMoveError'))
          reload()
        },
      )
    },
    [crmId, current, key, queryClient, reload, t],
  )

  const onLoadMore = useCallback(
    (columnId: string) => {
      const loaded = current()?.cards[columnId]?.length ?? 0
      setLoadingMore((m) => ({ ...m, [columnId]: true }))
      fetchMoreCards(crmId, columnId, loaded)
        .then(
          ({ items, total }) => {
            const s = current()
            if (s) queryClient.setQueryData<BoardState>(key, appendCards(s, columnId, items, total))
          },
          () => notify('crms-load-more-error', t('board.loadMoreError')),
        )
        .finally(() => setLoadingMore((m) => ({ ...m, [columnId]: false })))
    },
    [crmId, current, key, queryClient, t],
  )

  const onOpenCard = useCallback((card: CardDto) => void navigate({ to: '/chats/$chatId', params: { chatId: card.chat_id } }), [navigate])

  return (
    <section data-testid="crms-board-page" className="flex h-[calc(100dvh-10rem)] min-h-96 w-full min-w-0 flex-col gap-4 lg:h-[calc(100dvh-5rem)]">
      <nav aria-label="breadcrumb" className="flex min-w-0 items-center gap-1 text-sm">
        <Link to="/crms" data-testid="crms-board-back" className="shrink-0 text-muted-foreground hover:text-foreground">
          {t('board.back')}
        </Link>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h1 data-testid="crms-board-title" className="min-w-0 truncate text-lg font-semibold">
          {q.data?.crm.name ?? ''}
        </h1>
      </nav>

      {q.isPending ? (
        <p data-testid="crms-board-loading" className="text-sm text-muted-foreground">
          {t('board.loading')}
        </p>
      ) : q.isError ? (
        <div data-testid="crms-board-error" className="flex items-center gap-3 rounded-lg border p-4 text-sm">
          <span className="flex-1">{t('board.error')}</span>
          <Button variant="outline" size="sm" onClick={() => void q.refetch()}>
            {t('board.retry')}
          </Button>
        </div>
      ) : q.data.columns.length === 0 ? (
        <p data-testid="crms-board-no-columns" className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {t('board.noColumns')}
        </p>
      ) : (
        <KanbanBoard
          state={q.data}
          labels={labels.data ?? {}}
          loadingMore={loadingMore}
          onOpenCard={onOpenCard}
          onMoveCard={onMoveCard}
          onMoveColumn={onMoveColumn}
          onLoadMore={onLoadMore}
        />
      )}
    </section>
  )
}
