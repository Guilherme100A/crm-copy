// T11 — render(template, scope, opts) pela porta pública `@crm/core` (contrato combinado com o Operário).
import * as core from '@crm/core'
import { afterEach, describe, expect, it } from 'vitest'

const mod = core as unknown as Record<string, any>
function render(template: string, scope: Record<string, unknown> = {}, opts: Record<string, unknown> = {}): string {
  const f = mod.render
  if (typeof f !== 'function') throw new Error(`@crm/core não exporta render (exports: ${Object.keys(mod).join(', ') || '—'})`)
  return f(template, scope, opts)
}

const TZ = 'America/Sao_Paulo'
/** Instante UTC que corresponde a HH:mm em São Paulo (UTC-3, sem horário de verão desde 2019). */
const sp = (hhmm: string, day = '2026-10-15') => new Date(`${day}T${hhmm}:00-03:00`)

const CONTACT = { full_name: 'Maria da Silva', phone_number: '+5511999998888', email: 'maria@example.com', custom_fields: { plano: 'Anual' } }

describe('T11 — variáveis de sistema', () => {
  it('AC-T11-01 {saudacao} rende Bom dia às 09:00, Boa tarde às 14:00 e Boa noite às 20:00 em America/Sao_Paulo', () => {
    expect(render('{saudacao}', {}, { timeZone: TZ, now: sp('09:00') })).toBe('Bom dia')
    expect(render('{saudacao}', {}, { timeZone: TZ, now: sp('14:00') })).toBe('Boa tarde')
    expect(render('{saudacao}', {}, { timeZone: TZ, now: sp('20:00') })).toBe('Boa noite')
  })

  it('AC-T11-01 o relógio injetado pode ser função e o fuso padrão é America/Sao_Paulo', () => {
    expect(render('{saudacao}, Maria!', {}, { now: () => sp('09:00') })).toBe('Bom dia, Maria!')
    expect(render('{saudacao}', {}, { now: sp('14:00') })).toBe('Boa tarde')
    expect(render('{saudacao}', { now: sp('20:00') })).toBe('Boa noite')
  })

  it('AC-T11-01 a saudação usa o fuso informado, não o do processo', () => {
    // 12:00 UTC = 09:00 em SP; em UTC já é tarde.
    const instant = new Date('2026-10-15T12:00:00Z')
    expect(render('{saudacao}', {}, { timeZone: TZ, now: instant })).toBe('Bom dia')
    expect(render('{saudacao}', {}, { timeZone: 'UTC', now: instant })).toBe('Boa tarde')
    // 23:30 UTC = 20:30 em SP
    expect(render('{saudacao}', {}, { timeZone: TZ, now: new Date('2026-10-15T23:30:00Z') })).toBe('Boa noite')
  })

  it('AC-T11-01 {hora} e {data} saem no fuso da empresa', () => {
    expect(render('{hora} {data}', {}, { timeZone: TZ, now: new Date('2026-10-16T01:05:00Z') })).toBe('22:05 15/10')
  })
})

describe('T11 — contato', () => {
  it('AC-T11-02 {first_name} de "Maria da Silva" → "Maria"', () => {
    expect(render('Oi {first_name}!', { contact: { full_name: 'Maria da Silva' } })).toBe('Oi Maria!')
  })

  it('AC-T11-02 {{customer.full_name}} usa o nome completo', () => {
    expect(render('Cliente: {{customer.full_name}}', { contact: CONTACT })).toBe('Cliente: Maria da Silva')
    expect(render('{full_name} / {first_name}', { contact: CONTACT })).toBe('Maria da Silva / Maria')
  })

  it('AC-T11-02 campos personalizados pelo nome e variáveis globais {g_x}', () => {
    const scope = { contact: CONTACT, globals: { g_loja: 'Loja Centro' } }
    expect(render('{plano} - {g_loja}', scope)).toBe('Anual - Loja Centro')
    expect(render('{{customer.plano}}', scope)).toBe('Anual')
  })
})

describe('T11 — variável inexistente', () => {
  it("AC-T11-03 variável inexistente → vazio com missing: 'empty'", () => {
    expect(render('a{nao_existe}b', { contact: CONTACT }, { missing: 'empty' })).toBe('ab')
    expect(render('a{{customer.nao_existe}}b', { contact: CONTACT }, { missing: 'empty' })).toBe('ab')
    expect(render('[{response.data.9.status}]', { vars: { response: { data: [] } } }, { missing: 'empty' })).toBe('[]')
    expect(render('[{g_nao_existe}]', { globals: {} }, { missing: 'empty' })).toBe('[]')
  })

  it("AC-T11-03 variável inexistente → literal com missing: 'keep'", () => {
    expect(render('a{nao_existe}b', { contact: CONTACT }, { missing: 'keep' })).toBe('a{nao_existe}b')
    expect(render('a{{customer.nao_existe}}b', { contact: CONTACT }, { missing: 'keep' })).toBe('a{{customer.nao_existe}}b')
    expect(render('{response.data.9.status}', { vars: { response: { data: [] } } }, { missing: 'keep' })).toBe('{response.data.9.status}')
    // as existentes continuam interpoladas
    expect(render('{first_name} {x}', { contact: CONTACT }, { missing: 'keep' })).toBe('Maria {x}')
  })

  it("AC-T11-03 o padrão é missing: 'empty'", () => {
    expect(render('a{nao_existe}b', {})).toBe('ab')
  })
})

describe('T11 — dot-path e escape', () => {
  it('AC-T11-04 {response.data.0.status} lê o caminho (inclusive índice de array)', () => {
    const vars = { response: { data: [{ status: 'paid' }, { status: 'pending' }], type: 'application/json' } }
    expect(render('Status: {response.data.0.status}', { vars })).toBe('Status: paid')
    expect(render('{response.data.1.status} ({response.type})', { vars })).toBe('pending (application/json)')
  })

  it('AC-T11-04 \\{literal} não é interpolado', () => {
    expect(render('\\{literal}', {})).toBe('{literal}')
    expect(render('use \\{first_name} para o nome: {first_name}', { contact: CONTACT })).toBe('use {first_name} para o nome: Maria')
    expect(render('\\{literal}', {}, { missing: 'keep' })).toBe('{literal}')
  })
})

describe('T11 — segurança', () => {
  afterEach(() => {
    delete (globalThis as any).__t11_pwned
    delete (Object.prototype as any).polluted
  })

  it('AC-T11-05 {__proto__} e {constructor} → vazio (também com keep)', () => {
    for (const missing of ['empty', 'keep']) {
      expect(render('[{__proto__}]', { contact: CONTACT, vars: {} }, { missing }), missing).toBe('[]')
      expect(render('[{constructor}]', { contact: CONTACT, vars: {} }, { missing }), missing).toBe('[]')
      expect(render('[{{constructor}}]', { contact: CONTACT }, { missing }), missing).toBe('[]')
      expect(render('[{response.constructor}]', { vars: { response: {} } }, { missing }), missing).toBe('[]')
      expect(render('[{response.__proto__}]', { vars: { response: {} } }, { missing }), missing).toBe('[]')
      expect(render('[{{customer.constructor}}]', { contact: CONTACT }, { missing }), missing).toBe('[]')
    }
  })

  it('AC-T11-05 não lê propriedades herdadas do protótipo', () => {
    const vars = Object.create({ segredo: 'herdado' })
    vars.visivel = 'ok'
    expect(render('{visivel}|{segredo}|{toString}|{hasOwnProperty}', { vars })).toBe('ok|||')
    expect(render('{response.data.length}|{response.toString}', { vars: { response: { data: [1, 2] } } })).not.toMatch(/function|native code/)
  })

  it('AC-T11-05 __proto__ como chave própria (JSON) não vaza nem polui Object.prototype', () => {
    const vars = JSON.parse('{"__proto__": {"polluted": "sim"}, "response": {"__proto__": {"x": "vazou"}}}')
    expect(render('[{__proto__.polluted}][{response.__proto__.x}]', { vars })).toBe('[][]')
    expect(({} as any).polluted).toBeUndefined()
  })

  it('AC-T11-05 renderização não executa código', () => {
    const attacks = [
      "{constructor.constructor('globalThis.__t11_pwned = 1')()}",
      '{{constructor.constructor("globalThis.__t11_pwned = 1")()}}',
      '${globalThis.__t11_pwned = 1}',
      '{{ (globalThis.__t11_pwned = 1) }}',
      '{response.constructor.constructor}',
    ]
    for (const t of attacks) {
      const out = render(t, { contact: CONTACT, vars: { response: {} } })
      expect(out, t).not.toMatch(/function|native code|\[object/)
      expect((globalThis as any).__t11_pwned, t).toBeUndefined()
    }
  })

  it('AC-T11-05 funções no escopo não são chamadas (viram vazio)', () => {
    let called = 0
    const vars = { fn: () => (called++, 'executou'), response: { getter: () => (called++, 'x') } }
    expect(render('[{fn}][{response.getter}]', { vars })).toBe('[][]')
    expect(called).toBe(0)
  })
})
