// Revisão 3 (rastreamento Meta): normalização e payload conferidos campo a campo contra a doc oficial.
// - https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters
// - https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/server-event
// - https://developers.facebook.com/docs/marketing-api/conversions-api/business-messaging
// - https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/fbp-and-fbc
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildUserData, matchScore, normalizeCity, normalizePhone, normalizeState, normalizeText, normalizeZip, resolveCountry } from './hashing'
import { CapiService } from './service'
import { extractTrackingCode, fbcFromFbclid, trackingSuffix } from './tracked-links'

const h = (v: string) => createHash('sha256').update(v).digest('hex')

describe('normalização da doc (customer-information-parameters)', () => {
  it('fn/ln sem pontuação nem acento; ct sem espaços; ph sem zeros à esquerda', () => {
    expect(normalizeText("D'Ávila-Souza Jr.")).toBe('davilasouza jr')
    expect(normalizeText('  MARIA   CLARA ')).toBe('maria clara')
    expect(normalizeText('O’Brien')).toBe('obrien')
    expect(normalizeCity('São José dos Campos')).toBe('saojosedoscampos')
    expect(normalizeCity("Santa Bárbara d'Oeste")).toBe('santabarbaradoeste')
    expect(normalizePhone('0055 11 99999-8888')).toBe('5511999998888')
    expect(normalizePhone('+351 912 345 678')).toBe('351912345678')
  })

  it('st: UF minúscula (nome por extenso vira UF no Brasil); zp sem hífen; EUA: 5 dígitos', () => {
    expect(normalizeState('SP', 'br')).toBe('sp')
    expect(normalizeState('São Paulo', 'br')).toBe('sp')
    expect(normalizeState('Rio Grande do Sul', 'br')).toBe('rs')
    expect(normalizeState('AZ', 'us')).toBe('az')
    expect(normalizeState('Île-de-France', 'fr')).toBe('iledefrance')
    expect(normalizeZip('01310-100', 'br')).toBe('01310100')
    expect(normalizeZip('94025-1234', 'us')).toBe('94025')
    expect(normalizeZip('M1 1AE', 'gb')).toBe('m11ae')
  })

  it('country: DDI do telefone (55→br, 1→us, 351→pt); sem DDI reconhecível → padrão do pixel → br', () => {
    expect(resolveCountry('+5511999998888')).toBe('br')
    expect(resolveCountry('+12025550123')).toBe('us')
    expect(resolveCountry('+351912345678')).toBe('pt')
    expect(resolveCountry('+541123456789')).toBe('ar')
    expect(resolveCountry(null, 'PT')).toBe('pt')
    expect(resolveCountry('', null)).toBe('br')
  })

  it('user_data com country/st/zp hasheados; country sempre presente', () => {
    const u = buildUserData({ phone: '+351 912 345 678', state: 'Lisboa', zip: '1000-001', firstName: 'Zé-Maria', city: 'Lisboa' })
    expect(u.country).toEqual([h('pt')])
    expect(u.st).toEqual([h('lisboa')])
    expect(u.zp).toEqual([h('1000001')])
    expect(u.fn).toEqual([h('zemaria')])
    expect(buildUserData({}).country).toEqual([h('br')])
    expect(buildUserData({ defaultCountry: 'us' }).country).toEqual([h('us')])
    // ctwa_clid nunca vai no user_data do modo padrão.
    expect(buildUserData({ ctwaClid: 'abc' })).not.toHaveProperty('ctwa_clid')
  })

  it('pontuação de correspondência: identificadores fortes (IP + UA contam como um)', () => {
    expect(matchScore({ ph: [1], em: [1], country: [1] })).toBe(2)
    expect(matchScore({ ph: [1], fbc: 'x', fbp: 'y', client_ip_address: '1.2.3.4', client_user_agent: 'ua' })).toBe(4)
    expect(matchScore({ client_ip_address: '1.2.3.4' })).toBe(0)
  })
})

describe('payload (AC-T104-05, revisão 3)', () => {
  const svc = new CapiService({ db: {} as never, pixels: {} as never, testEventCode: 'TEST1', isProduction: false, now: () => new Date('2026-10-16T12:00:00Z') })
  const first = (p: Record<string, unknown>) => (p.data as Record<string, unknown>[])[0]!

  it('modo padrão: action_source chat/system_generated, sem campos de business messaging', () => {
    const p = svc.buildPayload({ eventName: 'Purchase', eventId: 'e1', value: '10,50', currency: '', user: { phone: '+5511999998888', ctwaClid: 'CLID' } })
    const ev = first(p)
    expect(Object.keys(ev).sort()).toEqual(['action_source', 'custom_data', 'event_id', 'event_name', 'event_time', 'user_data'])
    expect(ev).toMatchObject({ event_name: 'Purchase', event_id: 'e1', action_source: 'chat', event_time: 1792152000, custom_data: { currency: 'BRL', value: 10.5 } })
    expect(Object.keys(ev.user_data as object).sort()).toEqual(['country', 'ph'])
    expect(p.test_event_code).toBe('TEST1')
    const json = JSON.stringify(p)
    for (const f of ['business_messaging', 'messaging_channel', 'page_id', 'ctwa_clid', 'whatsapp']) expect(json).not.toContain(f)
    // business_messaging não é aceito como action_source direto: só pelo alvo (pixel com WABA/Página + ctwa_clid).
    expect(() => svc.buildPayload({ eventName: 'Lead', eventId: 'e2', actionSource: 'business_messaging' as never })).toThrow(/action_source/)
    expect(first(svc.buildPayload({ eventName: 'Lead', eventId: 'e3', actionSource: 'system_generated' })).action_source).toBe('system_generated')
  })

  it('modo business_messaging (WhatsApp): campos exatos da doc; Lead → LeadSubmitted', () => {
    const clid = 'ARAkLkA8rmlFeiCktEJQ-QTwRiyYHAFDLMNDBH0CD3qpjd0HR4irJ6LEkR7JwFF4XvnO2E4Nx0-eM-GABDLOPaOdRMv-_zfUQ2a'
    const ev = first(svc.buildPayload({ eventName: 'Lead', eventId: 'e4', user: { phone: '+5511999998888', email: 'a@b.com', ctwaClid: clid } }, { businessMessaging: { wabaId: '104996122399160', pageId: '123456' } }))
    expect(Object.keys(ev).sort()).toEqual(['action_source', 'custom_data', 'event_id', 'event_name', 'event_time', 'messaging_channel', 'user_data'])
    expect(ev).toMatchObject({ event_name: 'LeadSubmitted', action_source: 'business_messaging', messaging_channel: 'whatsapp', event_id: 'e4', event_time: 1792152000 })
    // Com WABA: só whatsapp_business_account_id + ctwa_clid (como no exemplo da doc), em claro.
    expect(ev.user_data).toEqual({ whatsapp_business_account_id: '104996122399160', ctwa_clid: clid })
    // Só Página (paridade Leona, não confirmado pela doc): page_id + ctwa_clid.
    const pg = first(svc.buildPayload({ eventName: 'Purchase', eventId: 'e5', value: 10, user: { ctwaClid: 'C1' } }, { businessMessaging: { pageId: '123456' } }))
    expect(pg).toMatchObject({ event_name: 'Purchase', action_source: 'business_messaging', user_data: { page_id: '123456', ctwa_clid: 'C1' }, custom_data: { currency: 'BRL', value: 10 } })
  })

  it('business_messaging só com ctwa_clid e evento suportado; senão modo padrão', () => {
    const target = { businessMessaging: { wabaId: '1049961223' } }
    expect(first(svc.buildPayload({ eventName: 'Lead', eventId: 'x1', user: {} }, target)).action_source).toBe('chat')
    expect(first(svc.buildPayload({ eventName: 'Schedule', eventId: 'x2', user: { ctwaClid: 'C' } }, target))).toMatchObject({ event_name: 'Schedule', action_source: 'chat' })
    expect(first(svc.buildPayload({ eventName: 'AddToCart', eventId: 'x3', user: { ctwaClid: 'C' } }, target))).toMatchObject({ event_name: 'AddToCart', action_source: 'business_messaging' })
  })

  it('Compra exige valor; outros eventos com valor/moeda opcionais; test_event_code do pixel vale em produção', () => {
    expect(() => svc.buildPayload({ eventName: 'Purchase', eventId: 'x', value: '' })).toThrow(/valor/)
    expect(first(svc.buildPayload({ eventName: 'Lead', eventId: 'y' })).custom_data).toEqual({ currency: 'BRL' })
    expect(first(svc.buildPayload({ eventName: 'InitiateCheckout', eventId: 'y2', value: '49,90', currency: 'usd' })).custom_data).toEqual({ currency: 'USD', value: 49.9 })
    for (const name of ['AddToCart', 'CompleteRegistration', 'Contact', 'Schedule', 'Subscribe'] as const) expect(first(svc.buildPayload({ eventName: name, eventId: `n-${name}` })).event_name).toBe(name)
    const prod = new CapiService({ db: {} as never, pixels: {} as never, testEventCode: 'TEST1', isProduction: true })
    expect(prod.buildPayload({ eventName: 'Lead', eventId: 'z' })).not.toHaveProperty('test_event_code')
    expect(prod.buildPayload({ eventName: 'Lead', eventId: 'z2' }, { testEventCode: prod.testEventCodeFor({ testEventCode: 'PIX9' }) }).test_event_code).toBe('PIX9')
    expect(prod.testEventCodeFor({ testEventCode: null })).toBeNull()
  })

  it('bmTargetFor: sem ids → null; recusa recente → null; depois de 24 h → tenta de novo', () => {
    const now = new Date('2026-10-16T12:00:00Z')
    const base = { pageId: null, whatsappBusinessAccountId: '1049961223', bmStatus: null, bmCheckedAt: null }
    expect(svc.bmTargetFor({ ...base, whatsappBusinessAccountId: null }, 'Lead', 'C')).toBeNull()
    expect(svc.bmTargetFor(base, 'Lead', null)).toBeNull()
    expect(svc.bmTargetFor(base, 'Lead', 'C')).toEqual({ wabaId: '1049961223', pageId: null })
    expect(svc.bmTargetFor({ ...base, bmStatus: 'rejected', bmCheckedAt: new Date(now.getTime() - 3600_000) }, 'Lead', 'C')).toBeNull()
    expect(svc.bmTargetFor({ ...base, bmStatus: 'rejected', bmCheckedAt: new Date(now.getTime() - 25 * 3600_000) }, 'Lead', 'C')).not.toBeNull()
  })
})

describe('link rastreável: código e fbc (fbp-and-fbc)', () => {
  it('fbc = fb.1.<ms>.<fbclid> sem mudar a caixa', () => {
    expect(fbcFromFbclid('IwAR2F4-dbP0l7Mn1IawQQGCINEz7PYXQvwjNwB_qa2ofrHyiLjcbCRxTDMgk', new Date(1554763694565))).toBe(
      'fb.1.1554763694565.IwAR2F4-dbP0l7Mn1IawQQGCINEz7PYXQvwjNwB_qa2ofrHyiLjcbCRxTDMgk',
    )
  })

  it('extrai o código em qualquer ponto e devolve o texto limpo', () => {
    expect(trackingSuffix('ABC234')).toBe('(ref ABC234)')
    expect(extractTrackingCode('Olá, quero saber mais (ref ABC234)')).toEqual({ code: 'ABC234', cleaned: 'Olá, quero saber mais' })
    expect(extractTrackingCode('(ref: abc234) oi')).toEqual({ code: 'ABC234', cleaned: 'oi' })
    expect(extractTrackingCode('sem código')).toBeNull()
    expect(extractTrackingCode('(ref ABC10O)')).toBeNull()
  })
})
