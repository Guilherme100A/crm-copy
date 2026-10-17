// Editor do nó Mensagem (AC-T56-01/02; 06 §3.6): adiciona, reordena (alça com @dnd-kit/react 0.5.1 ou subir/descer)
// e remove ações de texto, mídia, arquivo, figurinha, contato e atraso. Mídia vai pelo `POST /api/media` e fica na
// config como `blob:<sha256>` (o wa-worker resolve); o `media_id` acompanha só para a prévia.
import { move } from '@dnd-kit/helpers'
import { DragDropProvider, KeyboardSensor, PointerSensor, type DragDropManager, type DragEndEvent } from '@dnd-kit/react'
import { useSortable } from '@dnd-kit/react/sortable'
import { MAX_MESSAGE_DELAY_SECONDS, type FlowAction } from '@crm/shared/flows'
import { ArrowDown, ArrowUp, Clock, File, GripVertical, Image, MessageSquare, Smile, Trash2, UserRound } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import { cn } from '@/lib/utils'
import type { NodeEditorProps } from '../registry'
import { Check, DraftStatus, Field, inputClass, MediaInput, NS, num, NumberInput, Select, StickerLibrary, str, useActionsDraft, VarText } from './kit'
import { defaultConfig, MESSAGE_ACTION_TYPES, mediaTypeOf, moveItem, newAction, optional, setField, type FieldErrors, type MultiMediaType } from './rules'

type Config = Record<string, unknown>

const ICONS: Record<string, ReactNode> = {
  send_message: <MessageSquare aria-hidden />,
  send_multi_media: <Image aria-hidden />,
  send_file: <File aria-hidden />,
  send_sticker: <Smile aria-hidden />,
  send_contact: <UserRound aria-hidden />,
  delay_between_messages: <Clock aria-hidden />,
}

const SENSORS = [PointerSensor, KeyboardSensor]
const MEDIA_TYPES: readonly MultiMediaType[] = ['image', 'video', 'audio']
const ACCEPT: Record<MultiMediaType, string> = { image: 'image/*', video: 'video/*', audio: 'audio/*' }

export function MessageEditor({ nodeId, actions, readOnly, onChange }: NodeEditorProps) {
  const t = useT(NS)
  const { draft, errors, blocked, update, patchConfig } = useActionsDraft({ nodeId, actions, readOnly, onChange })

  const onDragEnd = (event: DragEndEvent, manager: DragDropManager) => {
    if (event.canceled) return
    const ids = move(
      draft.map((a) => a.id),
      event,
    )
    // Como no editor de respostas rápidas (T58): a troca só entra depois da renderização do dragend.
    void manager.renderer.rendering.then(() =>
      setTimeout(() => {
        const byId = new Map(draft.map((a) => [a.id, a]))
        update(ids.map((id) => byId.get(id)!).filter(Boolean))
      }, 0),
    )
  }

  const rows = draft.map((a, i) => (
    <ActionRow
      key={a.id}
      action={a}
      index={i}
      count={draft.length}
      readOnly={readOnly}
      errors={errors[a.id]}
      onPatch={(fn) => patchConfig(a.id, fn)}
      onMove={(to) => update(moveItem(draft, i, to))}
      onRemove={() => update(draft.filter((x) => x.id !== a.id))}
    />
  ))

  return (
    <div data-testid="ne-message" className="flex flex-col gap-2">
      <p className="text-xs font-medium">{t('message.actions', { n: draft.length })}</p>
      {draft.length === 0 ? (
        <p data-testid="ne-msg-empty" className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
          {t('message.empty')}
        </p>
      ) : readOnly ? (
        <ol data-testid="ne-msg-actions" className="flex flex-col gap-2">
          {rows}
        </ol>
      ) : (
        <DragDropProvider sensors={SENSORS} onDragEnd={onDragEnd}>
          <ol data-testid="ne-msg-actions" className="flex flex-col gap-2">
            {rows}
          </ol>
        </DragDropProvider>
      )}
      {readOnly ? null : (
        <div className="flex flex-wrap gap-1">
          {MESSAGE_ACTION_TYPES.map((type) => (
            <Button key={type} variant="outline" size="sm" className="h-7 px-2 text-xs" data-testid={`ne-msg-add-${type}`} onClick={() => update([...draft, newAction(type, defaultConfig(type))])}>
              {ICONS[type]} {t(`actions.${type}`)}
            </Button>
          ))}
        </div>
      )}
      <DraftStatus blocked={blocked} />
    </div>
  )
}

interface RowProps {
  action: FlowAction
  index: number
  count: number
  readOnly: boolean
  errors: FieldErrors | undefined
  onPatch: (fn: (c: Config) => Config) => void
  onMove: (to: number) => void
  onRemove: () => void
}

/** No modo leitura a linha não entra no dnd (lição da T44: item desabilitado vira `aria-disabled`). */
function ActionRow(props: RowProps) {
  return props.readOnly ? <RowBody {...props} /> : <SortableRow {...props} />
}

function SortableRow(props: RowProps) {
  const { ref, handleRef, isDragging } = useSortable({ id: props.action.id, index: props.index })
  return <RowBody {...props} rowRef={ref} handleRef={handleRef} dragging={isDragging} />
}

function RowBody({
  action,
  index,
  count,
  readOnly,
  errors,
  onPatch,
  onMove,
  onRemove,
  rowRef,
  handleRef,
  dragging,
}: RowProps & { rowRef?: (el: Element | null) => void; handleRef?: (el: Element | null) => void; dragging?: boolean }) {
  const t = useT(NS)
  const invalid = !!errors && Object.keys(errors).length > 0
  return (
    <li
      ref={rowRef}
      data-testid={`ne-action-${index}`}
      data-type={action.type}
      data-action-id={action.id}
      data-invalid={invalid || undefined}
      className={cn('flex min-w-0 gap-1.5 rounded-lg border bg-card p-2', invalid && 'border-destructive/60', dragging && 'opacity-60 ring-2 ring-primary/40')}
    >
      {readOnly ? null : (
        <div className="flex flex-col items-center gap-0.5">
          <button
            ref={handleRef}
            type="button"
            data-testid={`ne-action-handle-${index}`}
            aria-label={t('message.drag')}
            className="flex size-6 cursor-grab touch-none items-center justify-center rounded text-muted-foreground hover:bg-accent"
          >
            <GripVertical className="size-3.5" aria-hidden />
          </button>
          <Button variant="ghost" size="icon" className="size-6" data-testid={`ne-action-up-${index}`} aria-label={t('message.up')} disabled={index === 0} onClick={() => onMove(index - 1)}>
            <ArrowUp aria-hidden />
          </Button>
          <Button variant="ghost" size="icon" className="size-6" data-testid={`ne-action-down-${index}`} aria-label={t('message.down')} disabled={index === count - 1} onClick={() => onMove(index + 1)}>
            <ArrowDown aria-hidden />
          </Button>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-center gap-1.5 text-xs font-medium [&_svg]:size-3.5 [&_svg]:text-muted-foreground">
          {ICONS[action.type]}
          <span className="flex-1">
            {index + 1}. {t(`actions.${action.type}`)}
          </span>
          {readOnly ? null : (
            <Button variant="ghost" size="icon" className="size-6 text-destructive" data-testid={`ne-action-remove-${index}`} aria-label={t('message.remove')} onClick={onRemove}>
              <Trash2 aria-hidden />
            </Button>
          )}
        </div>
        <ActionFields action={action} index={index} readOnly={readOnly} errors={errors} onPatch={onPatch} />
      </div>
    </li>
  )
}

function ActionFields({ action, index, readOnly, errors, onPatch }: Pick<RowProps, 'action' | 'index' | 'readOnly' | 'errors' | 'onPatch'>) {
  const t = useT(NS)
  const c = action.config
  const set = (key: string, value: unknown) => onPatch((cfg) => setField(cfg, key, value))
  const tid = (part: string) => `ne-action-${part}-${index}`

  switch (action.type) {
    case 'send_message':
      return (
        <>
          <VarText label={t('message.text')} path="message_text" errors={errors} multiline testId={tid('text')} value={str(c, 'message_text')} disabled={readOnly} placeholder={t('message.textPlaceholder')} onChange={(v) => set('message_text', v)} />
          <TypingDelay c={c} errors={errors} readOnly={readOnly} testId={tid('typing')} onChange={(v) => set('typing_delay_seconds', v)} />
        </>
      )
    case 'send_multi_media': {
      const type = (str(c, 'media_type') || 'image') as MultiMediaType
      const items = Array.isArray(c.messages) ? (c.messages as Config[]) : []
      const first = items[0] ?? {}
      const setFirst = (key: string, value: unknown) => onPatch((cfg) => setField(cfg, 'messages', [setField(first, key, value), ...items.slice(1)]))
      return (
        <>
          <Field label={t('media.type')} path="media_type" errors={errors}>
            {({ id }) => <Select id={id} testId={tid('media-type')} value={type} options={MEDIA_TYPES} label={(m) => t(`media.types.${m}`)} disabled={readOnly} onChange={(m) => set('media_type', m)} />}
          </Field>
          <MediaSourceField
            c={c}
            urlKey="media_url"
            errors={errors}
            tid={tid}
            readOnly={readOnly}
            accept={ACCEPT[type]}
            showPreview={type === 'image'}
            onPatch={onPatch}
            onUploadedExtra={(cfg, mime) => setField(cfg, 'media_type', mediaTypeOf(mime) ?? cfg.media_type)}
          />
          {type === 'audio' ? (
            <Check label={t('media.ptt')} testId={tid('ptt')} checked={c.audio_forward !== false} disabled={readOnly} onChange={(v) => set('audio_forward', v)} />
          ) : (
            <>
              <VarText label={t('media.caption')} path="messages.0.caption" errors={errors} testId={tid('caption')} value={str(first, 'caption')} disabled={readOnly} onChange={(v) => setFirst('caption', optional(v))} />
              <Check label={t('media.viewOnce')} testId={tid('view-once')} checked={first.view_once === true} disabled={readOnly} onChange={(v) => setFirst('view_once', v || undefined)} />
            </>
          )}
          <TypingDelay c={c} errors={errors} readOnly={readOnly} testId={tid('typing')} onChange={(v) => set('typing_delay_seconds', v)} />
        </>
      )
    }
    case 'send_file':
      return (
        <>
          <MediaSourceField c={c} urlKey="file_url" errors={errors} tid={tid} readOnly={readOnly} onPatch={onPatch} onUploadedExtra={(cfg, _mime, name) => setField(cfg, 'file_name', name)} />
          <Field label={t('file.name')} path="file_name" errors={errors} hint={t('file.hint')}>
            {({ id, invalid }) => <input id={id} data-testid={tid('file-name')} className={inputClass} aria-invalid={invalid} value={str(c, 'file_name')} disabled={readOnly} onChange={(e) => set('file_name', e.target.value)} />}
          </Field>
        </>
      )
    case 'send_sticker':
      return (
        <>
          {readOnly ? null : (
            <StickerLibrary
              testId={tid}
              disabled={readOnly}
              onPicked={(media, ref, name) =>
                onPatch((cfg) => ({ ...cfg, media_source: 'file', sticker_url: ref, media_id: media.id, sticker_name: str(cfg, 'sticker_name').trim() ? cfg.sticker_name : name }))
              }
            />
          )}
          <MediaSourceField
            c={c}
            urlKey="sticker_url"
            errors={errors}
            tid={tid}
            readOnly={readOnly}
            accept="image/png,image/jpeg,image/webp"
            showPreview
            onPatch={onPatch}
            onUploadedExtra={(cfg, _mime, name) => (str(cfg, 'sticker_name').trim() ? cfg : setField(cfg, 'sticker_name', name))}
          />
          <Field label={t('sticker.name')} path="sticker_name" errors={errors}>
            {({ id, invalid }) => <input id={id} data-testid={tid('sticker-name')} className={inputClass} aria-invalid={invalid} value={str(c, 'sticker_name')} disabled={readOnly} onChange={(e) => set('sticker_name', e.target.value)} />}
          </Field>
        </>
      )
    case 'send_contact':
      return (
        <div className="grid gap-2">
          <VarText label={t('contact.name')} path="contact_name" errors={errors} testId={tid('contact-name')} value={str(c, 'contact_name')} disabled={readOnly} onChange={(v) => set('contact_name', v)} />
          <VarText label={t('contact.phone')} path="contact_phone" errors={errors} testId={tid('contact-phone')} value={str(c, 'contact_phone')} disabled={readOnly} placeholder="+5511999999999" onChange={(v) => set('contact_phone', v)} />
        </div>
      )
    case 'delay_between_messages': {
      const random = c.delay_seconds === undefined && (c.delay_min_seconds !== undefined || c.delay_max_seconds !== undefined)
      return (
        <>
          <Field label={t('delay.mode')} path="delay_mode" hint={t('delay.hint', { max: MAX_MESSAGE_DELAY_SECONDS })}>
            {({ id }) => (
              <Select
                id={id}
                testId={tid('delay-mode')}
                value={random ? 'random' : 'fixed'}
                options={['fixed', 'random'] as const}
                label={(m) => t(`delay.modes.${m}`)}
                disabled={readOnly}
                onChange={(m) => onPatch(() => (m === 'random' ? { delay_min_seconds: 2, delay_max_seconds: 8 } : { delay_seconds: 3 }))}
              />
            )}
          </Field>
          {random ? (
            <div className="grid grid-cols-2 gap-2">
              <Field label={t('delay.min')} path="delay_min_seconds" errors={errors}>
                {({ id, invalid }) => <NumberInput id={id} testId={tid('delay-min')} min={0} max={MAX_MESSAGE_DELAY_SECONDS} value={num(c, 'delay_min_seconds')} invalid={invalid} disabled={readOnly} onChange={(v) => set('delay_min_seconds', v)} />}
              </Field>
              <Field label={t('delay.max')} path="delay_max_seconds" errors={errors}>
                {({ id, invalid }) => <NumberInput id={id} testId={tid('delay-max')} min={0} max={MAX_MESSAGE_DELAY_SECONDS} value={num(c, 'delay_max_seconds')} invalid={invalid} disabled={readOnly} onChange={(v) => set('delay_max_seconds', v)} />}
              </Field>
            </div>
          ) : (
            <Field label={t('delay.seconds')} path="delay_seconds" errors={errors}>
              {({ id, invalid }) => <NumberInput id={id} testId={tid('delay')} min={0} max={MAX_MESSAGE_DELAY_SECONDS} value={num(c, 'delay_seconds')} invalid={invalid} disabled={readOnly} onChange={(v) => set('delay_seconds', v)} />}
            </Field>
          )}
        </>
      )
    }
    default:
      return <p className="font-mono text-[11px] text-muted-foreground">{action.type}</p>
  }
}

function TypingDelay({ c, errors, readOnly, testId, onChange }: { c: Config; errors: FieldErrors | undefined; readOnly: boolean; testId: string; onChange: (v: number | undefined) => void }) {
  const t = useT(NS)
  return (
    <Field label={t('message.typing')} path="typing_delay_seconds" errors={errors}>
      {({ id, invalid }) => <NumberInput id={id} testId={testId} min={0} value={num(c, 'typing_delay_seconds')} invalid={invalid} disabled={readOnly} onChange={onChange} />}
    </Field>
  )
}

/** Origem da mídia (arquivo enviado ou URL) gravada em `urlKey`; erro do campo no mesmo caminho. */
function MediaSourceField({
  c,
  urlKey,
  errors,
  tid,
  readOnly,
  accept,
  showPreview,
  onPatch,
  onUploadedExtra,
}: {
  c: Config
  urlKey: string
  errors: FieldErrors | undefined
  tid: (part: string) => string
  readOnly: boolean
  accept?: string
  showPreview?: boolean
  onPatch: (fn: (c: Config) => Config) => void
  onUploadedExtra?: (cfg: Config, mime: string, name: string) => Config
}) {
  const t = useT(NS)
  const source = c.media_source === 'url' ? 'url' : 'file'
  return (
    <Field label={t('media.label')} path={urlKey} errors={errors}>
      {({ invalid }) => (
        <MediaInput
          testId={tid}
          source={source}
          url={str(c, urlKey)}
          mediaId={str(c, 'media_id') || undefined}
          fileName={str(c, 'file_label') || undefined}
          accept={accept}
          showPreview={showPreview}
          invalid={invalid}
          disabled={readOnly}
          onSource={(s) =>
            onPatch((cfg) => {
              if (cfg.media_source === s) return cfg
              const next: Config = { ...cfg, media_source: s }
              delete next[urlKey]
              delete next.media_id
              delete next.file_label
              return next
            })
          }
          onUrl={(url) => onPatch((cfg) => setField(cfg, urlKey, optional(url)))}
          onUploaded={(media, ref, file) =>
            onPatch((cfg) => {
              const next = { ...cfg, media_source: 'file', [urlKey]: ref, media_id: media.id, file_label: media.file_name ?? file.name }
              return onUploadedExtra ? onUploadedExtra(next, media.mime || file.type, media.file_name ?? file.name) : next
            })
          }
        />
      )}
    </Field>
  )
}
