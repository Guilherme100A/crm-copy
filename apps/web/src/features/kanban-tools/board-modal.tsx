// Modais de quadro da lista (04 §2 `Ykt` e "Modal Excluir Kanban"): tile "Novo quadro", editar nome com prévia das
// colunas padrão e excluir com confirmação nomeada.
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState, type SyntheticEvent } from 'react'
import { Button } from '@/components/ui/button'
import { boardsKey, type BoardDto } from '@/features/crms/api'
import { columnColor } from '@/features/crms/format'
import { useT } from '@/i18n'
import { HttpError } from '@/lib/http'
import { notify } from '@/lib/toast'
import { boardApi } from './api'
import { ConfirmDialog, fieldClass, ModalShell, useCan, type ConfirmRequest } from './dialog'

const PREVIEW_KEYS = ['new', 'qualification', 'won'] as const

function BoardModal({ board, open, onClose }: { board: BoardDto | null; open: boolean; onClose: () => void }) {
  const t = useT('kanban-tools')
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  useEffect(() => {
    if (open) {
      setName(board?.name ?? '')
      setError(null)
    }
  }, [open, board])

  const save = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      setError(t('board.nameRequired'))
      return
    }
    setPending(true)
    setError(null)
    try {
      if (board) await boardApi.rename(board.id, trimmed)
      else {
        const crm = await boardApi.create(trimmed)
        void navigate({ to: '/crms/$crmId', params: { crmId: crm.id } })
      }
      void qc.invalidateQueries({ queryKey: boardsKey })
      onClose()
    } catch (err) {
      setError(err instanceof HttpError ? err.message : t('common.error'))
    } finally {
      setPending(false)
    }
  }

  return (
    <ModalShell open={open} onOpenChange={(o) => !o && onClose()} testId="kt-board-modal" title={board ? t('board.editTitle') : t('board.newTitle')}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t('board.name')}</span>
          <input data-testid="kt-board-name" className={fieldClass} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        {!board ? (
          <div data-testid="kt-board-preview" className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">{t('board.preview')}</p>
            <div className="grid grid-cols-3 gap-2">
              {PREVIEW_KEYS.map((k, i) => (
                <div key={k} className="rounded-lg border bg-muted/40 p-2 text-xs font-medium" style={{ borderTop: `3px solid ${columnColor({ accent_color: null, position: i })}` }}>
                  {t(`board.previewColumns.${k}`)}
                </div>
              ))}
            </div>
          </div>
        ) : null}
        {error ? (
          <p data-testid="kt-board-error" role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" data-testid="kt-board-cancel" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" data-testid="kt-board-save" disabled={pending}>
            {board ? t('common.save') : t('board.create')}
          </Button>
        </div>
      </form>
    </ModalShell>
  )
}

const stop = (e: SyntheticEvent) => {
  e.preventDefault()
  e.stopPropagation()
}

/**
 * Diálogos de quadro da lista. Os modais ficam fora dos tiles (que são links): `dialogs` vai uma vez na página, e
 * `newTile`/`actions(board)` só disparam a abertura.
 */
export function useBoardDialogs() {
  const t = useT('kanban-tools')
  const qc = useQueryClient()
  const can = useCan()
  const [modal, setModal] = useState<{ board: BoardDto | null } | null>(null)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const canEdit = can('kanban.edit')
  const canDelete = can('kanban.delete')

  const askDelete = (board: BoardDto) =>
    setConfirm({
      title: t('board.deleteTitle'),
      body: t('board.deleteBody', { name: board.name }),
      action: t('board.delete'),
      run: async () => {
        try {
          await boardApi.remove(board.id)
          void qc.invalidateQueries({ queryKey: boardsKey })
        } catch (err) {
          notify('kt-error', err instanceof HttpError ? err.message : t('common.error'))
          throw err
        }
      },
    })

  const newTile = canEdit ? (
    <button
      type="button"
      data-testid="kt-board-new"
      onClick={() => setModal({ board: null })}
      className="flex h-full min-h-40 w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-4 text-sm font-medium text-muted-foreground outline-none hover:border-primary/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Plus className="size-5" aria-hidden /> {t('board.newTitle')}
    </button>
  ) : null

  const actions = (board: BoardDto) =>
    canEdit || canDelete ? (
      <span className="flex shrink-0 items-center gap-0.5">
        {canEdit ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            data-testid={`kt-board-edit-${board.id}`}
            aria-label={t('board.editTitle')}
            onClick={(e) => {
              stop(e)
              setModal({ board })
            }}
          >
            <Pencil aria-hidden />
          </Button>
        ) : null}
        {canDelete ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-destructive"
            data-testid={`kt-board-delete-${board.id}`}
            aria-label={t('board.delete')}
            onClick={(e) => {
              stop(e)
              askDelete(board)
            }}
          >
            <Trash2 aria-hidden />
          </Button>
        ) : null}
      </span>
    ) : null

  const dialogs = (
    <>
      <BoardModal board={modal?.board ?? null} open={!!modal} onClose={() => setModal(null)} />
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </>
  )

  return { newTile, actions, dialogs }
}
