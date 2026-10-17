import { afterEach, describe, expect, it, vi } from 'vitest'
import * as http from '@/lib/http'
import { simulatorApi, type SimulationResult } from './api'
import {
  acceptsText,
  applyResult,
  choiceButtons,
  choiceLabel,
  choose,
  initialSession,
  resumeBody,
  startSession,
} from './session'

afterEach(() => vi.restoreAllMocks())

const t = (key: string) => `t:${key}`

const waitingMenu: SimulationResult = {
  status: 'waiting',
  steps: [
    { seq: 1, node_key: 'start', node_type: 'start', status: 'done', handle: 'source' },
    { seq: 2, node_key: 'tags', node_type: 'tags', status: 'done', handle: 'source' },
    { seq: 3, node_key: 'menu', node_type: 'interactive_menu', status: 'done' },
  ],
  messages: [{ seq: 3, node_key: 'menu', to: 'contact', kind: 'text', text: 'Escolha:\n1. Vendas' }],
  notices: [{ seq: 2, code: 'not_simulated', node_key: 'tags', node_type: 'tags' }],
  vars: { __await: { node: 'menu', seq: 3 } },
  steps_total: 3,
  wait: {
    node_key: 'menu',
    node_type: 'interactive_menu',
    kind: 'menu',
    choices: [
      { handle: 'option:o1', label: 'Vendas', connected: true },
      { handle: 'other', connected: false },
      { handle: 'timeout', connected: true },
    ],
  },
}

describe('simulador no editor (T82)', () => {
  it('AC-T82-04 monta a conversa na ordem dos passos e oferece os botões das respostas possíveis', () => {
    const s = applyResult(startSession(), waitingMenu)
    expect(s.status).toBe('waiting')
    expect(s.items.map((i) => i.type)).toEqual(['notice', 'bot'])
    expect(choiceButtons(s).map((c) => choiceLabel(c, s.wait?.kind, t))).toEqual([
      'Vendas',
      't:choices.other',
      't:choices.timeout',
    ])
    expect(acceptsText(s)).toBe(false)
    expect(s.path).toEqual(['start', 'tags', 'menu'])
  })

  it('AC-T82-04 a escolha vira balão do usuário e a continuação reenvia nó, handle, variáveis e passos', () => {
    const s = applyResult(startSession(), waitingMenu)
    expect(resumeBody(s, 'option:o1')).toEqual({
      resume: { node_key: 'menu', handle: 'option:o1' },
      vars: waitingMenu.vars,
      steps_so_far: 3,
    })
    const next = choose(s, 'option:o1', 'Vendas')
    expect(next).toMatchObject({ status: 'running', wait: null })
    expect(next.items.at(-1)).toEqual({ type: 'user', handle: 'option:o1', text: 'Vendas' })
    const done = applyResult(next, {
      status: 'finished',
      steps: [{ seq: 4, node_key: 'm', node_type: 'message', status: 'done', handle: 'source' }],
      messages: [{ seq: 4, node_key: 'm', to: 'contact', kind: 'text', text: 'ok' }],
      notices: [],
      vars: {},
      steps_total: 4,
      end: { reason: 'no_next', node_key: 'm', handle: 'source' },
    })
    expect(done.status).toBe('finished')
    expect(done.items.slice(-2)).toEqual([
      { type: 'bot', message: { seq: 4, node_key: 'm', to: 'contact', kind: 'text', text: 'ok' } },
      { type: 'end', reason: 'no_next', nodeKey: 'm' },
    ])
    expect(() => resumeBody(done, 'source')).toThrow()
  })

  it('aguardar resposta usa o campo de texto; intervalo e escolhas sem rótulo usam os textos fixos', () => {
    const wait = applyResult(startSession(), {
      ...waitingMenu,
      wait: {
        node_key: 'w',
        node_type: 'wait_response',
        kind: 'wait_response',
        choices: [
          { handle: 'source', connected: true },
          { handle: 'timeout', connected: true },
        ],
      },
    })
    expect(acceptsText(wait)).toBe(true)
    expect(choiceButtons(wait).map((c) => c.handle)).toEqual(['timeout'])
    expect(choiceLabel({ handle: 'source', connected: true }, 'smart_interval', t)).toBe('t:choices.skipWait')
    expect(choiceLabel({ handle: 'output:outros', connected: true }, 'ai_choice', t)).toBe('t:choices.output: outros')
    expect(choiceLabel({ handle: 'output:a', connected: true }, 'distributor', t)).toBe('a')
    expect(choiceLabel({ handle: 'failure', connected: true }, 'integration_choice', t)).toBe('t:choices.failure')
  })

  it('AC-T82-03 loop interrompido fica marcado na sessão e no fim da conversa', () => {
    const s = applyResult(startSession(), {
      status: 'finished',
      steps: [],
      messages: [],
      notices: [],
      vars: {},
      steps_total: 50,
      end: { reason: 'loop_guard', node_key: 'a' },
      interrupted: 'loop_guard',
    })
    expect(s.interrupted).toBe(true)
    expect(s.items).toEqual([{ type: 'end', reason: 'loop_guard', nodeKey: 'a' }])
    expect(initialSession().status).toBe('idle')
  })

  it('chama POST /api/flows/:id/simulate com o corpo da continuação', async () => {
    const post = vi.spyOn(http.api, 'post').mockResolvedValue({ simulation: waitingMenu })
    await expect(simulatorApi.run('f 1', { steps_so_far: 2 })).resolves.toBe(waitingMenu)
    expect(post).toHaveBeenCalledWith('/api/flows/f%201/simulate', { steps_so_far: 2 })
  })
})
