import { describe, expect, it } from 'vitest'
import { computeHealthScore, healthLabel, type HealthScoreInput } from './score'

const base: HealthScoreInput = { sent: 0, received: 0, failed: 0, disconnects: 0, forbidden403: 0 }
const input = (over: Partial<HealthScoreInput>) => ({ ...base, ...over })

describe('healthLabel', () => {
  it.each([
    [100, 'Good'],
    [70, 'Good'],
    [69, 'Warning'],
    [40, 'Warning'],
    [39, 'Critical'],
    [0, 'Critical'],
  ])('%s → %s', (score, label) => expect(healthLabel(score)).toBe(label))
})

describe('computeHealthScore (tabela de casos, AC-T20-05)', () => {
  it.each<[string, Partial<HealthScoreInput>, number, string]>([
    ['sem sinais', {}, 100, 'Good'],
    ['envios saudáveis com respostas', { sent: 100, received: 30 }, 100, 'Good'],
    ['1 falha em 10', { sent: 9, failed: 1 }, 95, 'Good'],
    ['5 falhas em 10', { sent: 5, failed: 5 }, 75, 'Good'],
    ['10 falhas, nenhum envio', { failed: 10 }, 50, 'Warning'],
    ['2 desconexões', { disconnects: 2 }, 90, 'Good'],
    ['8 desconexões (teto 30)', { disconnects: 8 }, 70, 'Good'],
    ['1 evento 403', { forbidden403: 1 }, 60, 'Warning'],
    ['2 eventos 403 (teto 60)', { forbidden403: 2 }, 40, 'Warning'],
    ['taxa de resposta < 2%', { sent: 100, received: 1 }, 85, 'Good'],
    ['taxa de resposta < 10%', { sent: 100, received: 5 }, 92, 'Good'],
    ['amostra pequena não penaliza resposta', { sent: 10, received: 0 }, 100, 'Good'],
    ['tendência de erros +3', { errorTrend: 3 }, 88, 'Good'],
    ['tendência negativa não bonifica', { errorTrend: -5 }, 100, 'Good'],
    ['falhas + desconexões + sem resposta', { sent: 20, failed: 6, disconnects: 4 }, 42, 'Warning'],
    ['colapso', { sent: 100, received: 0, failed: 30, disconnects: 10, forbidden403: 3, errorTrend: 10 }, 0, 'Critical'],
  ])('%s', (_name, over, score, label) => {
    expect(computeHealthScore(input(over))).toEqual({ score, label })
  })

  it('é pura: não muta a entrada, mesma entrada → mesmo resultado', () => {
    const i = Object.freeze(input({ sent: 50, failed: 3, disconnects: 1 }))
    expect(computeHealthScore(i)).toEqual(computeHealthScore({ ...i }))
  })

  it('valores inválidos contam como 0', () => {
    expect(computeHealthScore(input({ failed: -3, disconnects: Number.NaN }))).toEqual({ score: 100, label: 'Good' })
  })

  it('monotônica nos sinais negativos e na resposta', () => {
    const start = input({ sent: 40, received: 2, failed: 2, disconnects: 1 })
    for (const key of ['failed', 'disconnects', 'forbidden403', 'errorTrend'] as const) {
      let prev = computeHealthScore(start).score
      for (let v = 0; v < 30; v++) {
        const s = computeHealthScore({ ...start, [key]: v + (start[key] ?? 0) }).score
        expect(s, `${key}=${v}`).toBeLessThanOrEqual(prev)
        prev = s
      }
    }
    let prev = computeHealthScore(start).score
    for (let r = 0; r < 40; r++) {
      const s = computeHealthScore({ ...start, received: r }).score
      if (r > 0) expect(s).toBeGreaterThanOrEqual(prev)
      prev = s
    }
  })
})
