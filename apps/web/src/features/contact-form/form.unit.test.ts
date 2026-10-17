import { describe, expect, it } from 'vitest'
import {
  BR_STATES,
  COUNTRIES,
  DUPLICATE_SEARCH_DEBOUNCE_MS,
  DUPLICATE_SEARCH_LIMIT,
  duplicateSearchTerm,
  emptyForm,
  filterConnections,
  flagOf,
  formFromContact,
  formFromTerm,
  maskZip,
  serverFieldErrors,
  splitPhone,
  toContactBody,
  validateForm,
  validatePhone,
  withState,
  zipValid,
  type ContactFormValues,
} from './form'

const filled = (patch: Partial<ContactFormValues> = {}): ContactFormValues => ({
  ...emptyForm(),
  name: 'Ana',
  phone: '11999998888',
  ...patch,
})

describe('busca prévia de duplicados (AC-T86-01)', () => {
  it('só busca a partir de 2 caracteres (aparados), com debounce de 450 ms e 15 resultados', () => {
    expect(DUPLICATE_SEARCH_DEBOUNCE_MS).toBe(450)
    expect(DUPLICATE_SEARCH_LIMIT).toBe(15)
    expect(duplicateSearchTerm('')).toBeNull()
    expect(duplicateSearchTerm(' a ')).toBeNull()
    expect(duplicateSearchTerm(' an ')).toBe('an')
    expect(duplicateSearchTerm('Ana Souza')).toBe('Ana Souza')
  })

  it('"Criar novo contato" leva o termo para o campo certo', () => {
    expect(formFromTerm('Ana Souza')).toMatchObject({ name: 'Ana Souza', phone: '', email: '' })
    expect(formFromTerm('ana@ex.com')).toMatchObject({ name: '', email: 'ana@ex.com' })
    expect(formFromTerm('(11) 99999-8888')).toMatchObject({ name: '', phone: '11999998888', country: 'BR' })
    expect(formFromTerm('+351 912 345 678')).toMatchObject({ country: 'PT', phone: '912345678' })
    expect(formFromTerm('12')).toMatchObject({ name: '12' })
  })
})

describe('telefone com país e E.164 (AC-T86-02)', () => {
  it('BR: DDD + número (10–11 dígitos) vira E.164', () => {
    expect(validatePhone('BR', '(11) 99999-8888')).toEqual({ ok: true, e164: '+5511999998888' })
    expect(validatePhone('BR', '1133334444')).toEqual({ ok: true, e164: '+551133334444' })
    expect(validatePhone('BR', '999998888')).toEqual({ ok: false, error: 'short' })
    expect(validatePhone('BR', '119999988881')).toEqual({ ok: false, error: 'long' })
    expect(validatePhone('BR', '')).toEqual({ ok: false, error: 'required' })
    expect(validatePhone('BR', 'abc')).toEqual({ ok: false, error: 'invalid' })
  })

  it('outros países usam o DDI escolhido; número inválido para o país é recusado', () => {
    expect(validatePhone('US', '202 555 0143')).toEqual({ ok: true, e164: '+12025550143' })
    expect(validatePhone('PT', '912345678')).toEqual({ ok: true, e164: '+351912345678' })
    expect(validatePhone('PT', '000000000')).toEqual({ ok: false, error: 'invalid' })
    expect(validatePhone('US', '12345')).toEqual({ ok: false, error: 'short' })
  })

  it('com "+" vale o DDI digitado; LID do WhatsApp passa como está (modo ID)', () => {
    expect(validatePhone('BR', '+1 202 555 0143')).toEqual({ ok: true, e164: '+12025550143' })
    expect(validatePhone('US', '+55 11 99999-8888')).toEqual({ ok: true, e164: '+5511999998888' })
    expect(validatePhone('BR', '123456789012@lid')).toEqual({ ok: true, lid: '123456789012@lid' })
  })

  it('detecta o DDI ao editar (o mais longo que casar; +1 fica com US)', () => {
    expect(splitPhone('+5511999998888')).toEqual({ country: 'BR', national: '11999998888' })
    expect(splitPhone('+351912345678')).toEqual({ country: 'PT', national: '912345678' })
    expect(splitPhone('+12025550143')).toEqual({ country: 'US', national: '2025550143' })
    expect(splitPhone(null)).toEqual({ country: 'BR', national: '' })
    expect(splitPhone('+80012345678')).toEqual({ country: 'BR', national: '+80012345678' })
  })

  it('lista de países: BR primeiro, códigos únicos e bandeira', () => {
    expect(COUNTRIES[0]).toEqual({ code: 'BR', dial: '55' })
    expect(new Set(COUNTRIES.map((c) => c.code)).size).toBe(COUNTRIES.length)
    expect(flagOf('BR')).toBe('🇧🇷')
  })
})

describe('UF, cidade e CEP (AC-T86-02)', () => {
  it('27 UFs; trocar a UF limpa a cidade (mesma UF mantém)', () => {
    expect(BR_STATES).toHaveLength(27)
    expect(BR_STATES).toContain('DF')
    const v = filled({ state: 'SP', city: 'Campinas' })
    expect(withState(v, 'SP')).toBe(v)
    expect(withState(v, 'RJ')).toMatchObject({ state: 'RJ', city: '' })
    expect(withState(v, '')).toMatchObject({ state: '', city: '' })
  })

  it('CEP com máscara 00000-000, enviado sem hífen', () => {
    expect(maskZip('01310100')).toBe('01310-100')
    expect(maskZip('01310-1009999')).toBe('01310-100')
    expect(maskZip('0131')).toBe('0131')
    expect(maskZip('a1b2')).toBe('12')
    expect(zipValid('')).toBe(true)
    expect(zipValid('01310-100')).toBe(true)
    expect(zipValid('0131')).toBe(false)
    expect(toContactBody(filled({ zip: '01310-100' }), 'create').zip).toBe('01310100')
  })
})

describe('validação e corpo da API (AC-T86-02)', () => {
  it('salvar fica bloqueado enquanto inválido', () => {
    expect(validateForm(filled())).toEqual({})
    expect(validateForm(emptyForm())).toEqual({ name: 'nameRequired', phone: 'phone.required' })
    expect(validateForm(filled({ email: 'x@', zip: '123' }))).toEqual({ email: 'email', zip: 'zip' })
  })

  it('criação: E.164, etiquetas, campos personalizados sem linhas de nome vazio, vazios omitidos', () => {
    const body = toContactBody(
      filled({
        name: '  Ana  ',
        email: ' ana@ex.com ',
        state: 'SP',
        city: 'Campinas',
        labelIds: ['l1', 'l2'],
        customFields: [
          { key: ' origem ', value: 'site' },
          { key: '  ', value: 'descartada' },
        ],
      }),
      'create',
    )
    expect(body).toEqual({
      name: 'Ana',
      phone: '+5511999998888',
      email: 'ana@ex.com',
      state: 'SP',
      city: 'Campinas',
      label_ids: ['l1', 'l2'],
      custom_fields: { origem: 'site' },
    })
  })

  it('edição: vazios viram null (limpam) e entram os dados do anúncio; LID vai em wa_lid', () => {
    const body = toContactBody(filled({ phone: '123456789012@lid', ctwaClid: 'abc' }), 'edit')
    expect(body).toMatchObject({
      wa_lid: '123456789012@lid',
      email: null,
      state: null,
      city: null,
      zip: null,
      ctwa_clid: 'abc',
      source_id: null,
      source_url: null,
    })
    expect(body).not.toHaveProperty('phone')
  })

  it('formulário a partir do contato salvo (ida e volta)', () => {
    const v = formFromContact({
      id: 'c1',
      name: 'Ana',
      phone_e164: '+5511999998888',
      wa_lid: null,
      email: null,
      state: 'SP',
      city: 'Campinas',
      zip: '01310100',
      custom_fields: { origem: 'site', n: 3 },
      labels: [{ id: 'l1', name: 'VIP', color: null }],
      ctwa_clid: 'x',
    })
    expect(v).toMatchObject({ country: 'BR', phone: '11999998888', zip: '01310-100', labelIds: ['l1'], ctwaClid: 'x' })
    expect(v.customFields).toEqual([
      { key: 'origem', value: 'site' },
      { key: 'n', value: '3' },
    ])
    expect(
      formFromContact({
        id: 'c2',
        name: 'B',
        phone_e164: null,
        wa_lid: '999999@lid',
        email: null,
        state: null,
        city: null,
        zip: null,
        custom_fields: null,
        labels: [],
      }).phone,
    ).toBe('999999@lid')
  })

  it('erros 422 do servidor vão para o campo; o resto para o erro geral', () => {
    const r = serverFieldErrors({
      fields: [
        { path: 'phone', message: 'Telefone inválido' },
        { path: 'state', message: 'UF inválida' },
        { path: 'zip', message: 'CEP deve ter 8 dígitos' },
        { path: 'opt_out', message: 'Outro' },
      ],
    })
    expect(r.fields).toEqual({ phone: 'Telefone inválido', state: 'UF inválida', zip: 'CEP deve ter 8 dígitos' })
    expect(r.other).toEqual(['Outro'])
    expect(serverFieldErrors(undefined)).toEqual({ fields: {}, other: [] })
  })
})

describe('abrir conversa (AC-T86-02)', () => {
  it('busca de conexões por nome, telefone ou status', () => {
    const conns = [
      { id: 'a', name: 'Vendas', status: 'connected', phone: '+5511' },
      { id: 'b', name: 'Suporte', status: 'pending' },
    ]
    expect(filterConnections(conns, '').map((c) => c.id)).toEqual(['a', 'b'])
    expect(filterConnections(conns, 'sup').map((c) => c.id)).toEqual(['b'])
    expect(filterConnections(conns, 'CONNECTED').map((c) => c.id)).toEqual(['a'])
    expect(filterConnections(conns, '5511').map((c) => c.id)).toEqual(['a'])
  })
})
