// Revisão 3 (rastreamento Meta): regras puras das telas novas — campos opcionais do pixel, links rastreáveis, sub-rotas
// e as vendas de atribuição provável (fora das colunas <APP>/Meta sem o filtro explícito).
import { describe, expect, it } from 'vitest'
import type { BundleRow } from './api'
import { allowedSubs, applyProbable, pixelHasAdMessaging, probableSales, suggestSlug, trackedLinkUrl, validatePixelExtras, validateTrackedLink } from './rules'

describe('rastreamento Meta (revisão 3)', () => {
  it('sub-rotas Eventos enviados e Links rastreáveis exigem facebook.pixel', () => {
    expect(allowedSubs({ isOwner: false, perms: new Set(['facebook.pixel']) } as never)).toEqual(['pixel', 'events', 'links'])
    expect(allowedSubs({ isOwner: false, perms: new Set(['facebook.profiles']) } as never)).toEqual(['profiles'])
  })

  it('pixel: Página/WABA só dígitos, código de teste sem espaço, país ISO', () => {
    const ok = { page_id: '105222333444555', whatsapp_business_account_id: '', test_event_code: 'TEST123', default_country: 'br' }
    expect(validatePixelExtras(ok)).toEqual({})
    expect(validatePixelExtras({ ...ok, page_id: '12a', whatsapp_business_account_id: 'x', test_event_code: 'com espaço', default_country: 'bra' })).toEqual({
      page_id: 'digits',
      whatsapp_business_account_id: 'digits',
      test_event_code: 'test_code',
      default_country: 'country',
    })
    expect(pixelHasAdMessaging({ page_id: '1' })).toBe(true)
    expect(pixelHasAdMessaging({ page_id: null, whatsapp_business_account_id: null })).toBe(false)
  })

  it('link: destino obrigatório (conexão ou número), slug, janela', () => {
    const base = { name: 'Promo', slug: '', connection_id: 'c1', phone: '', message: '', match_window_minutes: '10' }
    expect(validateTrackedLink(base)).toEqual({})
    expect(validateTrackedLink({ ...base, connection_id: '', slug: 'A B', match_window_minutes: '0' })).toEqual({ destination: 'required', slug: 'slug', match_window_minutes: 'window' })
    expect(validateTrackedLink({ ...base, connection_id: '', phone: '5511999998888' })).toEqual({})
    expect(suggestSlug('Black Friday — Ação!')).toBe('black-friday-acao')
    expect(trackedLinkUrl('https://crm.exemplo.com/', '/api/w/promo')).toBe('https://crm.exemplo.com/api/w/promo')
  })

  it('prováveis só somam com o filtro ligado', () => {
    const row = { id: 'c1', metrics: { purchases_leona: 2, purchase_value_leona: 100, purchase_value_leona_display: 100, purchases_leona_probable: 1, purchase_value_leona_probable: 50, purchase_value_leona_probable_display: 50 } } as unknown as BundleRow
    expect(applyProbable(row, false)).toBe(row)
    expect(applyProbable(row, true).metrics).toMatchObject({ purchases_leona: 3, purchase_value_leona: 150, purchase_value_leona_display: 150 })
    expect(probableSales([row, row])).toBe(2)
  })
})
