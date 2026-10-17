import { afterEach, describe, expect, it, vi } from 'vitest'
import { CATALOG, RECORD_SOURCES } from '@/features/integrations/catalog'
import { activeCounts, matchesSearch } from '@/features/integrations/hub-logic'
import { translate } from '@/i18n/core'
import { api, HttpError } from '@/lib/http'
import {
  gatewayKeysQuery,
  issuersQuery,
  paymentsApi,
  tokenApi,
  tokenBody,
  utmifyConfiguredQuery,
  type PaymentIntegrationDto,
  type TokenIntegrationDto,
} from './api'
import { paymentBody, paymentRecord, pathOf, tokenRecord, validatePaymentForm, validateTokenForm } from './rules'

afterEach(() => vi.restoreAllMocks())

const payment = (over: Partial<PaymentIntegrationDto> = {}): PaymentIntegrationDto => ({
  id: 'p1',
  label: 'XPag produção',
  gateway: 'xpag',
  client_id: 'cid',
  secret_configured: true,
  secret_hint: '…abcd',
  webhook_url: 'http://x/api/hooks/payments/xpag/p1',
  zenith_oauth: false,
  last_tested_at: null,
  last_test_ok: null,
  created_at: '',
  updated_at: '',
  ...over,
})

const token = (over: Partial<TokenIntegrationDto> = {}): TokenIntegrationDto => ({
  id: 't1',
  name: 'Notasy',
  company_name: 'Minha Empresa',
  token_configured: true,
  token_hint: '…wxyz',
  created_at: '',
  updated_at: '',
  ...over,
})

describe('AC-T114-01 cards de Pagamentos, NF e UTMify no hub', () => {
  it('catálogo compartilhado ganha XPag e Notasy (Vendas) e UTMify (Rastreamento), sem Zenith, com textos nas 3 línguas', () => {
    const extra = CATALOG.filter((i) => i.category !== 'ai')
    expect(extra.map((i) => [i.id, i.category, i.modalKind])).toEqual([
      ['xpag', 'sales', 'payments'],
      ['notasy', 'sales', 'invoice'],
      ['utmify', 'tracking', 'utmify'],
    ])
    expect(CATALOG.some((i) => i.id === 'zenith')).toBe(false)
    for (const i of extra) {
      expect(i.loadModal).toBeTypeOf('function')
      expect(i.editPermissions).toEqual(['settings.integrations.edit'])
      for (const locale of ['pt-BR', 'en', 'es'] as const) {
        expect(translate(locale, i.titleKey)).not.toBe(i.titleKey)
        expect(translate(locale, i.descriptionKey)).not.toBe(i.descriptionKey)
      }
    }
    expect(RECORD_SOURCES.map((s) => [s.id, s.category])).toEqual([
      ['ai-keys', 'ai'],
      ['payment-integrations', 'sales'],
      ['invoice-integrations', 'sales'],
      ['utmify-integrations', 'tracking'],
    ])
  })

  it('status Ativo/Inativo pelo segredo/token configurado; nunca o segredo, só a dica', () => {
    const on = paymentRecord(payment())
    const off = paymentRecord(payment({ id: 'p2', secret_configured: false, secret_hint: null }))
    expect(on).toMatchObject({
      title: 'XPag produção',
      providerLabel: 'XPag',
      initials: 'XP',
      active: true,
      detail: '…abcd',
      modalKind: 'payments',
      category: 'sales',
    })
    expect(off.active).toBe(false)
    expect(off).not.toHaveProperty('detail')
    const nf = tokenRecord('invoice', token())
    const ut = tokenRecord('utmify', token({ id: 'u1', name: 'UTMify', token_configured: false }))
    expect(nf).toMatchObject({
      title: 'Minha Empresa',
      providerLabel: 'Notasy',
      active: true,
      category: 'sales',
      modalKind: 'invoice',
      sourceId: 'invoice-integrations',
    })
    expect(ut).toMatchObject({
      providerLabel: 'UTMify',
      active: false,
      category: 'tracking',
      modalKind: 'utmify',
      sourceId: 'utmify-integrations',
    })
    expect(activeCounts([on, off, nf, ut])).toEqual({ ai: 0, sales: 2, tracking: 0 })
    expect(JSON.stringify([on, nf])).not.toMatch(/secret|token_configured/)
  })

  it('busca sem acentos acha os cards novos por título, descrição e provedor', () => {
    const hit = (term: string) =>
      CATALOG.filter((i) =>
        matchesSearch([translate('pt-BR', i.titleKey), translate('pt-BR', i.descriptionKey), i.providerLabel], term),
      ).map((i) => i.id)
    expect(hit('notasy')).toEqual(['notasy'])
    expect(hit('atribuicao')).toEqual(['utmify'])
    expect(hit('xpag')).toContain('xpag')
  })

  it('as fontes listam pelas rotas reais (pagamentos só XPag)', async () => {
    const get = vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === '/api/payment-integrations') return { items: [payment()] } as never
      if (path === '/api/invoice-integrations') return { invoice_integrations: [token()] } as never
      if (path === '/api/utmify-integrations') return { utmify_integrations: [token({ id: 'u1' })] } as never
      return {} as never
    })
    const recs = await Promise.all(RECORD_SOURCES.slice(1).map((s) => s.query().queryFn()))
    expect(recs.map((r) => r.map((x) => x.sourceId))).toEqual([
      ['payment-integrations'],
      ['invoice-integrations'],
      ['utmify-integrations'],
    ])
    expect(get).toHaveBeenCalledWith('/api/payment-integrations', { query: { gateway: 'xpag' } })
  })
})

describe('AC-T114-02 modal de chave XPag', () => {
  it('validações iguais às do servidor: nome ≥ 2, Client ID e segredo obrigatórios na criação', () => {
    expect(validatePaymentForm({ label: ' a ', client_id: '', client_secret: '' }, 'create')).toEqual({
      label: 'labelMin',
      client_id: 'clientIdRequired',
      client_secret: 'secretRequired',
    })
    expect(validatePaymentForm({ label: 'XP', client_id: 'id', client_secret: '' }, 'edit')).toEqual({})
    expect(translate('pt-BR', 'settings-payments:errors.labelMin')).toBe('Informe um nome com pelo menos 2 caracteres.')
    expect(validateTokenForm({ company_name: 'A', integration_token: '' }, 'create')).toEqual({
      company_name: 'companyMin',
      integration_token: 'tokenRequired',
    })
    expect(validateTokenForm({ company_name: 'Acme', integration_token: '' }, 'edit')).toEqual({})
  })

  it('segredo em branco na edição mantém o atual (não vai no corpo); na criação vai aparado', () => {
    expect(paymentBody({ label: ' XPag ', client_id: ' id ', client_secret: '' }, 'xpag', 'edit')).toEqual({
      label: 'XPag',
      gateway: 'xpag',
      client_id: 'id',
    })
    expect(paymentBody({ label: 'XPag', client_id: 'id', client_secret: ' s3cr3t ' }, 'xpag', 'create')).toEqual({
      label: 'XPag',
      gateway: 'xpag',
      client_id: 'id',
      client_secret: 's3cr3t',
    })
    expect(tokenBody('invoice', { company_name: ' Acme ', integration_token: '' }, true)).toEqual({
      invoice_integration: { company_name: 'Acme', provider: 'notasy' },
    })
    expect(tokenBody('utmify', { company_name: 'Acme', integration_token: ' tk ' }, false)).toEqual({
      utmify_integration: { company_name: 'Acme', integration_token: 'tk' },
    })
  })

  it('erro 422 do servidor vai para o campo (details.fields[].path); outros erros são gerais', () => {
    const v = new HttpError(422, 'VALIDATION_ERROR', 'Dados inválidos', {
      fields: [{ path: 'label', message: 'Informe um nome com pelo menos 2 caracteres.' }],
    })
    expect(pathOf(v)).toBe('label')
    expect(pathOf(new HttpError(502, 'UPSTREAM_ERROR', 'falhou'))).toBeNull()
    expect(pathOf(new Error('x'))).toBeNull()
  })

  it('criar usa o envelope do produto de referência; Testar conexão chama a rota da chave', async () => {
    const post = vi
      .spyOn(api, 'post')
      .mockImplementation(
        async (path: string) =>
          (path.endsWith('/test-connection')
            ? { ok: false, error: 'Credencial recusada' }
            : { integration: payment() }) as never,
      )
    await paymentsApi.create({ label: 'XPag', gateway: 'xpag', client_id: 'id', client_secret: 's' })
    expect(post).toHaveBeenCalledWith('/api/payment-integrations', {
      payment_integration: { label: 'XPag', gateway: 'xpag', client_id: 'id', client_secret: 's' },
    })
    await expect(paymentsApi.test('p1')).resolves.toEqual({ ok: false, error: 'Credencial recusada' })
    expect(post).toHaveBeenLastCalledWith('/api/payment-integrations/p1/test-connection', {})
    expect(translate('pt-BR', 'settings-payments:payment.testOk')).toBe('Conexão validada com sucesso.')
  })

  it('excluir emissor/UTMify em uso: `?force=1` só no "Excluir mesmo assim"', async () => {
    const del = vi.spyOn(api, 'delete').mockResolvedValue({ ok: true } as never)
    await tokenApi('invoice').remove('t1')
    await tokenApi('utmify').remove('u1', true)
    expect(del.mock.calls).toEqual([
      ['/api/invoice-integrations/t1', undefined],
      ['/api/utmify-integrations/u1', { query: { force: '1' } }],
    ])
  })
})

describe('listas dos editores de bloco', () => {
  it('chaves por gateway, emissores e UTMify com `?configured=1`; 403 vira aviso sem quebrar', async () => {
    const get = vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === '/api/invoice-integrations') throw new HttpError(403, 'FORBIDDEN', 'sem permissão')
      if (path === '/api/utmify-integrations') return { utmify_integrations: [token({ id: 'u1' })] } as never
      return { items: [payment()] } as never
    })
    const run = <T>(q: { queryFn?: unknown }) => (q.queryFn as () => Promise<T>)()
    await expect(run(gatewayKeysQuery('xpag'))).resolves.toMatchObject({ denied: false, items: [{ id: 'p1' }] })
    await expect(run(issuersQuery())).resolves.toEqual({ items: [], denied: true })
    await expect(run(utmifyConfiguredQuery())).resolves.toMatchObject({ denied: false, items: [{ id: 'u1' }] })
    expect(get).toHaveBeenCalledWith('/api/utmify-integrations', { query: { configured: '1' } })
  })
})
