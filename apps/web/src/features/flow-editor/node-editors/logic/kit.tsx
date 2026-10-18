// Peças comuns dos editores de nó da T57 (lógica, CRM e externos), no padrão da T56 (`messaging/kit.tsx`, copiado e não
// importado): rascunho que só salva quando o schema do T10 e as regras locais aceitam, erro inline (`ne-error-<caminho>`),
// estado `ne-status`, seletor de variável (`ne-var-picker`), aviso de lista sem permissão e as saídas do nó.
import { nodeHandles, type FlowAction } from '@crm/shared/flows'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Braces, CheckCircle2 } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { useT } from '@/i18n'
import { cn } from '@/lib/utils'
import { customFieldsQuery, globalVariablesQuery } from './api'
import { AD_VARIABLES, CONTACT_VARIABLES, hasErrors, insertVariable, SYSTEM_VARIABLES, validateActions, withOrder, type Config, type FieldError, type FieldErrors } from './rules'

export const NS = 'node-editors-logic'

export const inputClass =
  'h-8 w-full min-w-0 rounded-md border bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70 aria-[invalid=true]:border-destructive'
export const textareaClass =
  'min-h-20 w-full min-w-0 rounded-md border bg-background px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70 aria-[invalid=true]:border-destructive'
export const smallButton = 'inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs hover:bg-accent disabled:pointer-events-none disabled:opacity-50'
export const iconButton = 'flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-destructive disabled:opacity-50'

// ---------------------------------------------------------------- rascunho com bloqueio

/**
 * Rascunho local das ações do nó. Cada mudança valida as configs (schema do T10 + regras locais); só um rascunho SEM
 * erros vai para `onChange` (que dispara o autosave do canvas). Com erro, o nó salvo continua o último válido e o editor
 * mostra os erros no campo e `ne-status=blocked`. `normalize` completa a ação principal de um nó novo (vazio).
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
  const prepare = useCallback((items: FlowAction[]) => withOrder(normalize ? normalize(items) : items), [normalize])
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
  // mobile): o rascunho volta a ser o nó. Se `normalize` completou o nó e o resultado já é válido, grava logo.
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
      {blocked ? <AlertTriangle className="size-3.5 shrink-0" aria-hidden /> : <CheckCircle2 className="size-3.5 shrink-0" aria-hidden />}
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

/** Rótulo + controle + erro do caminho `path` (o controle recebe `id` e `invalid`). */
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
  hint?: string | undefined
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

export interface Option {
  value: string
  label: string
  disabled?: boolean
  testId?: string
}

/** `<select>` nativo; `placeholder` vira a opção vazia (valor `''`). */
export function Select({
  id,
  value,
  options,
  onChange,
  disabled,
  invalid,
  testId,
  placeholder,
}: {
  id?: string
  value: string
  options: readonly Option[]
  onChange: (v: string) => void
  disabled?: boolean
  invalid?: boolean
  testId?: string
  placeholder?: string
}) {
  const known = value === '' || options.some((o) => o.value === value)
  return (
    <select
      id={id}
      data-testid={testId}
      value={value}
      disabled={disabled}
      aria-invalid={invalid}
      onChange={(e) => onChange(e.target.value)}
      className={cn(inputClass, 'pr-1')}
    >
      {placeholder !== undefined || value === '' ? <option value="">{placeholder ?? ''}</option> : null}
      {/* Valor salvo que a lista não traz (item removido, sem permissão): continua visível. */}
      {known ? null : <option value={value}>{value}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled} data-testid={o.testId}>
          {o.label}
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

/**
 * Estado de uma lista da API: `ne-list-denied-<nome>` (403/404, sem permissão) ou `ne-list-empty-<nome>` (nenhum item).
 * O editor continua utilizável nos dois casos.
 */
export function ListNotice({ name, denied, empty, loading }: { name: string; denied: boolean; empty: boolean; loading?: boolean }) {
  const t = useT(NS)
  if (loading) return <p className="text-[11px] text-muted-foreground">{t('common.loading')}</p>
  if (denied)
    return (
      <Notice testId={`ne-list-denied-${name}`} tone="warn">
        {t('lists.denied', { list: t(`lists.names.${name}`) })}
      </Notice>
    )
  if (empty) return <p data-testid={`ne-list-empty-${name}`} className="text-[11px] text-muted-foreground">{t('lists.empty', { list: t(`lists.names.${name}`) })}</p>
  return null
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
  onChange: (raw: string) => void
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
      onChange={(e) => onChange(e.target.value)}
      className={inputClass}
    />
  )
}

// ---------------------------------------------------------------- variáveis

function useVariableGroups() {
  const t = useT(NS)
  const globals = useQuery(globalVariablesQuery()).data?.items ?? []
  const fields = useQuery(customFieldsQuery()).data?.items ?? []
  return [
    { id: 'contact', label: t('vars.contact'), names: [...CONTACT_VARIABLES] as string[] },
    { id: 'ad', label: t('vars.ad'), names: [...AD_VARIABLES] as string[] },
    { id: 'fields', label: t('vars.fields'), names: fields },
    { id: 'system', label: t('vars.system'), names: [...SYSTEM_VARIABLES] as string[] },
    { id: 'globals', label: t('vars.globals'), names: globals.map((g) => g.name) },
  ].filter((g) => g.names.length > 0)
}

/** Botão `ne-var-picker` com a lista `ne-var-<nome>`; insere `{nome}` no cursor do campo. */
function VariablePicker({ onPick, disabled }: { onPick: (name: string) => void; disabled?: boolean | undefined }) {
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
  mono,
}: {
  label: string
  path: string
  errors?: FieldErrors | undefined
  value: string
  onChange: (v: string) => void
  disabled?: boolean | undefined
  multiline?: boolean
  placeholder?: string | undefined
  testId: string
  hint?: string | undefined
  maxLength?: number
  mono?: boolean
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
      {multiline ? <textarea {...common} className={cn(textareaClass, mono && 'font-mono text-xs')} /> : <input {...common} className={cn(inputClass, mono && 'font-mono text-xs')} />}
      {hint && !error ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
      <ErrorText path={path} error={error} />
    </div>
  )
}

// ---------------------------------------------------------------- saídas

/** Saídas (handles) que o nó terá no canvas, derivadas da config do rascunho (`ne-outputs` / `ne-output-<handle>`). */
export function OutputsSummary({ type, actions, label }: { type: string; actions: FlowAction[]; label?: (handle: string) => string }) {
  const t = useT(NS)
  const handles = nodeHandles({ type, actions })
  return (
    <div data-testid="ne-outputs" className="flex flex-col gap-1">
      <p className="text-xs font-medium">{t('outputs.title')}</p>
      <ul className="flex flex-wrap gap-1">
        {handles.map((h) => (
          <li key={h} data-testid={`ne-output-${h}`} className="rounded border bg-muted/50 px-1.5 py-0.5 font-mono text-[10px]">
            {label ? label(h) : h}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Seção com título (agrupa campos dentro do painel estreito). */
export function Section({ title, testId, children, actions }: { title: string; testId?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section data-testid={testId} className="flex min-w-0 flex-col gap-2 rounded-md border p-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold">{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  )
}
