import { nodeHandles, PAYMENT_GATEWAYS } from '@crm/shared/flows'
import { describe, expect, it } from 'vitest'
import { translate } from '@/i18n/core'
import { collectNodeEditors } from '../registry'
import { validateConfig } from '../logic/rules'
import * as group from './index'
import {
  cleanPayment,
  currenciesOf,
  defaultPaymentConfig,
  EDITOR_GATEWAYS,
  isColombianMobile,
  methodsOf,
  openAmountAllowed,
  PAYMENT_ACTION,
  payerFields,
  withCurrency,
  withGateway,
  withMethod,
  withOpenAmount,
} from './payment-rules'

const cfg = (over: Record<string, unknown> = {}) => ({
  ...defaultPaymentConfig(),
  payment_integration_id: 'pi_1',
  ...over,
})

describe('AC-T114-03 editor do bloco Pagamento: matriz gateway × moeda × método', () => {
  it('só a XPag é oferecida (Zenith fora de escopo) e ela está no enum do schema', () => {
    expect(EDITOR_GATEWAYS).toEqual(['xpag'])
    for (const g of EDITOR_GATEWAYS) expect(PAYMENT_GATEWAYS).toContain(g)
  })

  it('moedas e métodos da XPag iguais ao core (XPAG_SUPPORT): BRL PIX, MXN SPEI/OXXO, COP Nequi/Bre-B, ARS transferência', () => {
    expect(currenciesOf('xpag')).toEqual(['BRL', 'MXN', 'COP', 'ARS'])
    expect(methodsOf('xpag', 'BRL')).toEqual(['PIX'])
    expect(methodsOf('xpag', 'MXN')).toEqual(['SPEI', 'OXXO'])
    expect(methodsOf('xpag', 'COP')).toEqual(['NEQUI', 'BREB'])
    expect(methodsOf('xpag', 'ARS')).toEqual(['BANK_TRANSFER'])
    expect(methodsOf('xpag', 'USD')).toEqual([])
    expect(currenciesOf('zenith')).toEqual([])
  })

  it('trocar moeda leva o método ao primeiro válido; trocar gateway desmarca a chave', () => {
    const mx = withCurrency(cfg(), 'MXN')
    expect(mx).toMatchObject({ currency: 'MXN', method: 'SPEI' })
    expect(withCurrency(withMethod(mx, 'OXXO'), 'MXN').method).toBe('OXXO')
    expect(withCurrency(mx, 'COP')).toMatchObject({ currency: 'COP', method: 'NEQUI' })
    expect(withGateway(cfg({ currency: 'COP', method: 'BREB' }), 'xpag')).toMatchObject({
      gateway: 'xpag',
      payment_integration_id: '',
      currency: 'BRL',
      method: 'PIX',
    })
  })

  it('combinação fora da matriz bloqueia o salvamento no campo certo', () => {
    expect(validateConfig(PAYMENT_ACTION, cfg())).toEqual({})
    expect(validateConfig(PAYMENT_ACTION, cfg({ currency: 'USD' }))).toMatchObject({ currency: { key: 'invalid' } })
    expect(validateConfig(PAYMENT_ACTION, cfg({ currency: 'BRL', method: 'OXXO' }))).toMatchObject({
      method: { key: 'invalid' },
    })
    expect(validateConfig(PAYMENT_ACTION, cfg({ gateway: 'zenith', method: 'pix' }))).toMatchObject({
      gateway: { key: 'invalid' },
    })
    expect(validateConfig(PAYMENT_ACTION, cfg({ payment_integration_id: '' }))).toMatchObject({
      payment_integration_id: { key: 'required' },
    })
  })
})

describe('AC-T114-03 campos condicionais por método', () => {
  it('pagador por método: PIX/SPEI nome+documento, OXXO nome+e-mail, COP celular, ARS nome+documento+tipo', () => {
    expect(payerFields('xpag', 'BRL', 'PIX')).toEqual(['name', 'document'])
    expect(payerFields('xpag', 'MXN', 'SPEI')).toEqual(['name', 'document'])
    expect(payerFields('xpag', 'MXN', 'OXXO')).toEqual(['name', 'email'])
    expect(payerFields('xpag', 'COP', 'NEQUI')).toEqual(['phone'])
    expect(payerFields('xpag', 'ARS', 'BANK_TRANSFER')).toEqual(['name', 'document', 'document_type'])
  })

  it('a troca limpa os campos que somem e preenche a variável padrão dos que aparecem', () => {
    const cop = withCurrency(cfg({ document: '123', email: 'a@b.c' }), 'COP')
    expect(cop).not.toHaveProperty('name')
    expect(cop).not.toHaveProperty('document')
    expect(cop).not.toHaveProperty('email')
    expect(cop.phone).toBe('{phone_number}')
    const ars = withCurrency(cop, 'ARS')
    expect(ars).not.toHaveProperty('phone')
    expect(ars.name).toBe('{full_name}')
  })

  it('"chave sem valor": só BRL e MXN SPEI; ARS e COP exigem valor; OXXO também', () => {
    expect(openAmountAllowed('xpag', 'BRL', 'PIX')).toBe(true)
    expect(openAmountAllowed('xpag', 'MXN', 'SPEI')).toBe(true)
    expect(openAmountAllowed('xpag', 'MXN', 'OXXO')).toBe(false)
    expect(openAmountAllowed('xpag', 'COP', 'NEQUI')).toBe(false)
    expect(openAmountAllowed('xpag', 'ARS', 'BANK_TRANSFER')).toBe(false)
    const open = withOpenAmount(cfg(), true)
    expect(open).toMatchObject({ open_amount: true })
    expect(open).not.toHaveProperty('amount')
    expect(validateConfig(PAYMENT_ACTION, open)).toEqual({})
    // Mudar para um método sem "chave sem valor" desliga a opção e o valor volta a ser exigido.
    const oxxo = withMethod(withCurrency(open, 'MXN'), 'OXXO')
    expect(oxxo.open_amount).toBe(false)
    expect(validateConfig(PAYMENT_ACTION, oxxo)).toMatchObject({ amount: { key: 'required' } })
    expect(validateConfig(PAYMENT_ACTION, withOpenAmount(oxxo, false))).toEqual({})
    expect(
      validateConfig(PAYMENT_ACTION, cfg({ currency: 'ARS', method: 'BANK_TRANSFER', open_amount: true })),
    ).toMatchObject({ open_amount: { key: 'invalid' } })
  })

  it('limites da XPag: OXXO MX$10–10.000, COP mínimo COP$10.000, celular colombiano; variável passa', () => {
    const oxxo = (amount: string) =>
      validateConfig(PAYMENT_ACTION, cfg({ currency: 'MXN', method: 'OXXO', amount, email: '' }))
    expect(oxxo('9,99')).toMatchObject({ amount: { key: 'min', vars: { min: 'MX$10' } } })
    expect(oxxo('10.000,01')).toMatchObject({ amount: { key: 'max', vars: { max: 'MX$10.000' } } })
    expect(oxxo('150,00')).toEqual({})
    expect(oxxo('{valor}')).toEqual({})
    expect(oxxo('abc')).toMatchObject({ amount: { key: 'number' } })
    const cop = (amount: string, phone = '{phone_number}') =>
      validateConfig(PAYMENT_ACTION, cleanPayment(cfg({ currency: 'COP', method: 'NEQUI', amount, phone })))
    expect(cop('9999')).toMatchObject({ amount: { key: 'min', vars: { min: 'COP$10.000' } } })
    expect(cop('10000')).toEqual({})
    expect(cop('10000', '2001234567')).toMatchObject({ phone: { key: 'format' } })
    expect(cop('10000', '+57 300 123 4567')).toEqual({})
    expect(isColombianMobile('3001234567')).toBe(true)
    expect(validateConfig(PAYMENT_ACTION, cfg({ currency: 'ARS', method: 'BANK_TRANSFER', name: ' ' }))).toMatchObject({
      name: { key: 'required' },
    })
  })
})

describe('AC-T114-03 saídas no canvas e registro do editor', () => {
  it('o bloco tem as saídas charge_created / payment_approved / error (failure), com rótulos nas 3 línguas', () => {
    const handles = nodeHandles({
      type: 'payment',
      actions: [{ id: 'a1', type: PAYMENT_ACTION, order: 0, config: cfg() }],
    })
    expect(handles).toEqual(['output:charge_created', 'output:payment_approved', 'failure'])
    for (const locale of ['pt-BR', 'en', 'es'] as const)
      for (const h of handles) {
        const key = `settings-payments:block.payment.outputs.${h.replace(/^output:/, '')}`
        expect(translate(locale, key)).not.toBe(key)
      }
    expect(translate('pt-BR', 'settings-payments:block.payment.outputs.payment_approved')).toBe('Pagamento aprovado')
  })

  it('o grupo `payment/` registra o editor do tipo `payment` pelo glob', () => {
    expect(Object.keys(collectNodeEditors({ './payment/index.ts': group }))).toEqual(['payment'])
  })
})
