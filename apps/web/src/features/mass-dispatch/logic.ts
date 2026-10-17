// Regras puras da tela de disparos em massa (10 §3.1, §3.2, §3.4, §4, §5): presets de velocidade, validação do
// wizard (réplica do `rules.ts` do core — a web não importa `@crm/core`), manifesto do público, corpo multipart,
// cards da visão geral, fases da preparação e patch do evento `mass_dispatch.updated`.
import type { MassDispatchDraft } from '@/features/contacts/selection'
import {
  PREPARATION_PHASES,
  type MassDispatchDto,
  type MassDispatchesPage,
  type MassDispatchStatus,
  type PreparationPhase,
  type PreparationProgress,
  type QuotaDto,
} from './api'

export const MAX_INTERVAL_SECONDS = 120
export const DEFAULT_WINDOW = { start: '08:00', end: '18:00' } as const
export const FULL_DAY_WINDOW = { start: '00:00', end: '23:59' } as const
export const ALL_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const
export const DEFAULT_WEEKDAYS = [1, 2, 3, 4, 5] as const

export const SPEED_PRESETS = ['slow', 'normal', 'fast', 'custom'] as const
export type SpeedPreset = (typeof SPEED_PRESETS)[number]

/** Intervalo (s) de cada preset (10 §3.1): rápido 0–5, normal 5–30 (padrão), lento 30–120. */
export const PRESET_INTERVALS: Record<Exclude<SpeedPreset, 'custom'>, { min: number; max: number }> = {
  fast: { min: 0, max: 5 },
  normal: { min: 5, max: 30 },
  slow: { min: 30, max: 120 },
}

/** Status que contam como "Em andamento" (10 §4) e que ainda podem ser cancelados (T60 `CANCELLABLE_STATUSES`). */
export const ACTIVE_STATUSES: readonly MassDispatchStatus[] = ['preparing', 'scheduled', 'running', 'paused']
export const CANCELLABLE_STATUSES: readonly MassDispatchStatus[] = ['preparing', 'scheduled', 'running', 'paused']

export const isActive = (s: MassDispatchStatus) => ACTIVE_STATUSES.includes(s)
export const canCancel = (s: MassDispatchStatus) => CANCELLABLE_STATUSES.includes(s)

/** Cards da visão geral: "Restantes"/"Usados" vêm da cota; "Em andamento"/"Concluídos" contam a página carregada. */
export function overview(items: readonly MassDispatchDto[], quota: QuotaDto | undefined) {
  return {
    remaining: quota?.remaining ?? null,
    used: quota?.used ?? null,
    limit: quota?.limit ?? null,
    running: items.filter((d) => isActive(d.status)).length,
    completed: items.filter((d) => d.status === 'completed').length,
  }
}

/** Percentual usado da cota (0–100) para a barra. */
export function quotaPercent(q: Pick<QuotaDto, 'used' | 'limit'> | undefined): number {
  if (!q || q.limit <= 0) return q && q.used > 0 ? 100 : 0
  return Math.min(100, Math.max(0, Math.round((q.used / q.limit) * 100)))
}

/** Busca no cliente (a API não filtra): nome, fluxo, conexão ou número. */
export function matchesSearch(d: MassDispatchDto, term: string, fallbackName: string): boolean {
  const q = term.trim().toLowerCase()
  if (!q) return true
  const hay = [d.name ?? fallbackName, d.flow_b_name, ...d.targets.flatMap((t) => [t.flow_name, t.connection_name])]
  return hay.some((v) => !!v && v.toLowerCase().includes(q))
}

/** "Disparo em massa #abcd1234" quando não há nome. */
export const shortId = (id: string) => id.replace(/-/g, '').slice(0, 8)

// ---------------- Preparação ----------------

export type PhaseState = 'done' | 'current' | 'pending' | 'failed'

/** Estado de cada fase (queued → resolving_recipients → counting → scheduling → completed). */
export function phaseStates(
  status: MassDispatchStatus,
  progress: PreparationProgress | null | undefined,
): Record<PreparationPhase, PhaseState> {
  const phase = progress?.phase
  let idx = PREPARATION_PHASES.indexOf(phase as PreparationPhase)
  // Já saiu da preparação (agendado/enviando/concluído) sem a fase gravada: tudo concluído.
  if (idx < 0) idx = status === 'preparing' || status === 'failed' ? 0 : PREPARATION_PHASES.length - 1
  const out = {} as Record<PreparationPhase, PhaseState>
  PREPARATION_PHASES.forEach((p, i) => {
    if (status === 'failed') out[p] = i < idx ? 'done' : i === idx ? 'failed' : 'pending'
    else if (p === 'completed' && i === idx) out[p] = 'done'
    else out[p] = i < idx ? 'done' : i === idx ? 'current' : 'pending'
  })
  return out
}

export const preparationDone = (d: Pick<MassDispatchDto, 'status' | 'preparation_progress'>) =>
  d.status !== 'preparing' || d.preparation_progress?.phase === 'completed'

// ---------------- Realtime ----------------

/** Campos do evento `mass_dispatch.updated` aplicados no DTO (o resto vem do refetch). */
export function patchDispatch(d: MassDispatchDto, data: Record<string, unknown>): MassDispatchDto {
  const num = (k: string) => (typeof data[k] === 'number' ? (data[k] as number) : undefined)
  const next: MassDispatchDto = { ...d }
  if (typeof data.status === 'string') next.status = data.status as MassDispatchStatus
  if (data.preparation_progress && typeof data.preparation_progress === 'object')
    next.preparation_progress = data.preparation_progress as PreparationProgress
  for (const k of ['total_count', 'pending_count', 'sent_count', 'failed_count', 'skipped_count'] as const) {
    const v = num(k)
    if (v !== undefined) next[k] = v
  }
  const done = next.sent_count + next.failed_count
  next.progress_percent = next.total_count ? Math.floor((done / next.total_count) * 100) : 0
  return next
}

/** Página com o disparo atualizado, ou `null` se ele não está nela. */
export function patchPage(
  page: MassDispatchesPage,
  id: string,
  data: Record<string, unknown>,
): MassDispatchesPage | null {
  const i = page.items.findIndex((d) => d.id === id)
  if (i < 0) return null
  const items = [...page.items]
  items[i] = patchDispatch(items[i]!, data)
  return { ...page, items }
}

// ---------------- Wizard ----------------

export interface TargetForm {
  connection_id: string
  flow_id: string
}

export type AudienceMode = 'draft' | 'all'

export interface WizardForm {
  name: string
  targets: TargetForm[]
  business_hours: boolean
  weekdays: number[]
  window_start: string
  window_end: string
  preset: SpeedPreset
  randomize: boolean
  interval_min: number
  interval_max: number
  daily_limit: string
  /** `datetime-local` (vazio = agora). */
  starts_at: string
  audience: AudienceMode
}

export function initialForm(draft: MassDispatchDraft | null): WizardForm {
  return {
    name: '',
    targets: [{ connection_id: '', flow_id: '' }],
    business_hours: true,
    weekdays: [...DEFAULT_WEEKDAYS],
    window_start: DEFAULT_WINDOW.start,
    window_end: DEFAULT_WINDOW.end,
    preset: 'normal',
    randomize: true,
    interval_min: PRESET_INTERVALS.normal.min,
    interval_max: PRESET_INTERVALS.normal.max,
    daily_limit: '',
    starts_at: '',
    audience: draft ? 'draft' : 'all',
  }
}

/** Troca de preset: os não personalizados fixam o intervalo; o personalizado mantém o atual. */
export function applyPreset(f: WizardForm, preset: SpeedPreset): WizardForm {
  if (preset === 'custom') return { ...f, preset }
  const { min, max } = PRESET_INTERVALS[preset]
  return { ...f, preset, interval_min: min, interval_max: max }
}

/** Intervalo enviado: sem randomizar, o intervalo é fixo (max = min). */
export function effectiveInterval(f: Pick<WizardForm, 'interval_min' | 'interval_max' | 'randomize'>) {
  const min = Math.round(f.interval_min)
  return { min, max: f.randomize ? Math.round(f.interval_max) : min }
}

/** Dias e janela enviados: sem "horário comercial", todos os dias de 00:00 a 23:59. */
export function effectiveWindow(f: Pick<WizardForm, 'business_hours' | 'weekdays' | 'window_start' | 'window_end'>) {
  if (!f.business_hours) return { weekdays: [...ALL_WEEKDAYS], start: FULL_DAY_WINDOW.start, end: FULL_DAY_WINDOW.end }
  return { weekdays: [...new Set(f.weekdays)].sort((a, b) => a - b), start: f.window_start, end: f.window_end }
}

export const STEPS = ['data', 'settings', 'audience'] as const
export type WizardStep = (typeof STEPS)[number]

/** Código de erro (chave i18n `errors.<code>`) por caminho de campo. */
export type FormErrors = Record<string, string>

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

/** Validação do passo (10 §3.1: formRequired, dailyLimitInvalid, dailyLimitExceedsQuota, selectionRequired). */
export function validateStep(
  step: WizardStep,
  f: WizardForm,
  ctx: { remaining: number | null; audienceCount: number | null },
): FormErrors {
  const e: FormErrors = {}
  if (step === 'data') {
    if (!f.targets.length) e.targets = 'targetsRequired'
    f.targets.forEach((t, i) => {
      if (!t.connection_id) e[`targets.${i}.connection_id`] = 'connectionRequired'
      if (!t.flow_id) e[`targets.${i}.flow_id`] = 'flowRequired'
    })
  } else if (step === 'settings') {
    if (f.business_hours) {
      if (!f.weekdays.length) e.weekdays = 'weekdaysRequired'
      if (!HHMM.test(f.window_start)) e.window_start = 'timeInvalid'
      if (!HHMM.test(f.window_end)) e.window_end = 'timeInvalid'
      else if (HHMM.test(f.window_start) && f.window_start >= f.window_end) e.window_end = 'windowEmpty'
    }
    const { min, max } = effectiveInterval(f)
    if (!Number.isInteger(min) || min < 0 || min > MAX_INTERVAL_SECONDS) e.interval_min_seconds = 'intervalRange'
    if (!Number.isInteger(max) || max < 0 || max > MAX_INTERVAL_SECONDS) e.interval_max_seconds = 'intervalRange'
    else if (max < min) e.interval_max_seconds = 'intervalOrder'
    const raw = f.daily_limit.trim()
    if (raw) {
      const n = Number(raw)
      if (!/^\d+$/.test(raw) || !Number.isInteger(n) || n < 1) e.daily_limit = 'dailyLimitInvalid'
      else if (ctx.remaining !== null && n > ctx.remaining) e.daily_limit = 'dailyLimitExceedsQuota'
    }
    if (f.starts_at && Number.isNaN(new Date(f.starts_at).getTime())) e.starts_scheduling_at = 'dateInvalid'
  } else {
    if (ctx.audienceCount !== null && ctx.audienceCount <= 0) e.manifest = 'selectionRequired'
    if (ctx.remaining !== null && ctx.remaining <= 0) e.quota = 'noQuota'
  }
  return e
}

/** Passo dono de um caminho de erro do servidor (`details.fields[].path`). */
export function stepOfPath(path: string): WizardStep {
  if (
    path === 'name' ||
    path === 'flow_b_id' ||
    path.startsWith('targets') ||
    path === 'connection_id' ||
    path === 'flow_id'
  )
    return 'data'
  if (path === 'manifest' || path.startsWith('manifest.')) return 'audience'
  return 'settings'
}

/** Caminhos de erro (cliente e `details.fields` do servidor) que pertencem a um campo do formulário. */
export function errorPathsOf(field: keyof WizardForm): string[] {
  switch (field) {
    case 'targets':
      return ['targets', 'connection_id', 'flow_id']
    case 'business_hours':
      return ['weekdays', 'window_start', 'window_end']
    case 'preset':
    case 'randomize':
    case 'interval_min':
    case 'interval_max':
      return ['interval_min_seconds', 'interval_max_seconds']
    case 'starts_at':
      return ['starts_scheduling_at']
    case 'audience':
      return ['manifest']
    default:
      return [field]
  }
}

/** Manifesto do público (10 §3.2), como o `bulkDeleteManifest` de Contatos. */
export function buildManifest(audience: AudienceMode, draft: MassDispatchDraft | null): Record<string, unknown> {
  if (audience === 'draft' && draft) {
    return draft.mode === 'ids'
      ? { version: 1, mode: 'ids', filters: {}, ids: draft.ids }
      : { version: 1, mode: 'all_except', filters: draft.filters ?? {}, except_ids: draft.except_ids }
  }
  return { version: 1, mode: 'all_except', filters: {}, except_ids: [] }
}

/** `datetime-local` → ISO (vazio = agora, decidido pelo servidor). */
export function startsAtIso(local: string): string | null {
  if (!local) return null
  const d = new Date(local)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** Corpo multipart de `POST /api/mass-dispatches` (10 §6): manifesto como arquivo JSON. */
export function buildFormData(f: WizardForm, draft: MassDispatchDraft | null): FormData {
  const fd = new FormData()
  if (f.name.trim()) fd.append('name', f.name.trim())
  const targets = f.targets.map((t) => ({ connection_id: t.connection_id, flow_id: t.flow_id }))
  fd.append('targets', JSON.stringify(targets))
  if (targets[0]) {
    fd.append('connection_id', targets[0].connection_id)
    fd.append('flow_id', targets[0].flow_id)
  }
  const w = effectiveWindow(f)
  for (const d of w.weekdays) fd.append('weekdays[]', String(d))
  fd.append('window_start', w.start)
  fd.append('window_end', w.end)
  const i = effectiveInterval(f)
  fd.append('interval_min_seconds', String(i.min))
  fd.append('interval_max_seconds', String(i.max))
  if (f.daily_limit.trim()) fd.append('daily_limit', f.daily_limit.trim())
  const starts = startsAtIso(f.starts_at)
  if (starts) fd.append('starts_scheduling_at', starts)
  const manifest = JSON.stringify(buildManifest(f.audience, draft))
  fd.append('manifest', new Blob([manifest], { type: 'application/json' }), `mass-dispatch-${Date.now()}.json`)
  return fd
}

/** Lê o rascunho vindo de Contatos (`history.state.massDispatchDraft`, T77). */
export function readDraft(state: unknown, key: string): MassDispatchDraft | null {
  if (!state || typeof state !== 'object') return null
  const d = (state as Record<string, unknown>)[key]
  if (!d || typeof d !== 'object') return null
  const draft = d as Partial<MassDispatchDraft>
  if (draft.open_create !== true || (draft.mode !== 'ids' && draft.mode !== 'all_except')) return null
  return {
    open_create: true,
    mode: draft.mode,
    ids: Array.isArray(draft.ids) ? draft.ids.filter((x): x is string => typeof x === 'string') : [],
    except_ids: Array.isArray(draft.except_ids)
      ? draft.except_ids.filter((x): x is string => typeof x === 'string')
      : [],
    filters: draft.filters && typeof draft.filters === 'object' ? draft.filters : {},
    count: typeof draft.count === 'number' ? draft.count : 0,
  }
}
