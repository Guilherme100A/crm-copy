// LLM do laboratório no harness (T92): o FakeLlm do E2E é lido a cada chamada, então o reset e o roteiro com
// `replace` (que trocam `deps.e2e.llm`) valem para o laboratório já montado.
import { FakeLlm, text } from '@crm/ai/testing'
import type { LlmProvider } from '@crm/ai'
import { describe, expect, it } from 'vitest'
import type { ResolvedDeps } from '../../lib/types'
import { labLlm } from './index'

const req = { model: { provider: 'openai' as const, model: 'gpt-test' }, instructions: 'x', messages: [], tenantId: 'c', agentId: 'a' }
const company: LlmProvider = { generate: async () => { throw new Error('não devia chamar o LLM da empresa') } }

describe('labLlm', () => {
  it('depois de trocar a instância do E2E, o laboratório usa a nova', async () => {
    const first = new FakeLlm().enqueue(text('primeiro'))
    const deps = { e2e: { llm: first } } as unknown as ResolvedDeps & { e2e: { llm: FakeLlm } }
    const llm = labLlm(deps, () => company)
    expect((await llm.generate(req)).text).toBe('primeiro')

    const second = new FakeLlm().enqueue(text('segundo'))
    deps.e2e.llm = second // como o POST /__e2e/reset e o /__e2e/llm/script { replace: true }
    expect((await llm.generate(req)).text).toBe('segundo')
    expect(first.callCount).toBe(1)
    expect(second.callCount).toBe(1)
  })

  it('aiLabLlm tem prioridade; sem E2E usa o LLM da empresa', async () => {
    const own = new FakeLlm()
    expect(labLlm({ aiLabLlm: own, e2e: { llm: new FakeLlm() } } as unknown as ResolvedDeps, () => company)).toBe(own)
    expect(labLlm({} as ResolvedDeps, () => company)).toBe(company)
  })
})
