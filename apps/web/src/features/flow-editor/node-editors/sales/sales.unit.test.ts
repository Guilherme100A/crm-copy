import { describe, expect, it, vi, afterEach } from 'vitest'
import { blockProductsQuery } from '@/features/settings-payments/api'
import { translate } from '@/i18n/core'
import { api } from '@/lib/http'
import { collectNodeEditors } from '../registry'
import { setField, validateConfig } from '../logic/rules'
import * as group from './index'
import {
  APPROVED_SALE_ACTION,
  appendVariable,
  defaultApprovedSaleConfig,
  NEW_PRODUCT,
  optionalIdValue,
  PUSH_VARIABLES,
  withOptionalId,
} from './sales-rules'

afterEach(() => vi.restoreAllMocks())

describe('AC-T114-04 editor do bloco Venda aprovada', () => {
  it('bloco novo: templates do comprovante, sem emissor e sem UTMify; produto obrigatório', () => {
    const c = defaultApprovedSaleConfig()
    expect(c).toMatchObject({
      amount_template: '{comprovante.valor}',
      currency_template: '{comprovante.currency}',
      customer_name_template: '{comprovante.nome_pagador}',
      note_issuer_id: null,
      utmify_integration_id: null,
    })
    expect(validateConfig(APPROVED_SALE_ACTION, c)).toMatchObject({ product_public_id: { key: 'required' } })
    expect(validateConfig(APPROVED_SALE_ACTION, setField(c, 'product_public_id', 'prd_abc'))).toEqual({})
  })

  it('"Não emitir nota automaticamente" / "Não enviar para UTMify" gravam null; escolher grava o id', () => {
    const c = withOptionalId(
      withOptionalId(defaultApprovedSaleConfig(), 'note_issuer_id', 'inv1'),
      'utmify_integration_id',
      'ut1',
    )
    expect(c).toMatchObject({ note_issuer_id: 'inv1', utmify_integration_id: 'ut1' })
    expect(optionalIdValue(c, 'note_issuer_id')).toBe('inv1')
    const off = withOptionalId(withOptionalId(c, 'note_issuer_id', ''), 'utmify_integration_id', '')
    expect(off).toMatchObject({ note_issuer_id: null, utmify_integration_id: null })
    expect(optionalIdValue(off, 'note_issuer_id')).toBe('')
    expect(validateConfig(APPROVED_SALE_ACTION, setField(off, 'product_public_id', 'prd_abc'))).toEqual({})
    for (const locale of ['pt-BR', 'en', 'es'] as const) {
      expect(translate(locale, 'settings-payments:block.sale.noIssuer')).not.toMatch(/block\.sale/)
      expect(translate(locale, 'settings-payments:block.sale.noUtmify')).not.toMatch(/block\.sale/)
    }
    expect(translate('pt-BR', 'settings-payments:block.sale.noIssuer')).toBe('Não emitir nota automaticamente')
    expect(translate('pt-BR', 'settings-payments:block.sale.noUtmify')).toBe('Não enviar para UTMify')
  })

  it('"+ Criar novo produto…" é uma opção que não vai para a config; os produtos usam o `public_id`', async () => {
    expect(NEW_PRODUCT).toBe('__new__')
    expect(translate('pt-BR', 'settings-payments:block.sale.newProduct')).toBe('+ Criar novo produto…')
    const get = vi
      .spyOn(api, 'get')
      .mockResolvedValue({ items: [{ id: 'p1', public_id: 'prd_1', name: 'Curso', currency: 'BRL' }] } as never)
    const r = await (blockProductsQuery().queryFn as unknown as () => Promise<{ items: { public_id: string }[] }>)()
    expect(r.items[0]!.public_id).toBe('prd_1')
    expect(get).toHaveBeenCalledWith('/api/products')
    // Mesma raiz de chave da T90: o ProductDialog invalida `settings-products` e a lista do bloco recarrega.
    expect(blockProductsQuery().queryKey[0]).toBe('settings-products')
  })

  it('push com as variáveis da venda', () => {
    expect(PUSH_VARIABLES).toEqual(['produto.nome', 'venda.valor', 'venda.moeda', 'venda.cliente'])
    expect(appendVariable('', 'venda.valor')).toBe('{venda.valor}')
    expect(appendVariable('Venda de', 'produto.nome')).toBe('Venda de {produto.nome}')
    // As chaves com ponto não são interpoladas pelo i18n.
    expect(translate('pt-BR', 'settings-payments:block.payment.openNotice', { gateway: 'x' })).toContain(
      '{gateway.value}',
    )
  })

  it('o grupo `sales/` registra o editor do tipo `approved_sale` pelo glob', () => {
    expect(Object.keys(collectNodeEditors({ './sales/index.ts': group }))).toEqual(['approved_sale'])
  })
})
