import { describe, expect, it } from 'vitest'
import { LlmError, LlmQuotaExceededError, LlmUpstreamError } from './errors'
import { addUsage, emptyUsage } from './llm'

describe('port', () => {
  it('addUsage soma campo a campo', () => {
    expect(addUsage({ inputTokens: 1, costMicros: 2 }, { inputTokens: 3, reasoningTokens: 4 })).toEqual({
      ...emptyUsage(),
      inputTokens: 4,
      reasoningTokens: 4,
      costMicros: 2,
    })
  })

  it('erros têm os códigos da API', () => {
    const q = new LlmQuotaExceededError()
    const u = new LlmUpstreamError('x', { provider: 'groq' }, { cause: new Error('y') })
    expect(q).toBeInstanceOf(LlmError)
    expect([q.code, q.name]).toEqual(['QUOTA_EXCEEDED', 'LlmQuotaExceededError'])
    expect([u.code, u.details.provider]).toEqual(['UPSTREAM_ERROR', 'groq'])
    expect(u.cause).toBeInstanceOf(Error)
  })
})
