import { beforeAll, describe, expect, it } from 'vitest'
import { callCount, exp, fakes, loadZod, port, request, sumUsage, USAGE_KEYS } from './contract'

const T = '@crm/ai/testing'
let z: typeof import('zod')['z']

beforeAll(async () => {
  z = (await loadZod()).z
})

function moveCardTool(calls: unknown[]) {
  return {
    name: 'move_card',
    description: 'Move um card do kanban para outra etapa',
    input: z.object({ cardId: z.string(), stageId: z.string() }),
    async execute(input: { cardId: string; stageId: string }, ctx: unknown) {
      calls.push({ input, ctx })
      return { moved: true, ...input }
    },
  }
}

describe('T04 — FakeLlm: loop de tools', () => {
  it("AC-T04-01 roteiro [toolCall('move_card'), text('ok')] executa a tool, 2 passos, finish 'stop'", async () => {
    const FakeLlm = exp(fakes, 'FakeLlm', T)
    const toolCall = exp(fakes, 'toolCall', T)
    const text = exp(fakes, 'text', T)
    const executed: any[] = []
    const fake = new FakeLlm([toolCall('move_card', { cardId: 'c1', stageId: 's2' }), text('ok')])

    const res = await fake.generate(request({ tools: [moveCardTool(executed)] }))

    expect(executed).toHaveLength(1)
    expect(executed[0].input).toEqual({ cardId: 'c1', stageId: 's2' })
    expect(res.steps.length).toBe(2)
    expect(res.finish).toBe('stop')
    expect(res.text).toBe('ok')
    // o resultado da tool aparece no passo da tool call
    const tr = res.steps[0].toolResults?.[0]
    expect(tr?.toolName).toBe('move_card')
    expect(tr?.isError ?? false).toBe(false)
    expect(tr?.output).toMatchObject({ moved: true })
  })

  it('AC-T04-01 usage do resultado é a soma do usage dos passos', async () => {
    const FakeLlm = exp(fakes, 'FakeLlm', T)
    const toolCall = exp(fakes, 'toolCall', T)
    const text = exp(fakes, 'text', T)
    const fake = new FakeLlm([
      toolCall('move_card', { cardId: 'c1', stageId: 's2' }, { usage: { inputTokens: 100, outputTokens: 7, cacheReadTokens: 3, costMicros: 50 } }),
      text('ok', { usage: { inputTokens: 40, outputTokens: 2, reasoningTokens: 9, costMicros: 25 } }),
    ])
    const res = await fake.generate(request({ tools: [moveCardTool([])] }))

    expect(res.steps.length).toBe(2)
    for (const k of USAGE_KEYS) expect(typeof res.usage[k], k).toBe('number')
    expect(res.usage).toMatchObject({ inputTokens: 140, outputTokens: 9, cacheReadTokens: 3, reasoningTokens: 9, costMicros: 75 })
    expect(res.usage).toMatchObject(sumUsage(res.steps))
  })

  it('AC-T04-01 com usage padrão por passo o total também é somado', async () => {
    const FakeLlm = exp(fakes, 'FakeLlm', T)
    const fake = new FakeLlm([exp(fakes, 'toolCall', T)('move_card', { cardId: 'c1', stageId: 's2' }), exp(fakes, 'text', T)('ok')])
    const res = await fake.generate(request({ tools: [moveCardTool([])] }))
    const one = res.steps[0].usage
    expect(one.inputTokens + one.outputTokens, 'passo sem usage').toBeGreaterThan(0)
    expect(res.usage).toMatchObject(sumUsage(res.steps))
    expect(res.usage.inputTokens).toBe(res.steps[0].usage.inputTokens + res.steps[1].usage.inputTokens)
  })

  it("AC-T04-02 maxSteps: 1 com roteiro de 2 tool calls → finish 'tool-limit'", async () => {
    const FakeLlm = exp(fakes, 'FakeLlm', T)
    const toolCall = exp(fakes, 'toolCall', T)
    const executed: any[] = []
    const fake = new FakeLlm([toolCall('move_card', { cardId: 'c1', stageId: 's2' }), toolCall('move_card', { cardId: 'c1', stageId: 's3' })])
    const res = await fake.generate(request({ tools: [moveCardTool(executed)], maxSteps: 1 }))

    expect(res.finish).toBe('tool-limit')
    expect(res.steps.length).toBe(1)
    expect(executed.length).toBeLessThanOrEqual(1)
  })
})

describe('T04 — FakeLlm: structured output (zod)', () => {
  const schema = () => z.object({ intent: z.enum(['buy', 'support']), score: z.number().min(0).max(1) })

  it("AC-T04-03 output inválido no roteiro → finish 'error' com mensagem de validação", async () => {
    const FakeLlm = exp(fakes, 'FakeLlm', T)
    const output = exp(fakes, 'output', T)
    const text = exp(fakes, 'text', T)
    for (const item of [output({ intent: 'dance', score: 7 }), text(JSON.stringify({ intent: 'dance', score: 7 }))]) {
      const res = await new FakeLlm([item]).generate(request({ output: schema() }))
      expect(res.finish).toBe('error')
      expect(res.object).toBeUndefined()
      const msg = String(res.error?.message ?? '')
      expect(msg.length, 'sem mensagem de validação').toBeGreaterThan(0)
      // a mensagem cita o problema de validação (campo ou valor inválido)
      expect(msg).toMatch(/intent|score|invalid|inválid|expected|esperad|too_big|enum/i)
    }
  })

  it('AC-T04-03 output válido → object tipado igual ao do roteiro', async () => {
    const FakeLlm = exp(fakes, 'FakeLlm', T)
    const output = exp(fakes, 'output', T)
    const text = exp(fakes, 'text', T)
    const value = { intent: 'buy', score: 0.9 }
    for (const item of [output(value), text(JSON.stringify(value))]) {
      const res = await new FakeLlm([item]).generate(request({ output: schema() }))
      expect(res.finish).toBe('stop')
      expect(res.object).toEqual(value)
      expect(res.error).toBeUndefined()
    }
  })
})

describe('T04 — UsageMeter', () => {
  it('AC-T04-04 UsageMeter.before lançando LlmQuotaExceededError impede a chamada do fake (calls = 0)', async () => {
    const FakeLlm = exp(fakes, 'FakeLlm', T)
    const LlmQuotaExceededError = exp(port, 'LlmQuotaExceededError', '@crm/ai')
    const text = exp(fakes, 'text', T)
    let after = 0
    const meter = {
      before() {
        throw new LlmQuotaExceededError('cota esgotada')
      },
      after() {
        after++
      },
    }
    const fake = new FakeLlm([text('nunca')], { meter })
    await expect(fake.generate(request())).rejects.toBeInstanceOf(LlmQuotaExceededError)
    expect(callCount(fake)).toBe(0)
    expect(after).toBe(0)
  })

  it('AC-T04-04 withUsageMeter(provider, meter): before lançando bloqueia e o provider não é chamado', async () => {
    const FakeLlm = exp(fakes, 'FakeLlm', T)
    const LlmQuotaExceededError = exp(port, 'LlmQuotaExceededError', '@crm/ai')
    const withUsageMeter = exp(port, 'withUsageMeter', '@crm/ai')
    const fake = new FakeLlm([exp(fakes, 'text', T)('nunca')])
    const metered = withUsageMeter(fake, {
      async before() {
        throw new LlmQuotaExceededError('cota esgotada')
      },
      async after() {},
    })
    await expect(metered.generate(request())).rejects.toBeInstanceOf(LlmQuotaExceededError)
    expect(callCount(fake)).toBe(0)
  })

  it('AC-T04-04 sem estouro, before roda antes e after depois da chamada (contador = 1)', async () => {
    const FakeLlm = exp(fakes, 'FakeLlm', T)
    const log: string[] = []
    const fake = new FakeLlm([exp(fakes, 'text', T)('ok')], {
      meter: {
        before: () => void log.push(`before:${callCount(fake)}`),
        after: (_req: unknown, res: any) => void log.push(`after:${callCount(fake)}:${res.finish}`),
      },
    })
    const res = await fake.generate(request())
    expect(res.finish).toBe('stop')
    expect(callCount(fake)).toBe(1)
    expect(log).toEqual(['before:0', 'after:1:stop'])
  })
})
