import { describe, expect, it } from 'vitest'
import { divRound, priceWith, rawCost } from './pricing'
import { walletStatusFor } from './wallet'

const price = {
  id: 'p',
  provider: 'anthropic',
  model: 'm',
  kind: 'llm' as const,
  effectiveFrom: new Date(0),
  inputPerMtokMicros: 3_000_000, // US$ 3 / 1M
  outputPerMtokMicros: 15_000_000, // US$ 15 / 1M
  cacheReadPerMtokMicros: 300_000,
  cacheWritePerMtokMicros: 3_750_000,
  reasoningPerMtokMicros: null,
  unitPriceMicros: null,
  createdAt: new Date(0),
}

describe('divRound', () => {
  it('ceil, floor e round (meio para cima)', () => {
    expect(divRound(10n, 4n, 'ceil')).toBe(3n)
    expect(divRound(10n, 4n, 'floor')).toBe(2n)
    expect(divRound(10n, 4n, 'round')).toBe(3n)
    expect(divRound(9n, 4n, 'round')).toBe(2n)
    expect(divRound(8n, 4n, 'ceil')).toBe(2n)
  })
})

describe('rawCost', () => {
  it('separa cache read/write do input e reasoning do output', () => {
    // 1000 input (200 cache read + 100 cache write), 500 output (300 reasoning, herda o preço de output)
    const c = rawCost({ provider: 'anthropic', model: 'm', inputTokens: 1000, cacheReadTokens: 200, cacheWriteTokens: 100, outputTokens: 500, reasoningTokens: 300 }, price)
    const expected = 700n * 3_000_000n + 200n * 300_000n + 100n * 3_750_000n + 200n * 15_000_000n + 300n * 15_000_000n
    expect(c).toEqual({ num: expected, den: 1_000_000n })
  })

  it('tts por 1M caracteres e stt por minuto', () => {
    const p = { ...price, unitPriceMicros: 60_000_000 }
    expect(rawCost({ provider: 'x', model: 'y', kind: 'tts', characters: 500 }, p)).toEqual({ num: 500n * 60_000_000n, den: 1_000_000n })
    expect(rawCost({ provider: 'x', model: 'y', kind: 'stt', seconds: 90 }, p)).toEqual({ num: 90n * 60_000_000n, den: 60n })
  })
})

describe('priceWith', () => {
  it('markup e créditos arredondados só no fim', () => {
    // custo bruto = 1,5 micro; ×3 = 4,5 micro; × 5400 créditos/USD = 0,0243 crédito
    const cost = { num: 1_500_000n, den: 1_000_000n }
    expect(priceWith(cost, { markupBps: 30_000, creditsPerUsd: 5400, roundingMode: 'ceil' })).toEqual({ costMicros: 2, billedMicros: 5, credits: 1 })
    expect(priceWith(cost, { markupBps: 30_000, creditsPerUsd: 5400, roundingMode: 'floor' }).credits).toBe(0)
    // US$ 1 bruto, markup 1× → 5400 créditos exatos em qualquer modo
    const usd = { num: 1_000_000n * 1_000_000n, den: 1_000_000n }
    for (const mode of ['ceil', 'floor', 'round'] as const)
      expect(priceWith(usd, { markupBps: 10_000, creditsPerUsd: 5400, roundingMode: mode }).credits).toBe(5400)
  })
})

describe('walletStatusFor', () => {
  it('exhausted se saldo <= -overrun; low se <= limiar; senão ok', () => {
    expect(walletStatusFor(101, 100, 50)).toBe('ok')
    expect(walletStatusFor(100, 100, 50)).toBe('low')
    expect(walletStatusFor(0, 100, 50)).toBe('low')
    expect(walletStatusFor(-49, 100, 50)).toBe('low')
    expect(walletStatusFor(-50, 100, 50)).toBe('exhausted')
    expect(walletStatusFor(0, 0, 0)).toBe('exhausted')
  })
})
