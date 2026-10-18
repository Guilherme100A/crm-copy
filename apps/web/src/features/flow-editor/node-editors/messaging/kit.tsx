// Peças comuns dos editores de nó da T56 (mensagem e interativos): rascunho que só salva quando o schema do T10
// aceita (AC-T56-02), campo com erro inline (`ne-error-<caminho>`), seletor de variável (`ne-var-picker`), mídia por
// upload (`/api/media` → `blob:<sha256>`) ou URL, prazo até 31 dias e a prévia em formato de chat (`ne-preview`).
import type { FlowAction } from '@crm/shared/flows'
import { TIME_UNITS } from '@crm/shared/flows'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Braces, CheckCircle2, FileUp, Image as ImageIcon, Loader2, Smile } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { useT } from '@/i18n'
import { HttpError } from '@/lib/http'
import { cn } from '@/lib/utils'
import { customFieldsQuery, globalVariablesQuery, nodeEditorsApi, stickersQuery, type UploadedMedia } from './api'
import {
  blobRef,
  AD_VARIABLES, CONTACT_VARIABLES,
  hasErrors,
  insertVariable,
  intOf,
  previewUrl,
  SYSTEM_VARIABLES,
  validateActions,
  variableGroups,
  withOrder,
  type FieldError,
  type FieldErrors,
} from './rules'
import { apiUrl } from '@/lib/base'

export const NS = 'node-editors-messaging'

export const inputClass =
  'h-8 w-full min-w-0 rounded-md border bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70 aria-[invalid=true]:border-destructive'
export const textareaClass =
  'min-h-20 w-full min-w-0 rounded-md border bg-background px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70 aria-[invalid=true]:border-destructive'

type Config = Record<string, unknown>

export const str = (c: Config, k: string) => (typeof c[k] === 'string' ? (c[k] as string) : '')
export const num = (c: Config, k: string) => (typeof c[k] === 'number' ? String(c[k]) : '')

// ---------------------------------------------------------------- rascunho com bloqueio

/**
 * Rascunho local das ações do nó. Cada mudança valida as configs pelo schema do T10; só um rascunho SEM erros vai
 * para `onChange` (que dispara o autosave do canvas). Com erro, o nó salvo continua o último válido e o editor mostra
 * os erros no campo e o estado `ne-status=blocked`. `normalize` completa a ação principal de um nó novo.
 */
export function useActionsDraft({
  nodeId,
  actions,
  readOnly,
  onChange,
  normalize,
}: {
  nodeId: string
  actions: FlowAction[]
  readOnly: boolean
  onChange: (actions: FlowAction[]) => void
  normalize?: (actions: FlowAction[]) => FlowAction[]
}) {
  const prepare = useCallback((list: FlowAction[]) => withOrder(normalize ? normalize(list) : list), [normalize])
  const initial = useRef<FlowAction[] | null>(null)
  initial.current ??= prepare(actions)
  const [draft, setDraft] = useState<FlowAction[]>(initial.current)
  const emitted = useRef(actions)
  const node = useRef(nodeId)
  const mounted = useRef(false)

  const emit = useCallback(
    (next: FlowAction[]) => {
      if (readOnly || hasErrors(validateActions(next))) return
      emitted.current = next
      onChange(next)
    },
    [onChange, readOnly],
  )

  // Montagem, outro nó selecionado ou ações trocadas por fora (desfazer, realtime, a outra instância do painel no
  // mobile): o rascunho volta a ser o nó. Se `normalize` completou o nó (ação principal padrão) e o resultado já é
  // válido (ex.: Aguardar resposta), grava sem esperar uma edição.
  useEffect(() => {
    const changed = actions !== emitted.current || nodeId !== node.current
    if (mounted.current && !changed) return
    emitted.current = actions
    node.current = nodeId
    const prepared = mounted.current ? prepare(actions) : initial.current!
    mounted.current = true
    if (changed) setDraft(prepared)
    if (JSON.stringify(prepared) !== JSON.stringify(actions)) emit(prepared)
  }, [actions, nodeId, prepare, emit])

  const errors = useMemo(() => validateActions(draft), [draft])
  const blocked = hasErrors(errors)

  const update = useCallback(
    (next: FlowAction[]) => {
      const ordered = withOrder(next)
      setDraft(ordered)
      emit(ordered)
    },
    [emit],
  )

  /** Troca a config de uma ação (por id). */
  const patchConfig = useCallback(
    (id: string, fn: (c: Config) => Config) => update(draft.map((a) => (a.id === id ? { ...a, config: fn(a.config) } : a))),
    [draft, update],
  )

  return { draft, errors, blocked, update, patchConfig }
}

/** Estado do salvamento do editor: `saved` (rascunho = nó) ou `blocked` (erros impedem salvar). */
export function DraftStatus({ blocked }: { blocked: boolean }) {
  const t = useT(NS)
  return (
    <p
      data-testid="ne-status"
      data-state={blocked ? 'blocked' : 'saved'}
      role={blocked ? 'alert' : 'status'}
      className={cn('flex items-center gap-1.5 rounded-md px-2 py-1 text-xs', blocked ? 'bg-destructive/10 text-destructive' : 'text-muted-foreground')}
    >
      {blocked ? <AlertTriangle className="size-3.5" aria-hidden /> : <CheckCircle2 className="size-3.5" aria-hidden />}
      {blocked ? t('status.blocked') : t('status.saved')}
    </p>
  )
}

// ---------------------------------------------------------------- campos

export function useErrorText() {
  const t = useT(NS)
  return (e: FieldError) => t(`errors.${e.key}`, e.vars)
}

export function ErrorText({ path, error }: { path: string; error?: FieldError | undefined }) {
  const text = useErrorText()
  if (!error) return null
  return (
    <p data-testid={`ne-error-${path}`} role="alert" className="text-[11px] text-destructive">
      {text(error)}
    </p>
  )
}

/** Rótulo + controle + erro do caminho `path` (o controle recebe `id` e `aria-invalid`). */
export function Field({
  label,
  path,
  errors,
  hint,
  children,
}: {
  label: string
  path: string
  errors?: FieldErrors | undefined
  hint?: string
  children: (p: { id: string; invalid: boolean }) => ReactNode
}) {
  const id = useId()
  const error = errors?.[path]
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium">
        {label}
      </label>
      {children({ id, invalid: !!error })}
      {hint && !error ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
      <ErrorText path={path} error={error} />
    </div>
  )
}

export function Select<T extends string>({
  id,
  value,
  options,
  label,
  onChange,
  disabled,
  testId,
}: {
  id?: string
  value: T
  options: readonly T[]
  label: (v: T) => string
  onChange: (v: T) => void
  disabled?: boolean
  testId?: string
}) {
  return (
    <select id={id} data-testid={testId} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)} className={cn(inputClass, 'pr-1')}>
      {options.map((o) => (
        <option key={o} value={o}>
          {label(o)}
        </option>
      ))}
    </select>
  )
}

export function Check({ label, checked, onChange, disabled, testId }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; testId?: string }) {
  return (
    <label className="flex items-center gap-2 text-xs">
      <input type="checkbox" data-testid={testId} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="size-4" />
      {label}
    </label>
  )
}

/** Aviso do clone (Baileys): menus e carrossel saem como texto numerado. */
export function Notice({ testId, children, tone = 'info' }: { testId: string; children: ReactNode; tone?: 'info' | 'warn' }) {
  return (
    <p
      data-testid={testId}
      role="note"
      className={cn('rounded-md border px-2 py-1.5 text-[11px] leading-snug', tone === 'warn' ? 'border-amber-500/40 bg-amber-500/10' : 'border-sky-500/40 bg-sky-500/10')}
    >
      {children}
    </p>
  )
}

// ---------------------------------------------------------------- variáveis

function useVariableGroups() {
  const t = useT(NS)
  const globals = useQuery(globalVariablesQuery()).data ?? []
  const fields = useQuery(customFieldsQuery()).data ?? []
  return variableGroups([
    { id: 'contact', label: t('vars.contact'), names: [...CONTACT_VARIABLES] as string[] },
    { id: 'ad', label: t('vars.ad'), names: [...AD_VARIABLES] as string[] },
    { id: 'system', label: t('vars.system'), names: [...SYSTEM_VARIABLES] as string[] },
    { id: 'fields', label: t('vars.fields'), names: fields },
    { id: 'globals', label: t('vars.globals'), names: globals },
  ])
}

/** Botão `ne-var-picker` com a lista `ne-var-<nome>`; insere `{nome}` no cursor do campo. */
function VariablePicker({ onPick, disabled }: { onPick: (name: string) => void; disabled?: boolean }) {
  const t = useT(NS)
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const groups = useVariableGroups()
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        data-testid="ne-var-picker"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
        className="flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-muted-foreground hover:bg-accent disabled:opacity-50"
      >
        <Braces className="size-3.5" aria-hidden /> {t('vars.insert')}
      </button>
      {open ? (
        <div
          data-testid="ne-var-list"
          role="listbox"
          aria-label={t('vars.insert')}
          onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
          className="absolute right-0 z-50 mt-1 max-h-64 w-56 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          {groups.map((g) => (
            <div key={g.id} className="py-0.5">
              <p className="px-2 py-0.5 text-[10px] font-semibold text-muted-foreground uppercase">{g.label}</p>
              {g.names.map((name) => (
                <button
                  key={`${g.id}-${name}`}
                  type="button"
                  role="option"
                  aria-selected={false}
                  data-testid={`ne-var-${name}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onPick(name)
                    setOpen(false)
                  }}
                  className="block w-full truncate rounded px-2 py-1 text-left font-mono text-xs hover:bg-accent"
                >
                  {`{${name}}`}
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** Texto (input ou textarea) com seletor de variável que insere no cursor. */
export function VarText({
  label,
  path,
  errors,
  value,
  onChange,
  disabled,
  multiline,
  placeholder,
  testId,
  hint,
  maxLength,
}: {
  label: string
  path: string
  errors?: FieldErrors | undefined
  value: string
  onChange: (v: string) => void
  disabled?: boolean
  multiline?: boolean
  placeholder?: string
  testId: string
  hint?: string
  maxLength?: number
}) {
  const id = useId()
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null)
  const error = errors?.[path]
  const pick = (name: string) => {
    const el = ref.current
    const r = insertVariable(value, name, el?.selectionStart ?? value.length, el?.selectionEnd ?? value.length)
    onChange(r.value)
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(r.caret, r.caret)
    })
  }
  const common = {
    id,
    ref,
    'data-testid': testId,
    value,
    disabled,
    placeholder,
    maxLength,
    'aria-invalid': !!error,
    onChange: (e: { target: { value: string } }) => onChange(e.target.value),
  }
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-xs font-medium">
          {label}
        </label>
        <VariablePicker onPick={pick} disabled={disabled} />
      </div>
      {multiline ? <textarea {...common} className={textareaClass} /> : <input {...common} className={inputClass} />}
      {hint && !error ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
      <ErrorText path={path} error={error} />
    </div>
  )
}

export function NumberInput({
  id,
  value,
  onChange,
  disabled,
  invalid,
  testId,
  min,
  max,
}: {
  id?: string
  value: string
  onChange: (v: number | undefined) => void
  disabled?: boolean
  invalid?: boolean
  testId?: string
  min?: number
  max?: number
}) {
  return (
    <input
      id={id}
      type="number"
      inputMode="numeric"
      data-testid={testId}
      value={value}
      min={min}
      max={max}
      disabled={disabled}
      aria-invalid={invalid}
      onChange={(e) => onChange(intOf(e.target.value))}
      className={inputClass}
    />
  )
}

// ---------------------------------------------------------------- prazo

/** Prazo `valor + unidade` (até 31 dias; o schema valida). `ne-timeout-value` / `ne-timeout-unit`. */
export function TimeoutFields({
  value,
  unit,
  errors,
  paths = ['timeout_value', 'timeout_unit'],
  min = 0,
  onChange,
  disabled,
  hint,
}: {
  value: string
  unit: string
  errors?: FieldErrors | undefined
  /** Caminhos onde o schema põe o erro do prazo (o primeiro com erro é mostrado). */
  paths?: string[]
  min?: number
  onChange: (value: number | undefined, unit: string) => void
  disabled?: boolean
  hint?: string
}) {
  const t = useT(NS)
  const id = useId()
  const path = paths.find((p) => errors?.[p]) ?? paths[0]!
  const error = errors?.[path]
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium">
        {t('timeout.label')}
      </label>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
        <NumberInput id={id} testId="ne-timeout-value" value={value} min={min} invalid={!!error} disabled={disabled} onChange={(v) => onChange(v, unit)} />
        <Select testId="ne-timeout-unit" value={(unit || 'days') as (typeof TIME_UNITS)[number]} options={TIME_UNITS} label={(u) => t(`timeout.units.${u}`)} disabled={disabled} onChange={(u) => onChange(intOf(value), u)} />
      </div>
      {hint && !error ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
      <ErrorText path={path} error={error} />
    </div>
  )
}

// ---------------------------------------------------------------- mídia

export function uploadErrorText(err: unknown, fallback: string): string {
  if (err instanceof HttpError) {
    if (err.status === 413) return `${fallback} (413)`
    return err.message || fallback
  }
  return fallback
}

/**
 * Mídia por arquivo (upload → `onUploaded` com a referência `blob:<sha256>`) ou por URL digitada.
 * Testids por `testId(parte)`: `source-file|source-url`, `file` (input file), `url`, `name`, `upload-error`.
 */
export function MediaInput({
  testId,
  source,
  url,
  mediaId,
  fileName,
  accept,
  showPreview,
  invalid,
  disabled,
  onSource,
  onUrl,
  onUploaded,
}: {
  testId: (part: string) => string
  source: 'file' | 'url'
  url: string
  mediaId?: string
  fileName?: string
  accept?: string
  showPreview?: boolean
  invalid?: boolean
  disabled?: boolean
  onSource: (s: 'file' | 'url') => void
  onUrl: (url: string) => void
  onUploaded: (media: UploadedMedia, ref: string, file: File) => void
}) {
  const t = useT(NS)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const thumb = showPreview ? previewUrl(url, mediaId) : null
  const attached = source === 'file' && !!url
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1">
        {(['file', 'url'] as const).map((s) => (
          <button
            key={s}
            type="button"
            data-testid={testId(`source-${s}`)}
            aria-pressed={source === s}
            disabled={disabled}
            onClick={() => onSource(s)}
            className={cn('h-6 rounded border px-2 text-[11px]', source === s ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent')}
          >
            {t(`media.source.${s}`)}
          </button>
        ))}
      </div>
      {source === 'file' ? (
        <div className="flex min-w-0 items-center gap-2">
          <label
            className={cn(
              'inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-xs hover:bg-accent',
              invalid && 'border-destructive',
              (disabled || uploading) && 'pointer-events-none opacity-60',
            )}
          >
            {uploading ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <FileUp className="size-3.5" aria-hidden />}
            {attached ? t('media.replace') : t('media.choose')}
            <input
              data-testid={testId('file')}
              type="file"
              accept={accept}
              className="sr-only"
              disabled={disabled || uploading}
              onChange={async (e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (!file) return
                setUploading(true)
                setError(null)
                try {
                  const media = await nodeEditorsApi.upload(file, file.name)
                  onUploaded(media, blobRef(media.sha256), file)
                } catch (err) {
                  setError(uploadErrorText(err, t('media.uploadError')))
                } finally {
                  setUploading(false)
                }
              }}
            />
          </label>
          <span data-testid={testId('name')} className="min-w-0 truncate text-[11px] text-muted-foreground">
            {attached ? fileName || t('media.attached') : t('media.none')}
          </span>
        </div>
      ) : (
        <input
          data-testid={testId('url')}
          type="url"
          inputMode="url"
          placeholder="https://"
          value={url}
          disabled={disabled}
          aria-invalid={invalid}
          aria-label={t('media.url')}
          onChange={(e) => onUrl(e.target.value)}
          className={inputClass}
        />
      )}
      {error ? (
        <p data-testid={testId('upload-error')} role="alert" className="text-[11px] text-destructive">
          {error}
        </p>
      ) : null}
      {thumb ? <img src={thumb} alt="" className="max-h-28 w-fit max-w-full rounded-md border object-contain" /> : null}
    </div>
  )
}

/** Figurinhas da empresa (`ne-sticker-<id>`): escolher uma grava a referência `blob:` dela. */
export function StickerLibrary({ testId, disabled, onPicked }: { testId: (part: string) => string; disabled?: boolean; onPicked: (media: UploadedMedia, ref: string, name: string) => void }) {
  const t = useT(NS)
  const q = useQuery(stickersQuery())
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const items = q.data ?? []
  if (q.isPending) return <p className="text-[11px] text-muted-foreground">{t('common.loading')}</p>
  if (items.length === 0) return <p className="text-[11px] text-muted-foreground">{t('sticker.empty')}</p>
  return (
    <div className="flex flex-col gap-1">
      <p className="flex items-center gap-1 text-xs font-medium">
        <Smile className="size-3.5" aria-hidden /> {t('sticker.library')}
      </p>
      <div data-testid={testId('stickers')} className="flex flex-wrap gap-1.5">
        {items.map((s) => (
          <button
            key={s.id}
            type="button"
            data-testid={testId(`sticker-${s.id}`)}
            aria-label={s.name}
            disabled={disabled || !!busy}
            onClick={async () => {
              setBusy(s.id)
              setError(null)
              try {
                const media = await nodeEditorsApi.stickerMedia(s)
                onPicked(media, blobRef(media.sha256), s.name)
              } catch (err) {
                setError(uploadErrorText(err, t('media.uploadError')))
              } finally {
                setBusy(null)
              }
            }}
            className="relative size-12 rounded-md border p-0.5 hover:bg-accent disabled:opacity-60"
          >
            <img src={apiUrl(s.url)} alt="" className="size-full object-contain" />
            {busy === s.id ? <Loader2 className="absolute inset-0 m-auto size-4 animate-spin" aria-hidden /> : null}
          </button>
        ))}
      </div>
      {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
    </div>
  )
}

// ---------------------------------------------------------------- prévia

export interface PreviewMessage {
  kind: 'text' | 'image'
  text: string
  /** URL exibível (http(s) ou `/api/media/:id`); sem ela a imagem aparece como marcador. */
  image?: string | null
  /** Trecho em fonte mono depois do texto (ex.: código Pix). */
  code?: string | null
  note?: string | null
}

/** Prévia em formato de chat (balões de saída) do que o nó envia. */
export function ChatPreview({ messages, title }: { messages: PreviewMessage[]; title?: string }) {
  const t = useT(NS)
  return (
    <section data-testid="ne-preview" aria-label={title ?? t('preview.title')} className="flex flex-col gap-1.5 rounded-lg bg-muted/50 p-2">
      <p className="text-[11px] font-medium text-muted-foreground">{title ?? t('preview.title')}</p>
      {messages.map((m, i) => (
        <div
          key={i}
          data-testid={`ne-preview-message-${i}`}
          data-kind={m.kind}
          className="ml-auto flex max-w-[92%] flex-col gap-1 rounded-lg rounded-tr-sm bg-emerald-100 px-2 py-1.5 text-xs text-emerald-950 shadow-sm dark:bg-emerald-900 dark:text-emerald-50"
        >
          {m.kind === 'image' ? (
            m.image ? (
              <img src={m.image} alt="" className="max-h-32 w-full rounded object-cover" />
            ) : (
              <div className="flex h-16 items-center justify-center rounded bg-black/10">
                <ImageIcon className="size-5 opacity-60" aria-hidden />
              </div>
            )
          ) : null}
          {m.text ? <p data-testid={`ne-preview-text-${i}`} className="break-words whitespace-pre-wrap">{m.text}</p> : null}
          {m.code ? <p data-testid={`ne-preview-code-${i}`} className="font-mono text-[10px] break-all">{m.code}</p> : null}
          {m.note ? <p className="text-[10px] italic opacity-80">{m.note}</p> : null}
        </div>
      ))}
    </section>
  )
}
