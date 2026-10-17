// Estado do simulador (T82; 06 §4.4): `idle` → `running` → `waiting` (com as respostas possíveis) → … → `finished`.
// A conversa é uma lista de itens (balões do bot, respostas simuladas e avisos) acumulada entre as chamadas.
import type { SimChoice, SimEndReason, SimMessage, SimulateBody, SimulationResult } from './api'

export type SimStatus = 'idle' | 'running' | 'waiting' | 'finished'

export type ChatItem =
  | { type: 'bot'; message: SimMessage }
  | { type: 'user'; handle: string; text: string }
  | { type: 'notice'; code: 'not_simulated' | 'jump_flow'; nodeKey: string; target?: string }
  | { type: 'end'; reason: SimEndReason; nodeKey?: string; error?: string }

export interface SimSession {
  status: SimStatus
  items: ChatItem[]
  wait: SimulationResult['wait'] | null
  vars: Record<string, unknown>
  stepsTotal: number
  interrupted: boolean
  /** Nós percorridos (para destacar o caminho, se quiser). */
  path: string[]
}

export const initialSession = (): SimSession => ({
  status: 'idle',
  items: [],
  wait: null,
  vars: {},
  stepsTotal: 0,
  interrupted: false,
  path: [],
})

/** Começo (ou reinício): conversa limpa, rodando. */
export const startSession = (): SimSession => ({ ...initialSession(), status: 'running' })

/** Mensagens e avisos na ordem dos passos (`seq`; estável dentro do passo); o fim por último. */
export function applyResult(s: SimSession, r: SimulationResult): SimSession {
  const ranked: Array<{ seq: number; item: ChatItem }> = [
    ...r.messages.map((m) => ({ seq: m.seq, item: { type: 'bot', message: m } as ChatItem })),
    ...r.notices.map((n) => ({
      seq: n.seq,
      item: (n.code === 'jump_flow'
        ? { type: 'notice', code: n.code, nodeKey: n.node_key, target: n.target_flow_id }
        : { type: 'notice', code: n.code, nodeKey: n.node_key }) as ChatItem,
    })),
  ]
  const items = [...s.items, ...ranked.sort((a, b) => a.seq - b.seq).map((x) => x.item)]
  if (r.status === 'finished' && r.end)
    items.push({
      type: 'end',
      reason: r.end.reason,
      ...(r.end.node_key ? { nodeKey: r.end.node_key } : {}),
      ...(r.end.error ? { error: r.end.error } : {}),
    })
  return {
    status: r.status === 'waiting' ? 'waiting' : 'finished',
    items,
    wait: r.status === 'waiting' ? (r.wait ?? null) : null,
    vars: r.vars,
    stepsTotal: r.steps_total,
    interrupted: r.interrupted === 'loop_guard',
    path: [...s.path, ...r.steps.map((x) => x.node_key)],
  }
}

/** Resposta escolhida: entra na conversa e a sessão volta a rodar. */
export function choose(s: SimSession, handle: string, text: string): SimSession {
  return { ...s, status: 'running', wait: null, items: [...s.items, { type: 'user', handle, text }] }
}

/** Corpo da continuação (protocolo stateless da rota). */
export function resumeBody(s: SimSession, handle: string, text?: string): SimulateBody {
  if (!s.wait) throw new Error('simulador não está esperando')
  return {
    resume: { node_key: s.wait.node_key, handle, ...(text !== undefined ? { text } : {}) },
    vars: s.vars,
    steps_so_far: s.stepsTotal,
  }
}

/** A espera aceita texto livre (Aguardar resposta → `source`). */
export const acceptsText = (s: SimSession) =>
  s.wait?.kind === 'wait_response' && s.wait.choices.some((c) => c.handle === 'source')

/** Botões de resposta: no Aguardar resposta o `source` sai pelo campo de texto. */
export const choiceButtons = (s: SimSession): SimChoice[] =>
  s.wait ? s.wait.choices.filter((c) => !(acceptsText(s) && c.handle === 'source')) : []

/** Rótulo do botão: o da config (opção, saída) ou o texto fixo do handle. */
export function choiceLabel(choice: SimChoice, kind: string | undefined, t: (key: string) => string): string {
  if (choice.label) return choice.label
  const i = choice.handle.indexOf(':')
  if (i > 0) {
    const kindOf = choice.handle.slice(0, i)
    const id = choice.handle.slice(i + 1)
    return kindOf === 'output' && kind === 'ai_choice' ? `${t('choices.output')}: ${id}` : id
  }
  if (choice.handle === 'source') return t(kind === 'smart_interval' ? 'choices.skipWait' : 'choices.reply')
  return t(`choices.${choice.handle}`)
}
