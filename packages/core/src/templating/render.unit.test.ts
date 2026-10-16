import { describe, expect, it, vi } from 'vitest'
import { extractVariables, firstName, greeting, render } from './render'

// 12:00Z = 09:00 em São Paulo (UTC−3).
const at = (iso: string) => new Date(iso)

describe('render', () => {
  it('saudação por horário no fuso (AC-T11-01)', () => {
    expect(render('{saudacao}', {}, { now: at('2026-10-16T12:00:00Z') })).toBe('Bom dia')
    expect(render('{saudacao}', {}, { now: () => at('2026-10-16T17:00:00Z') })).toBe('Boa tarde')
    expect(render('{saudacao}', { now: at('2026-10-16T23:00:00Z') })).toBe('Boa noite')
    expect(render('{saudacao}', {}, { now: at('2026-10-16T12:00:00Z'), timeZone: 'UTC' })).toBe('Boa tarde')
    expect(greeting(at('2026-10-16T14:59:00Z'))).toBe('Bom dia')
  })

  it('hora, data, dia e created_at no fuso', () => {
    const now = at('2026-10-16T01:05:00Z')
    expect(render('{hora} {data} {dia}', {}, { now })).toBe('22:05 15/10 quinta-feira')
    expect(render('{created_at}', { contact: { created_at: '2026-01-02T03:04:05Z' } })).toBe('02/01/2026 00:04:05')
  })

  it('nomes do contato e campos personalizados (AC-T11-02)', () => {
    const scope = { contact: { full_name: 'Maria da Silva', custom_fields: { plano: 'Ouro' } } }
    expect(render('{first_name}', scope)).toBe('Maria')
    expect(render('{{customer.full_name}} / {{ customer.plano }} / {plano}', scope)).toBe('Maria da Silva / Ouro / Ouro')
    expect(render('{first_name}', { contact: { first_name: 'Mari', full_name: 'Maria da Silva' } })).toBe('Mari')
    expect(firstName('  Ana  Paula ')).toBe('Ana')
  })

  it('variáveis globais com e sem prefixo', () => {
    const scope = { globals: { g_loja: 'Centro', cupom: 'X10' } }
    expect(render('{g_loja} {g_cupom} {{global.g_loja}}', scope)).toBe('Centro X10 Centro')
  })

  it('ausente: empty e keep (AC-T11-03)', () => {
    expect(render('Oi {nada}!', {})).toBe('Oi !')
    expect(render('Oi {nada} {{customer.nao_existe}}!', {}, { missing: 'keep' })).toBe('Oi {nada} {{customer.nao_existe}}!')
    expect(render('{v}', { vars: { v: null } }, { missing: 'keep' })).toBe('{v}')
  })

  it('dot-path com índice e escape (AC-T11-04)', () => {
    const vars = { response: { data: [{ status: 'pago' }], type: 'application/json' }, n: 3, ok: true, obj: { a: 1 } }
    expect(render('{response.data.0.status} {response.type} {n} {ok} {obj}', { vars })).toBe('pago application/json 3 true {"a":1}')
    expect(render('\\{first_name} {first_name}', { contact: { full_name: 'Ana Lima' } })).toBe('{first_name} Ana')
    expect(render('{response.data.9.status}|{response.data.x}', { vars })).toBe('|')
  })

  it('não executa código nem acessa protótipos (AC-T11-05)', () => {
    const fn = vi.fn(() => 'executou')
    const vars = JSON.parse('{"__proto__": {"x": 1}, "o": {}}') as Record<string, unknown>
    vars.fn = fn
    const keep = { missing: 'keep' as const }
    expect(render('{__proto__}|{constructor}|{o.constructor}|{o.__proto__.x}|{prototype}', { vars }, keep)).toBe('||||')
    expect(render('{toString}|{hasOwnProperty}|{o.toString}', { vars })).toBe('||')
    expect(render('{fn}', { vars })).toBe('')
    expect(fn).not.toHaveBeenCalled()
    const own = Object.create({ herdado: 'x' }) as Record<string, unknown>
    own.proprio = 'ok'
    expect(render('{proprio}|{herdado}', { vars: own, contact: Object.create({ herdado: 'y' }) })).toBe('ok|')
    const getter = vi.fn(() => 'executou')
    expect(render('{g}', { vars: Object.defineProperty({}, 'g', { get: getter, enumerable: true }) })).toBe('')
    expect(getter).not.toHaveBeenCalled()
    expect(({} as Record<string, unknown>).x).toBeUndefined()
  })

  it('JSON e chaves que não são variáveis ficam intactos', () => {
    expect(render('{"a": 1} e {a:b}', {})).toBe('{"a": 1} e {a:b}')
    expect(render('', {})).toBe('')
  })

  it('extractVariables', () => {
    expect(extractVariables('{a} {{customer.b}} \\{c} {a} {"x":1}')).toEqual(['a', 'customer.b'])
  })
})
