import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { companySchema, createCompanySchema, emailSchema } from './dto'
import { isId, newId } from './ids'
import { formatMoney, microsToUsd, moneySchema, toCents, usdToMicros } from './money'
import { buildPageMeta, cursorQuerySchema, pageOffset, pageQuerySchema } from './pagination'

describe('pagination', () => {
  it('aplica padrões e limites', () => {
    expect(pageQuerySchema.parse({})).toEqual({ page: 1, limit: 20, skip_total: false })
    expect(pageQuerySchema.parse({ page: '3', limit: '50', skip_total: '1' })).toEqual({ page: 3, limit: 50, skip_total: true })
    expect(pageQuerySchema.parse({ skip_total: '0' }).skip_total).toBe(false)
    expect(pageQuerySchema.safeParse({ limit: '500' }).success).toBe(false)
    expect(cursorQuerySchema.parse({ limit: '5' })).toEqual({ limit: 5 })
  })

  it('monta o page com e sem total', () => {
    expect(pageOffset({ page: 3, limit: 20 })).toBe(40)
    expect(buildPageMeta({ page: 1, limit: 20 }, { total: 41 })).toEqual({ page: 1, limit: 20, total_count: 41, total_pages: 3, has_more: true })
    expect(buildPageMeta({ page: 3, limit: 20 }, { total: 41 }).has_more).toBe(false)
    expect(buildPageMeta({ page: 1, limit: 20 }, { fetchedCount: 21 })).toEqual({ page: 1, limit: 20, total_count: null, total_pages: null, has_more: true })
  })
})

describe('money', () => {
  it('converte textos e números em centavos', () => {
    expect(toCents('1.234,56')).toBe(123456)
    expect(toCents('1234.5')).toBe(123450)
    expect(toCents('R$ 1.234')).toBe(123400)
    expect(toCents('-10,00')).toBe(-1000)
    expect(toCents(0.1 + 0.2)).toBe(30)
    expect(() => toCents('abc')).toThrow(RangeError)
  })

  it('formata, micros e schema', () => {
    expect(formatMoney(123456, 'BRL', 'pt-BR')).toMatch(/1\.234,56/)
    expect(usdToMicros(1.5)).toBe(1_500_000)
    expect(microsToUsd(250_000)).toBe(0.25)
    expect(moneySchema.safeParse({ amount_cents: 100, currency: 'BRL' }).success).toBe(true)
    expect(moneySchema.safeParse({ amount_cents: 1.5, currency: 'brl' }).success).toBe(false)
  })
})

describe('ids e dto', () => {
  it('gera UUIDs válidos', () => {
    const id = newId()
    expect(isId(id)).toBe(true)
    expect(isId('x')).toBe(false)
  })

  it('valida empresa e normaliza e-mail', () => {
    expect(createCompanySchema.parse({ name: ' Acme ' })).toEqual({ name: 'Acme', time_zone: 'America/Sao_Paulo' })
    expect(createCompanySchema.safeParse({ name: 'A', time_zone: 'Mars/Base' }).success).toBe(false)
    expect(companySchema.shape.slug.safeParse('Acme Inc').success).toBe(false)
    expect(emailSchema.parse('Foo@Example.COM')).toBe('foo@example.com')
  })
})

describe('isomorfismo', () => {
  it('nenhum arquivo de produto importa builtins do Node nem usa process/Buffer/require', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name.endsWith('.ts') && !e.name.includes('.unit.test.')) {
          const src = readFileSync(p, 'utf8')
          if (/from\s+['"]node:|\bprocess\.|\bBuffer\b|\brequire\(/.test(src)) offenders.push(p)
        }
      }
    }
    walk(import.meta.dirname)
    expect(offenders).toEqual([])
  })
})
