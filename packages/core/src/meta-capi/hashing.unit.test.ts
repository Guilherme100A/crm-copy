import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildUserData, normalizeCapiCurrency, normalizeCapiEmail, normalizePhone, normalizeText, parseMoney } from './hashing'
import { CapiService } from './service'

const h = (v: string) => createHash('sha256').update(v).digest('hex')

describe('normalização e hash (AC-T104-01)', () => {
  it('telefone vira só dígitos com DDI; e-mail trim + minúsculas', () => {
    expect(normalizePhone('+55 (11) 99999-8888')).toBe('5511999998888')
    expect(normalizeCapiEmail('  Ana.Souza@Example.COM ')).toBe('ana.souza@example.com')
    const u = buildUserData({ phone: '+55 (11) 99999-8888', email: '  Ana.Souza@Example.COM ' })
    expect(u.ph).toEqual([h('5511999998888')])
    expect(u.em).toEqual([h('ana.souza@example.com')])
  })

  it('nome/cidade sem acento e minúsculas; vazios ficam de fora; técnicos em claro', () => {
    expect(normalizeText(' JOSÉ ')).toBe('jose')
    const u = buildUserData({ firstName: 'José', city: 'São Paulo', externalId: 'c1', phone: '', email: 'sem-arroba', fbp: 'fb.1.2.3' })
    expect(u.fn).toEqual([h('jose')])
    expect(u.ct).toEqual([h('saopaulo')])
    expect(u.external_id).toEqual([h('c1')])
    expect(u.fbp).toBe('fb.1.2.3')
    expect(u).not.toHaveProperty('ph')
    expect(u).not.toHaveProperty('em')
  })
})

describe('moeda e valor (AC-T104-03)', () => {
  it('moeda vazia ou inválida vira BRL', () => {
    expect(normalizeCapiCurrency('')).toBe('BRL')
    expect(normalizeCapiCurrency(null)).toBe('BRL')
    expect(normalizeCapiCurrency('reais')).toBe('BRL')
    expect(normalizeCapiCurrency('US')).toBe('BRL')
    expect(normalizeCapiCurrency(' usd ')).toBe('USD')
  })

  it('valor em texto livre', () => {
    expect(parseMoney('199,90')).toBe(199.9)
    expect(parseMoney('R$ 1.299,90')).toBe(1299.9)
    expect(parseMoney('1,299.90')).toBe(1299.9)
    expect(parseMoney('1299.9')).toBe(1299.9)
    expect(parseMoney('1.000.000')).toBe(1000000)
    expect(parseMoney(47)).toBe(47)
    expect(parseMoney('')).toBeNull()
    expect(parseMoney('{preco}')).toBeNull()
  })
})

describe('payload (AC-T104-05)', () => {
  const svc = new CapiService({ db: {} as never, pixels: {} as never, testEventCode: 'TEST1', isProduction: false, now: () => new Date('2026-10-16T12:00:00Z') })

  it('action_source chat/system_generated; business_messaging é recusado; sem campos de WABA', () => {
    const p = svc.buildPayload({ eventName: 'Purchase', eventId: 'e1', value: '10,50', currency: '', user: { phone: '+5511999998888' } })
    const ev = (p.data as Record<string, unknown>[])[0]!
    expect(ev).toMatchObject({ event_name: 'Purchase', event_id: 'e1', action_source: 'chat', event_time: 1792152000, custom_data: { currency: 'BRL', value: 10.5 } })
    expect(p.test_event_code).toBe('TEST1')
    const json = JSON.stringify(p)
    for (const f of ['business_messaging', 'messaging_channel', 'page_id', 'ctwa_clid', 'whatsapp']) expect(json).not.toContain(f)
    expect(() => svc.buildPayload({ eventName: 'Lead', eventId: 'e2', actionSource: 'business_messaging' as never })).toThrow(/action_source/)
    expect((svc.buildPayload({ eventName: 'Lead', eventId: 'e3', actionSource: 'system_generated' }).data as Record<string, unknown>[])[0]!.action_source).toBe('system_generated')
  })

  it('Compra exige valor; Lead não; test_event_code só fora de produção', () => {
    expect(() => svc.buildPayload({ eventName: 'Purchase', eventId: 'x', value: '' })).toThrow(/valor/)
    expect((svc.buildPayload({ eventName: 'Lead', eventId: 'y' }).data as Record<string, { value?: number }>[])[0]!.custom_data).toEqual({ currency: 'BRL' })
    const prod = new CapiService({ db: {} as never, pixels: {} as never, testEventCode: 'TEST1', isProduction: true })
    expect(prod.buildPayload({ eventName: 'Lead', eventId: 'z' })).not.toHaveProperty('test_event_code')
  })
})
