import * as z from 'zod'
import { describe, expect, it, vi } from 'vitest'
import { LlmQuotaExceededError, LlmUpstreamError } from '../port/errors'
import { llmTool, type LlmRequest } from '../port/llm'
import { withUsageMeter, type UsageMeter } from '../port/meter'
import { FakeLlm, fail, output, refusal, text, toolCall, toolCalls } from './fake-llm'

const req = (extra: Partial<LlmRequest<unknown>> = {}): LlmRequest<unknown> => ({
  model: { provider: 'anthropic', model: 'fake' },
  instructions: 'x',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'oi' }] }],
  tenantId: 't1',
  agentId: 'a1',
  ...extra,
})

const moveCard = (spy = vi.fn(async (i: { cardId: string; column: string }) => ({ moved: i.cardId }))) =>
  llmTool({ name: 'move_card', description: 'move', input: z.object({ cardId: z.string(), column: z.string() }), execute: spy })

describe('FakeLlm', () => {
  it('executa a tool do roteiro e soma o uso (AC-T04-01)', async () => {
    const spy = vi.fn(async (i: { cardId: string; column: string }) => ({ moved: i.cardId }))
    const fake = new FakeLlm([toolCall('move_card', { cardId: 'c1', column: 'done' }), text('ok', { usage: { inputTokens: 7, costMicros: 3 } })])
    const r = await fake.generate(req({ tools: [moveCard(spy)] }))
    expect(spy).toHaveBeenCalledWith({ cardId: 'c1', column: 'done' }, expect.objectContaining({ tenantId: 't1', agentId: 'a1' }))
    expect(r.steps).toHaveLength(2)
    expect(r.finish).toBe('stop')
    expect(r.text).toBe('ok')
    expect(r.steps[0]!.toolResults[0]).toMatchObject({ toolName: 'move_card', output: { moved: 'c1' }, isError: false })
    expect(r.usage).toEqual({ inputTokens: 17, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costMicros: 3 })
    expect(fake.callCount).toBe(1)
  })

  it('para em tool-limit com maxSteps (AC-T04-02)', async () => {
    const fake = new FakeLlm({ script: [toolCall('move_card', { cardId: 'a', column: 'b' }), toolCall('move_card', { cardId: 'c', column: 'd' })] })
    const r = await fake.generate(req({ tools: [moveCard()], maxSteps: 1 }))
    expect(r.finish).toBe('tool-limit')
    expect(r.steps).toHaveLength(1)
  })

  it('valida output zod (AC-T04-03)', async () => {
    const schema = z.object({ intent: z.enum(['buy', 'sell']) })
    const bad = await new FakeLlm([output({ intent: 'x' })]).generate(req({ output: schema }))
    expect(bad.finish).toBe('error')
    expect(bad.error?.code).toBe('OUTPUT_VALIDATION')
    expect(bad.error?.message).toMatch(/intent/)
    expect(bad.object).toBeUndefined()
    const good = await new FakeLlm([text('{"intent":"buy"}')]).generate(req({ output: schema }))
    expect(good).toMatchObject({ finish: 'stop', object: { intent: 'buy' } })
    const notJson = await new FakeLlm([text('nope')]).generate(req({ output: schema }))
    expect(notJson.finish).toBe('error')
  })

  it('meter.before lançando impede a chamada (AC-T04-04)', async () => {
    const meter: UsageMeter = { before: () => { throw new LlmQuotaExceededError() }, after: vi.fn() }
    const viaOption = new FakeLlm([text('ok')], { meter })
    await expect(viaOption.generate(req())).rejects.toBeInstanceOf(LlmQuotaExceededError)
    expect(viaOption.callCount).toBe(0)
    const inner = new FakeLlm([text('ok')])
    await expect(withUsageMeter(inner, meter).generate(req())).rejects.toBeInstanceOf(LlmQuotaExceededError)
    expect(inner.calls).toHaveLength(0)
    expect(meter.after).not.toHaveBeenCalled()
  })

  it('meter roda before → chamada → after', async () => {
    const log: string[] = []
    const fake: FakeLlm = new FakeLlm([text('ok')], {
      meter: { before: () => void log.push(`before:${fake.callCount}`), after: (_r, res) => void log.push(`after:${fake.callCount}:${res.finish}`) },
    })
    await fake.generate(req())
    expect(log).toEqual(['before:0', 'after:1:stop'])
  })

  it('tool desconhecida, input inválido e execute com erro viram isError', async () => {
    const boom = llmTool({ name: 'boom', description: '', input: z.object({}), execute: async () => { throw new Error('falhou') } })
    const fake = new FakeLlm([toolCalls([{ name: 'nope', input: {} }, { name: 'move_card', input: { cardId: 1 } }, { name: 'boom', input: {} }]), text('fim')])
    const r = await fake.generate(req({ tools: [moveCard(), boom] }))
    expect(r.steps[0]!.toolResults.map((t) => t.isError)).toEqual([true, true, true])
    expect(r.steps[0]!.toolResults[2]!.output).toBe('falhou')
    expect(r.finish).toBe('stop')
  })

  it('refusal, fail e roteiro esgotado', async () => {
    const fake = new FakeLlm([refusal('não'), fail(new LlmUpstreamError('caiu', { provider: 'openai', status: 503 }))])
    expect((await fake.generate(req())).finish).toBe('refusal')
    await expect(fake.generate(req())).rejects.toBeInstanceOf(LlmUpstreamError)
    const empty = await fake.generate(req())
    expect(empty).toMatchObject({ finish: 'error', error: { code: 'SCRIPT_EXHAUSTED' } })
    expect(fake.callCount).toBe(3)
  })

  it('respeita AbortSignal', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(new FakeLlm([text('ok')]).generate(req({ signal: ac.signal }))).rejects.toBeTruthy()
  })
})
