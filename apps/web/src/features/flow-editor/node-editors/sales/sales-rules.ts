// Regras do bloco Venda aprovada (`register_approved_sale`; AC-T114-04; 19 §3.9): defaults por template a partir do
// comprovante, escolha do produto (com a opção "+ Criar novo produto…"), emissor de NF e UTMify opcionais (null = "Não
// emitir nota automaticamente" / "Não enviar para UTMify") e as variáveis do push.
import { setField, type Config } from '../logic/rules'

export const APPROVED_SALE_ACTION = 'register_approved_sale'

/** Valor do `<select>` de produto que abre o modal de produto (nunca vai para a config). */
export const NEW_PRODUCT = '__new__'

/** Variáveis do push (19 §3.9). */
export const PUSH_VARIABLES = ['produto.nome', 'venda.valor', 'venda.moeda', 'venda.cliente'] as const

export const defaultApprovedSaleConfig = (): Config => ({
  product_public_id: '',
  amount_template: '{comprovante.valor}',
  currency_template: '{comprovante.currency}',
  customer_name_template: '{comprovante.nome_pagador}',
  note_issuer_id: null,
  utmify_integration_id: null,
  push_title_template: '',
  push_body_template: '',
})

/** Seletor opcional: `''` (a opção "Não …") grava `null`. */
export const withOptionalId = (c: Config, key: 'note_issuer_id' | 'utmify_integration_id', value: string): Config =>
  setField(c, key, value || null)

/** Valor do `<select>` de um id opcional (`null`/ausente → `''`). */
export const optionalIdValue = (c: Config, key: string): string =>
  typeof c[key] === 'string' ? (c[key] as string) : ''

/** Insere `{variável}` no fim do texto (botões de variável do push). */
export const appendVariable = (text: string, name: string): string =>
  `${text}${text && !/\s$/.test(text) ? ' ' : ''}{${name}}`
