// AC-T123-03 — alias {{customer.name}} = nome completo do contato, sem mudar as variáveis existentes (T11).
import * as core from '@crm/core'
import { describe, expect, it } from 'vitest'
import { exec, tail } from '../helpers/exec'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const render = (t: string, scope: Record<string, unknown> = {}, opts: Record<string, unknown> = {}) => (core as any).render(t, scope, opts)
const CONTACT = { full_name: 'Maria da Silva', phone_number: '+5511999998888', email: 'maria@example.com', custom_fields: { plano: 'Anual' } }

describe('T123 — alias customer.name', () => {
  it('AC-T123-03 {{customer.name}} renderiza o nome completo do contato (com e sem espaços no token)', () => {
    expect(render('Olá {{customer.name}}!', { contact: CONTACT })).toBe('Olá Maria da Silva!')
    expect(render('{{ customer.name }}', { contact: CONTACT })).toBe('Maria da Silva')
    expect(render('{{customer.name}} / {{customer.full_name}} / {full_name} / {first_name}', { contact: CONTACT })).toBe('Maria da Silva / Maria da Silva / Maria da Silva / Maria')
    // contato sem nome: vazio (padrão) ou token mantido
    expect(render('a{{customer.name}}b', { contact: { phone_number: '+5511999998888' } })).toBe('ab')
    expect(render('a{{customer.name}}b', { contact: {} }, { missing: 'keep' })).toBe('a{{customer.name}}b')
    // as outras variáveis continuam iguais
    expect(render('{{customer.plano}} {phone_number}', { contact: CONTACT })).toBe('Anual +5511999998888')
  })

  it('AC-T123-03 {name} solto também vira o nome completo; o alias só vale quando nada mais resolve', () => {
    expect(render('Oi {name}', { contact: CONTACT })).toBe('Oi Maria da Silva')
    // variável do run vem antes do contato (como no render da T11)
    expect(render('Oi {name}', { contact: CONTACT, vars: { name: 'Variável do fluxo' } })).toBe('Oi Variável do fluxo')
    // campo personalizado 'name' já existente continua vencendo o alias
    const withField = { ...CONTACT, custom_fields: { name: 'Apelido' } }
    expect(render('{{customer.name}} / {name}', { contact: withField })).toBe('Apelido / Apelido')
    // propriedade 'name' do próprio contato vence o campo personalizado
    expect(render('{{customer.name}}', { contact: { ...withField, name: 'Nome do objeto' } })).toBe('Nome do objeto')
  })

  it('AC-T123-03 os testes de templating da T11 continuam passando sem alteração', () => {
    // caminho exato: o filtro por prefixo 'T11' também pegaria T117/T118/T119
    const r = exec('pnpm exec vitest run --config tests/acceptance/vitest.config.ts tests/acceptance/T11/templating.test.ts', { timeoutMs: 240_000 })
    expect(r.code, tail(r, 60)).toBe(0)
    expect(r.output).toMatch(/Tests\s+\d+ passed/)
    expect(r.output).not.toMatch(/\d+ failed/)
  }, 300_000)
})
