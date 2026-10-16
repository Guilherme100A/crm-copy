import { describe, expect, it } from 'vitest'
import type { LlmRequest } from '@crm/ai'
import type { UsageGuard } from './guard'
import { estimateInputTokens, meter } from './meter'
import { periodBucket } from './period'

describe('periodBucket', () => {
  it('dia e mês no fuso da empresa', () => {
    // 2026-11-01 02:00 UTC ainda é 31/10 em São Paulo (UTC−3)
    const at = new Date('2026-11-01T02:00:00Z')
    expect(periodBucket('day', at, 'America/Sao_Paulo')).toBe('2026-10-31')
    expect(periodBucket('month', at, 'America/Sao_Paulo')).toBe('2026-10')
    expect(periodBucket('day', at, 'UTC')).toBe('2026-11-01')
    expect(periodBucket('month', at, 'UTC')).toBe('2026-11')
  })
})

describe('estimateInputTokens', () => {
  it('caracteres de instruções e mensagens ÷ 4', () => {
    const req = {
      instructions: '12345678',
      messages: [
        { role: 'user', content: '1234' },
        { role: 'user', content: [{ type: 'text', text: '12345678' }] },
      ],
    } as unknown as LlmRequest
    expect(estimateInputTokens(req)).toBe(5)
  })
})

describe('meter', () => {
  const guard = {} as UsageGuard
  it('detecta LLM, TTS e STT e rejeita outro objeto', () => {
    expect(typeof meter({ generate: async () => ({}) as never }, { guard, feature: 'f' }).generate).toBe('function')
    expect(typeof meter({ synthesize: async () => ({}) as never }, { guard, feature: 'f', companyId: 'c' }).synthesize).toBe('function')
    expect(typeof meter({ transcribe: async () => ({}) as never }, { guard, feature: 'f', companyId: 'c' }).transcribe).toBe('function')
    expect(() => meter({} as never, { guard, feature: 'f' })).toThrow(TypeError)
  })
})
