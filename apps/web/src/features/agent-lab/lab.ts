// Regras puras do laboratório (T92): conversa do "Teste ao vivo", erros do servidor (`details.reason`), estágios do
// run da criação assistida, mescla do run vindo do SSE, estado do banner "revise antes de publicar" e o ditado.
import { HttpError } from '@/lib/http'
import { RUN_STAGES, type PublicRun, type RunStage, type TestMessageResult } from './api'

// ---------------------------------------------------------------- teste ao vivo

export type ChatMessage =
  | { id: string; role: 'user'; text: string }
  | { id: string; role: 'agent'; text: string; result: TestMessageResult }
  | { id: string; role: 'error'; text: string }

let seq = 0
export const msgId = () => `m${++seq}`

/** Bolhas do agente para uma resposta: um bloco por bolha; sem texto (só ferramentas) fica uma bolha vazia. */
export function agentMessages(result: TestMessageResult): ChatMessage[] {
  const blocks = result.blocks.filter((b) => b.text.trim())
  if (!blocks.length) return [{ id: msgId(), role: 'agent', text: '', result }]
  return blocks.map((b) => ({ id: msgId(), role: 'agent' as const, text: b.text, result }))
}

export type LabErrorKey = 'notConfigured' | 'noBalance' | 'evalCap' | 'validation' | 'notFound' | 'inProgress' | 'invalidAudio' | 'generic'

const REASONS: Record<string, LabErrorKey> = {
  not_configured: 'notConfigured',
  no_balance: 'noBalance',
  eval_cap: 'evalCap',
  validation: 'validation',
  not_found: 'notFound',
  create_in_progress: 'inProgress',
  invalid_audio: 'invalidAudio',
}

/** Chave i18n (`errors.<chave>`) do erro do laboratório. */
export function labErrorKey(err: unknown): LabErrorKey {
  if (!(err instanceof HttpError)) return 'generic'
  const reason = (err.details as { reason?: unknown } | undefined)?.reason
  if (typeof reason === 'string' && REASONS[reason]) return REASONS[reason]
  if (err.code === 'QUOTA_EXCEEDED') return 'noBalance'
  if (err.code === 'VALIDATION_ERROR') return 'validation'
  if (err.status === 404) return 'notFound'
  return 'generic'
}

/** 1ª mensagem de campo do 422 (`details.fields[]`), para mostrar junto do erro. */
export function firstFieldMessage(err: unknown): string | null {
  if (!(err instanceof HttpError)) return null
  const fields = (err.details as { fields?: { message?: unknown }[] } | undefined)?.fields
  const m = Array.isArray(fields) ? fields.find((f) => typeof f?.message === 'string')?.message : undefined
  return typeof m === 'string' ? m : null
}

/** Campos preenchidos acumulados na conversa (`collected`), em ordem alfabética. */
export function fieldEntries(fields: Record<string, string> | undefined): [string, string][] {
  return Object.entries(fields ?? {})
    .filter(([, v]) => typeof v === 'string')
    .sort(([a], [b]) => a.localeCompare(b))
}

/** Total de créditos cobrados nas respostas da conversa. */
export function totalCredits(messages: ChatMessage[]): number {
  const seen = new Set<TestMessageResult>()
  let total = 0
  for (const m of messages)
    if (m.role === 'agent' && !seen.has(m.result)) {
      seen.add(m.result)
      total += m.result.charged_credits || 0
    }
  return Math.round(total * 10_000) / 10_000
}

/** Créditos com até 4 casas, sem zeros à direita. */
export const formatCredits = (n: number) => String(Math.round(n * 10_000) / 10_000)

// ---------------------------------------------------------------- criação assistida

export const isTerminal = (run: Pick<PublicRun, 'status'> | null | undefined) =>
  run?.status === 'completed' || run?.status === 'failed'

/** Estágios concluídos: os informados + os anteriores ao estágio atual; concluído = todos. */
export function stagesDone(run: PublicRun): RunStage[] {
  if (run.status === 'completed') return [...RUN_STAGES]
  const done = new Set<RunStage>(run.stages_done ?? [])
  const at = run.stage ? RUN_STAGES.indexOf(run.stage) : -1
  RUN_STAGES.forEach((s, i) => {
    if (i < at) done.add(s)
  })
  return RUN_STAGES.filter((s) => done.has(s))
}

export type StageState = 'done' | 'active' | 'failed' | 'pending'

export function stageState(run: PublicRun, stage: RunStage): StageState {
  if (stagesDone(run).includes(stage)) return 'done'
  if (run.stage === stage) return run.status === 'failed' ? 'failed' : run.status === 'running' ? 'active' : 'pending'
  return 'pending'
}

/**
 * Mescla o run do SSE (sem `stages_done`) com o do cache. Um evento atrasado não faz um run terminado voltar a
 * rodar, nem o estágio andar para trás.
 */
export function mergeRun(old: PublicRun | undefined, incoming: PublicRun): PublicRun {
  if (!old) return incoming
  if (isTerminal(old) && !isTerminal(incoming)) return old
  const rank = (r: PublicRun) => (r.stage ? RUN_STAGES.indexOf(r.stage) : -1)
  if (!isTerminal(incoming) && rank(incoming) < rank(old)) return old
  const done = new Set<RunStage>([...(old.stages_done ?? []), ...(incoming.stages_done ?? [])])
  return {
    ...old,
    ...incoming,
    stages_done: RUN_STAGES.filter((s) => done.has(s)),
    warnings: [...new Set([...(old.warnings ?? []), ...(incoming.warnings ?? [])])],
  }
}

const KNOWN_WARNINGS = ['site_unread', 'empty_knowledge'] as const
/** Chave i18n do aviso (`assisted.warnings.<chave>`); desconhecido → `other`. */
export const warningKey = (w: string) => ((KNOWN_WARNINGS as readonly string[]).includes(w) ? w : 'other')

const RUN_ERRORS = ['not_configured', 'compose_failed', 'no_balance', 'limit_reached', 'request_failed', 'enqueue_failed'] as const
/** Chave i18n do erro do run (`assisted.runErrors.<chave>`). */
export const runErrorKey = (code: string | null) =>
  code && (RUN_ERRORS as readonly string[]).includes(code) ? code : 'request_failed'

/** Corpo do estimate/run: só o que foi preenchido. */
export function runInput(pitch: string, siteUrl: string): { pitch: string; site_url?: string } {
  const site = siteUrl.trim()
  return site ? { pitch: pitch.trim(), site_url: site } : { pitch: pitch.trim() }
}

/** O formulário pode estimar/criar: site http(s) válido ou pitch com ao menos 10 caracteres (mesma regra do servidor). */
export function canSubmitRun(pitch: string, siteUrl: string): boolean {
  const p = pitch.trim()
  const s = siteUrl.trim()
  if (s && !(/^https?:\/\//i.test(s) && URL.canParse(s))) return false
  if (p && p.length < 10) return false
  return !!s || p.length >= 10
}

// ---------------------------------------------------------------- banner "revise antes de publicar"

/** Chave no `history.state` com que a criação assistida abre o agente (sem search param novo). */
export const REVIEW_STATE_KEY = 'agentReview'

export interface ReviewState {
  runId: string
  warnings: string[]
}

export function reviewStateOf(state: unknown): ReviewState | null {
  const v = (state as Record<string, unknown> | null | undefined)?.[REVIEW_STATE_KEY] as Partial<ReviewState> | undefined
  if (!v || typeof v !== 'object' || typeof v.runId !== 'string') return null
  return { runId: v.runId, warnings: Array.isArray(v.warnings) ? v.warnings.filter((w) => typeof w === 'string') : [] }
}

// ---------------------------------------------------------------- ditado

/** Insere o texto ditado no fim do campo, separado por espaço (ou nada, se o campo termina em quebra de linha). */
export function appendDictation(current: string, text: string): string {
  const add = text.trim()
  if (!add) return current
  if (!current.trim()) return add
  return /\s$/.test(current) ? current + add : `${current} ${add}`
}

const MIME_EXT: Record<string, string> = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav' }
/** Nome do arquivo do áudio gravado (o servidor lê o mime; a extensão ajuda o STT). */
export const recordingFilename = (mime: string) => `ditado.${MIME_EXT[mime.split(';')[0]!.trim()] ?? 'webm'}`

const SKILL_KEYS = ['trigger_flow', 'transfer_human', 'apply_label', 'fill_field', 'close_conversation', 'move_card', 'compose_message'] as const
/** Chave i18n da habilidade disparada (`skills.<chave>`); desconhecida → `other`. */
export const skillKey = (actionType: string) => ((SKILL_KEYS as readonly string[]).includes(actionType) ? actionType : 'other')
