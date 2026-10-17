// Editor das ações de uma resposta rápida (17 §3.A): lista reordenável (arrasto pela alça com @dnd-kit/react 0.5.1, ou
// pelos botões subir/descer), mensagem, mídia enviada pelo `POST /api/media`, figurinha e contato.
import { move } from '@dnd-kit/helpers'
import {
  DragDropProvider,
  KeyboardSensor,
  PointerSensor,
  type DragDropManager,
  type DragEndEvent,
} from '@dnd-kit/react'
import { useSortable } from '@dnd-kit/react/sortable'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowDown,
  ArrowUp,
  FileUp,
  GripVertical,
  Image,
  Loader2,
  MessageSquare,
  Smile,
  Trash2,
  UserRound,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import { cn } from '@/lib/utils'
import { QR_ACTION_TYPES, QR_MEDIA_TYPES, quickRepliesApi, stickersQuery, type QrActionType } from './api'
import { inputClass, serverMessage, textareaClass } from './kit'
import { draftKey, emptyConfig, MAX_ACTIONS, mediaTypeOf, moveItem, type DraftAction } from './rules'
import { apiUrl } from '@/lib/base'

const NS = 'settings-quick-replies'
const P = 'quick-replies'

const ICONS: Record<QrActionType, ReactNode> = {
  send_message: <MessageSquare aria-hidden />,
  send_multi_media: <Image aria-hidden />,
  send_sticker: <Smile aria-hidden />,
  send_contact: <UserRound aria-hidden />,
}

const SENSORS = [PointerSensor, KeyboardSensor]

export function ActionsEditor({
  actions,
  onChange,
  invalid,
}: {
  actions: DraftAction[]
  onChange: (next: DraftAction[]) => void
  invalid?: { index: number; field: string } | null
}) {
  const t = useT(NS)
  const add = (type: QrActionType) => onChange([...actions, { key: draftKey(), type, config: emptyConfig(type) }])
  const patch = (i: number, config: Record<string, unknown>, extra?: Partial<DraftAction>) =>
    onChange(actions.map((a, j) => (j === i ? { ...a, ...extra, config: { ...a.config, ...config } } : a)))

  // Como no quadro (crms/board-dnd.tsx): a mudança só entra depois que a renderização do dragend termina.
  const onDragEnd = (event: DragEndEvent, manager: DragDropManager) => {
    if (event.canceled) return
    const keys = move(
      actions.map((a) => a.key),
      event,
    )
    void manager.renderer.rendering.then(() =>
      setTimeout(() => {
        const byKey = new Map(actions.map((a) => [a.key, a]))
        onChange(keys.map((k) => byKey.get(k)!).filter(Boolean))
      }, 0),
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{t('editor.actions')}</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {t('editor.actionsCount', { n: actions.length, max: MAX_ACTIONS })}
        </span>
      </div>
      {actions.length === 0 ? (
        <p
          data-testid={`${P}-actions-empty`}
          className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground"
        >
          {t('editor.noActions')}
        </p>
      ) : (
        <DragDropProvider sensors={SENSORS} onDragEnd={onDragEnd}>
          <ol data-testid={`${P}-actions`} className="flex flex-col gap-2">
            {actions.map((a, i) => (
              <ActionRow
                key={a.key}
                action={a}
                index={i}
                count={actions.length}
                invalidField={invalid?.index === i ? invalid.field : null}
                onPatch={(config, extra) => patch(i, config, extra)}
                onMove={(to) => onChange(moveItem(actions, i, to))}
                onRemove={() => onChange(actions.filter((_, j) => j !== i))}
              />
            ))}
          </ol>
        </DragDropProvider>
      )}
      <div className="flex flex-wrap gap-2">
        {QR_ACTION_TYPES.map((type) => (
          <Button
            key={type}
            variant="outline"
            size="sm"
            data-testid={`${P}-add-${type}`}
            disabled={actions.length >= MAX_ACTIONS}
            onClick={() => add(type)}
          >
            {ICONS[type]} {t(`types.${type}`)}
          </Button>
        ))}
      </div>
    </div>
  )
}

function ActionRow({
  action,
  index,
  count,
  invalidField,
  onPatch,
  onMove,
  onRemove,
}: {
  action: DraftAction
  index: number
  count: number
  invalidField: string | null
  onPatch: (config: Record<string, unknown>, extra?: Partial<DraftAction>) => void
  onMove: (to: number) => void
  onRemove: () => void
}) {
  const t = useT(NS)
  const { ref, handleRef, isDragging } = useSortable({ id: action.key, index })
  const c = action.config
  const str = (k: string) => (typeof c[k] === 'string' ? (c[k] as string) : '')
  const bad = (f: string) => (invalidField === f ? 'border-destructive' : '')

  return (
    <li
      ref={ref}
      data-testid={`${P}-action-${index}`}
      data-type={action.type}
      className={cn(
        'flex min-w-0 gap-2 rounded-lg border bg-card p-2',
        isDragging && 'opacity-60 ring-2 ring-primary/40',
      )}
    >
      <div className="flex flex-col items-center gap-1">
        <button
          ref={handleRef}
          type="button"
          data-testid={`${P}-action-handle-${index}`}
          aria-label={t('editor.drag')}
          className="flex size-7 cursor-grab touch-none items-center justify-center rounded text-muted-foreground hover:bg-accent"
        >
          <GripVertical className="size-4" aria-hidden />
        </button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          data-testid={`${P}-action-up-${index}`}
          aria-label={t('editor.up')}
          disabled={index === 0}
          onClick={() => onMove(index - 1)}
        >
          <ArrowUp aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          data-testid={`${P}-action-down-${index}`}
          aria-label={t('editor.down')}
          disabled={index === count - 1}
          onClick={() => onMove(index + 1)}
        >
          <ArrowDown aria-hidden />
        </Button>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-center gap-2 text-sm font-medium [&_svg]:size-4 [&_svg]:text-muted-foreground">
          {ICONS[action.type]}
          <span className="flex-1">
            {index + 1}. {t(`types.${action.type}`)}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-destructive"
            data-testid={`${P}-action-remove-${index}`}
            aria-label={t('editor.remove')}
            onClick={onRemove}
          >
            <Trash2 aria-hidden />
          </Button>
        </div>
        {action.type === 'send_message' ? (
          <textarea
            data-testid={`${P}-action-text-${index}`}
            aria-label={t('editor.messageText')}
            placeholder={t('editor.messagePlaceholder')}
            value={str('message_text')}
            onChange={(e) => onPatch({ message_text: e.target.value })}
            className={cn(textareaClass, bad('message_text'))}
          />
        ) : action.type === 'send_multi_media' ? (
          <MediaFields index={index} action={action} invalid={invalidField === 'media_id'} onPatch={onPatch} />
        ) : action.type === 'send_sticker' ? (
          <StickerPicker
            index={index}
            value={str('sticker_id')}
            invalid={invalidField === 'sticker_id'}
            onPick={(id) => onPatch({ sticker_id: id })}
          />
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            <input
              data-testid={`${P}-action-contact-name-${index}`}
              aria-label={t('editor.contactName')}
              placeholder={t('editor.contactName')}
              value={str('contact_name')}
              onChange={(e) => onPatch({ contact_name: e.target.value })}
              className={cn(inputClass, bad('contact_name'))}
            />
            <input
              data-testid={`${P}-action-contact-phone-${index}`}
              aria-label={t('editor.contactPhone')}
              placeholder="+5511999999999"
              inputMode="tel"
              value={str('contact_phone')}
              onChange={(e) => onPatch({ contact_phone: e.target.value })}
              className={cn(inputClass, bad('contact_phone'))}
            />
          </div>
        )}
      </div>
    </li>
  )
}

function MediaFields({
  index,
  action,
  invalid,
  onPatch,
}: {
  index: number
  action: DraftAction
  invalid: boolean
  onPatch: (config: Record<string, unknown>, extra?: Partial<DraftAction>) => void
}) {
  const t = useT(NS)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const c = action.config
  const mediaId = typeof c.media_id === 'string' ? c.media_id : ''
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <select
          data-testid={`${P}-action-media-type-${index}`}
          aria-label={t('editor.mediaType')}
          value={typeof c.media_type === 'string' ? c.media_type : 'image'}
          onChange={(e) => onPatch({ media_type: e.target.value })}
          className={cn(inputClass, 'w-auto')}
        >
          {QR_MEDIA_TYPES.map((m) => (
            <option key={m} value={m}>
              {t(`media.${m}`)}
            </option>
          ))}
        </select>
        <label
          className={cn(
            'inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm hover:bg-accent',
            invalid && 'border-destructive',
          )}
        >
          {uploading ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <FileUp className="size-4" aria-hidden />
          )}
          {mediaId ? t('editor.replaceFile') : t('editor.chooseFile')}
          <input
            data-testid={`${P}-action-file-${index}`}
            type="file"
            className="sr-only"
            disabled={uploading}
            onChange={async (e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (!file) return
              setUploading(true)
              setError(null)
              try {
                const media = await quickRepliesApi.upload(file)
                onPatch(
                  { media_id: media.id, media_type: mediaTypeOf(media.mime || file.type) },
                  { fileName: file.name },
                )
              } catch (err) {
                setError(serverMessage(err) ?? t('common.error'))
              } finally {
                setUploading(false)
              }
            }}
          />
        </label>
        <span data-testid={`${P}-action-file-name-${index}`} className="min-w-0 truncate text-xs text-muted-foreground">
          {action.fileName ?? (mediaId ? t('editor.fileAttached') : t('editor.noFile'))}
        </span>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <input
        data-testid={`${P}-action-caption-${index}`}
        aria-label={t('editor.caption')}
        placeholder={t('editor.caption')}
        value={typeof c.caption === 'string' ? c.caption : ''}
        onChange={(e) => onPatch({ caption: e.target.value })}
        className={inputClass}
      />
    </div>
  )
}

function StickerPicker({
  index,
  value,
  invalid,
  onPick,
}: {
  index: number
  value: string
  invalid: boolean
  onPick: (id: string) => void
}) {
  const t = useT(NS)
  const q = useQuery(stickersQuery())
  if (q.isPending) return <p className="text-xs text-muted-foreground">{t('common.loading')}</p>
  const items = q.data ?? []
  if (items.length === 0) return <p className="text-xs text-muted-foreground">{t('editor.noStickers')}</p>
  return (
    <div
      data-testid={`${P}-action-stickers-${index}`}
      role="radiogroup"
      aria-label={t('types.send_sticker')}
      className={cn('flex flex-wrap gap-2 rounded-md p-1', invalid && 'ring-1 ring-destructive')}
    >
      {items.map((s) => (
        <button
          key={s.id}
          type="button"
          role="radio"
          aria-checked={s.id === value}
          aria-label={s.name}
          data-testid={`${P}-action-sticker-${index}-${s.id}`}
          onClick={() => onPick(s.id)}
          className={cn(
            'size-14 rounded-md border p-1',
            s.id === value ? 'border-primary ring-2 ring-primary/40' : 'hover:bg-accent',
          )}
        >
          <img src={apiUrl(s.url)} alt="" className="size-full object-contain" />
        </button>
      ))}
    </div>
  )
}
