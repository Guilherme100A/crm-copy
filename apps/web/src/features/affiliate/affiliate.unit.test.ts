import { describe, expect, it } from 'vitest'
import { referralSearch } from '@/features/auth/register-route'
import { translate } from '@/i18n/core'
import { AFFILIATE_LINK_REL } from './affiliate-entry'
import { portalUrlOf } from './api'
import { pickReferral, REFERRAL_CODE_RE, validReferral } from './referral'

/** Mesmo caminho da rota: `validateSearch: referralSearch` e depois `pickReferral`. */
const fromQuery = (qs: string) => pickReferral(referralSearch.parse(Object.fromEntries(new URLSearchParams(qs))))

describe('AC-T97-01 captura de ?ref / ?via no cadastro', () => {
  it('ref tem precedência sobre via; só via usa via; sem query não envia', () => {
    expect(fromQuery('ref=a&via=b')).toBe('a')
    expect(fromQuery('via=b')).toBe('b')
    expect(fromQuery('')).toBeUndefined()
    expect(fromQuery('ref=&via=')).toBeUndefined()
  })
})

describe('AC-T97-02 código fora da regra é ignorado', () => {
  it('mais de 64 caracteres ou fora de [A-Za-z0-9_-] → ignorado', () => {
    expect(validReferral('a'.repeat(64))).toBe('a'.repeat(64))
    expect(validReferral('Ab_9-x')).toBe('Ab_9-x')
    for (const bad of [
      'a'.repeat(65),
      'a'.repeat(130),
      'a b',
      'a.b',
      'a/b',
      'çódigo',
      '<script>',
      'a%20b',
      '',
      42,
      null,
    ]) {
      expect(validReferral(bad)).toBeUndefined()
    }
    expect(fromQuery(`ref=${'x'.repeat(65)}`)).toBeUndefined()
    expect(fromQuery('ref=a%20b')).toBeUndefined()
  })

  it('ref inválido conta como ausente e cai para via (decisão do Orquestrador)', () => {
    expect(fromQuery(`ref=${'x'.repeat(65)}&via=b`)).toBe('b')
    expect(fromQuery('ref=a!b&via=ok_1')).toBe('ok_1')
    expect(fromQuery('ref=ok&via=a!b')).toBe('ok')
    expect(fromQuery('ref=a!b&via=c d')).toBeUndefined()
  })

  it('mesma regra do core (REFERRAL_CODE_RE)', () => {
    expect(REFERRAL_CODE_RE.source).toBe('^[A-Za-z0-9_-]{1,64}$')
  })
})

describe('AC-T97-03 item "Programa de afiliados"', () => {
  it('sem URL (null, ausente, inválida) não há item', () => {
    expect(portalUrlOf(undefined)).toBeNull()
    expect(portalUrlOf({ affiliate_portal_url: null })).toBeNull()
    expect(portalUrlOf({ affiliate_portal_url: '' })).toBeNull()
    expect(portalUrlOf({ affiliate_portal_url: 'javascript:alert(1)' })).toBeNull()
    expect(portalUrlOf({ affiliate_portal_url: 'nao-e-url' })).toBeNull()
  })

  it('com URL http/https mostra o item; o link abre em nova aba com rel=noopener', () => {
    expect(portalUrlOf({ affiliate_portal_url: 'https://parceiros.example.com/register' })).toBe(
      'https://parceiros.example.com/register',
    )
    expect(AFFILIATE_LINK_REL.split(' ')).toContain('noopener')
  })

  it('rótulo e texto do modal nas três línguas, com o nome do app', () => {
    expect(translate('pt-BR', 'affiliate:entry')).toBe('Programa de afiliados')
    for (const locale of ['pt-BR', 'en', 'es'] as const) {
      const body = translate(locale, 'affiliate:modal.body', { app: 'Acme' })
      expect(body).toContain('Acme')
    }
  })
})
