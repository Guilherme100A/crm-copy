// AC-T20-05: Health Score (função pura) — tabela de casos e rótulos Good ≥ 70, Warning 40–69, Critical < 40.
// Scores esperados calculados com os pesos do ai-manager (fork 1:1): falha 3 (teto 30) + taxa de falha × 20
// (amostra ≥ 5), desconexão 5 (teto 30), 403 40 (teto 60), resposta < 2% → 15 e < 10% → 8 (amostra ≥ 20).
import { beforeAll, describe, expect, it } from 'vitest'
import { healthMod } from './support'

let H: any

beforeAll(async () => {
  H = await healthMod()
})

const base = { sent: 100, received: 50, failed: 0, disconnects: 0, forbidden403: 0 }

const CASES: Array<[string, Record<string, number>, number, 'Good' | 'Warning' | 'Critical']> = [
  ['sessão saudável', {}, 100, 'Good'],
  ['5 falhas em 100 tentativas', { sent: 95, failed: 5 }, 84, 'Good'],
  ['4 desconexões', { disconnects: 4 }, 80, 'Good'],
  ['10 desconexões (teto 30) → exatamente 70', { disconnects: 10 }, 70, 'Good'],
  ['taxa de resposta muito baixa (1%)', { received: 1 }, 85, 'Good'],
  ['taxa de resposta baixa (5%)', { received: 5 }, 92, 'Good'],
  ['um 403', { forbidden403: 1 }, 60, 'Warning'],
  ['três 403 (teto 60) → exatamente 40', { forbidden403: 3 }, 40, 'Warning'],
  ['dois 403 (2×40 = 80, teto 60) → 40', { forbidden403: 2 }, 40, 'Warning'],
  ['um 403 + 6 desconexões', { forbidden403: 1, disconnects: 6 }, 30, 'Critical'],
  ['muitas falhas + desconexões', { sent: 40, failed: 10, disconnects: 6 }, 36, 'Critical'],
  ['tudo ruim (piso 0)', { sent: 10, received: 0, failed: 50, disconnects: 20, forbidden403: 5 }, 0, 'Critical'],
]

describe('T20 — Health Score', () => {
  for (const [name, patch, score, label] of CASES) {
    it(`AC-T20-05 ${name} → score ${score} (${label})`, () => {
      const r = H.computeHealthScore({ ...base, ...patch })
      expect(r).toEqual({ score, label })
    })
  }

  it('AC-T20-05 rótulos nas fronteiras: 70 Good, 69 Warning, 40 Warning, 39 Critical', () => {
    expect(H.healthLabel(100)).toBe('Good')
    expect(H.healthLabel(70)).toBe('Good')
    expect(H.healthLabel(69)).toBe('Warning')
    expect(H.healthLabel(40)).toBe('Warning')
    expect(H.healthLabel(39)).toBe('Critical')
    expect(H.healthLabel(0)).toBe('Critical')
  })

  it('AC-T20-05 o score fica em 0..100 e piora (nunca melhora) com mais sinais ruins', () => {
    let prev = 101
    for (let f = 0; f <= 4; f++) {
      const { score } = H.computeHealthScore({ ...base, forbidden403: f })
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(100)
      expect(score).toBeLessThanOrEqual(prev)
      prev = score
    }
  })

  it('AC-T20-05 é função pura: mesma entrada → mesmo resultado, sem alterar a entrada', () => {
    const input = Object.freeze({ ...base, failed: 3, disconnects: 2, forbidden403: 1 })
    expect(H.computeHealthScore(input)).toEqual(H.computeHealthScore({ ...input }))
  })
})
