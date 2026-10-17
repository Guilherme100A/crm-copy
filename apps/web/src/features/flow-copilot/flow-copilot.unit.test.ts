// Streaming do assistente de fluxo (T93): acúmulo dos deltas e repasse dos eventos do SSE por sessão.
import { describe, expect, it } from 'vitest'
import { registeredTypes } from '@/lib/realtime'
import {
  applyCopilotDelta,
  dispatchCopilotStream,
  emptyStreaming,
  onCopilotStream,
  registerFlowCopilotRealtime,
  type CopilotStreamEvent,
} from './stream'

const delta = (extra: Record<string, unknown>) => ({
  session_id: 's1',
  message_id: 'm1',
  kind: 'text' as const,
  ...extra,
})

describe('applyCopilotDelta', () => {
  it('acumula texto e ferramentas da mesma resposta', () => {
    let s = emptyStreaming()
    s = applyCopilotDelta(s, delta({ kind: 'tool', tool: 'create_node', ok: false, error: 'invalid_action_config' }))
    s = applyCopilotDelta(s, delta({ kind: 'tool', tool: 'create_node', ok: true }))
    s = applyCopilotDelta(s, delta({ delta: 'Criei ' }))
    s = applyCopilotDelta(s, delta({ delta: 'o bloco.' }))
    expect(s).toEqual({
      messageId: 'm1',
      text: 'Criei o bloco.',
      tools: [
        { tool: 'create_node', ok: false, error: 'invalid_action_config' },
        { tool: 'create_node', ok: true },
      ],
    })
  })

  it('delta de outra resposta recomeça', () => {
    const s = applyCopilotDelta(
      applyCopilotDelta(emptyStreaming(), delta({ delta: 'velho' })),
      delta({ message_id: 'm2', delta: 'novo' }),
    )
    expect(s).toEqual({ messageId: 'm2', text: 'novo', tools: [] })
  })
})

describe('eventos copilot.* do SSE', () => {
  it('registra copilot.delta e copilot.completed (estático, antes de abrir o SSE)', () => {
    registerFlowCopilotRealtime()
    registerFlowCopilotRealtime()
    expect(registeredTypes()).toEqual(expect.arrayContaining(['copilot.delta', 'copilot.completed']))
  })

  it('repassa só para quem ouve a sessão e para de repassar ao remover', () => {
    const got: CopilotStreamEvent[] = []
    const off = onCopilotStream('s1', (e) => got.push(e))
    dispatchCopilotStream('delta', delta({ delta: 'oi' }))
    dispatchCopilotStream('delta', delta({ session_id: 's2', delta: 'outro' }))
    dispatchCopilotStream('completed', { session_id: 's1', message_id: 'm1', status: 'completed', graph_changed: true })
    dispatchCopilotStream('delta', null)
    off()
    dispatchCopilotStream('delta', delta({ delta: 'depois' }))
    expect(got.map((e) => e.type)).toEqual(['delta', 'completed'])
    expect(got[1]).toMatchObject({ status: 'completed', graph_changed: true })
  })
})
