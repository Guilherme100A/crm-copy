// Ferramentas MCP de pagamentos (via API do CRM): chaves dos gateways de cobrança ao lead (XPag, Zenith), produtos e
// fontes de venda. Rotas `/api/payment-integrations`, `/api/products` e `/api/sale-sources`. Segredos nunca voltam.
import { PAYMENT_GATEWAY_IDS } from '@crm/db'
import { z } from 'zod'
import { compact, fromApi, tool, UUID, type ToolSpec } from './shared'
import type { ZodRawShape } from 'zod'

const VIEW = 'settings.integrations.view' as const
const EDIT = 'settings.integrations.edit' as const
const DELETE = 'settings.integrations.delete' as const

const label = z.string().trim().min(2).max(120).describe('Nome da chave no CRM (2–120 caracteres)')

export const paymentsTools: readonly ToolSpec<ZodRawShape>[] = [
  tool({
    name: 'list_payment_integrations',
    title: 'Listar integrações de pagamento',
    description:
      'Chaves de gateway de pagamento (XPag, Zenith) usadas pelo bloco Pagamento dos fluxos para gerar cobrança Pix. Traz client_id, dica do segredo (…abcd), URL do webhook e resultado do último teste; o segredo nunca vem.',
    perm: VIEW,
    input: { gateway: z.enum(PAYMENT_GATEWAY_IDS).optional().describe('Filtra por gateway') },
    run: async ({ gateway }, api) => fromApi(await api.request('GET', '/api/payment-integrations', { query: { gateway } })),
  }),
  tool({
    name: 'get_payment_integration',
    title: 'Ver integração de pagamento',
    description: 'Uma chave de gateway pelo id (sem o segredo).',
    perm: VIEW,
    input: { id: UUID.describe('id da integração') },
    run: async ({ id }, api) => fromApi(await api.request('GET', `/api/payment-integrations/${id}`)),
  }),
  tool({
    name: 'create_payment_integration',
    title: 'Cadastrar chave de pagamento (XPag)',
    description:
      'Cadastra a chave de um gateway (gateway "xpag" para a XPag) com o Client ID e o Client Secret do painel do gateway. O segredo é guardado cifrado e um webhook_url é gerado: configure-o no gateway para receber pagamentos aprovados. Depois rode test_payment_integration.',
    perm: EDIT,
    kind: 'write',
    input: {
      label,
      gateway: z.enum(PAYMENT_GATEWAY_IDS).describe('Gateway: xpag ou zenith'),
      client_id: z.string().trim().min(1).max(500).describe('Client ID do gateway'),
      client_secret: z.string().trim().min(1).max(1000).describe('Client Secret do gateway (não é devolvido)'),
    },
    run: async (a, api) => fromApi(await api.request('POST', '/api/payment-integrations', { body: { payment_integration: a } })),
  }),
  tool({
    name: 'update_payment_integration',
    title: 'Editar chave de pagamento',
    description:
      'Altera nome, Client ID e/ou Client Secret. O gateway não muda. client_secret ausente ou vazio mantém o atual. Trocar client_id ou segredo zera o resultado do último teste.',
    perm: EDIT,
    kind: 'write',
    input: {
      id: UUID.describe('id da integração'),
      label: label.optional(),
      client_id: z.string().trim().min(1).max(500).optional(),
      client_secret: z.string().max(1000).optional().describe('Novo segredo; omita para manter'),
    },
    run: async ({ id, ...rest }, api) => fromApi(await api.request('PUT', `/api/payment-integrations/${id}`, { body: { payment_integration: compact(rest) } })),
  }),
  tool({
    name: 'test_payment_integration',
    title: 'Testar chave de pagamento',
    description: 'Autentica no gateway com a chave salva e grava o resultado (last_tested_at / last_test_ok). Devolve ok e, em falha, a causa sem segredos.',
    perm: EDIT,
    kind: 'write',
    input: { id: UUID.describe('id da integração') },
    run: async ({ id }, api) => fromApi(await api.request('POST', `/api/payment-integrations/${id}/test-connection`)),
  }),
  tool({
    name: 'delete_payment_integration',
    title: 'Excluir chave de pagamento',
    description:
      'Exclui a chave. Se um fluxo ativo usa a chave num bloco Pagamento, a API recusa (409 conflict) e lista os fluxos: troque a chave nesses fluxos ou pause-os antes.',
    perm: DELETE,
    kind: 'destructive',
    input: { id: UUID.describe('id da integração') },
    run: async ({ id }, api) => fromApi(await api.request('DELETE', `/api/payment-integrations/${id}`)),
  }),
  tool({
    name: 'list_products',
    title: 'Listar produtos',
    description: 'Produtos da empresa (faixa de preço e preço padrão em centavos), usados para classificar vendas.',
    perm: 'settings.products.view',
    input: { search: z.string().max(200).optional().describe('Busca por nome') },
    run: async ({ search }, api) => fromApi(await api.request('GET', '/api/products', { query: { search } })),
  }),
  tool({
    name: 'get_product',
    title: 'Ver produto',
    description: 'Um produto pelo id.',
    perm: 'settings.products.view',
    input: { id: UUID.describe('id do produto') },
    run: async ({ id }, api) => fromApi(await api.request('GET', `/api/products/${id}`)),
  }),
  tool({
    name: 'create_product',
    title: 'Cadastrar produto',
    description: 'Cadastra um produto. Valores em centavos (R$ 47,90 = 4790). A venda cai no produto cujo valor está entre price_min_cents e price_max_cents.',
    perm: 'settings.products.edit',
    kind: 'write',
    input: {
      name: z.string().min(1).max(1000),
      currency: z.string().max(10).optional().describe('Moeda ISO (padrão BRL)'),
      price_min_cents: z.number().int().optional(),
      price_max_cents: z.number().int().optional(),
      price_fallback_cents: z.number().int().optional().describe('Preço usado quando a venda vem sem valor (> 0)'),
    },
    run: async (a, api) => fromApi(await api.request('POST', '/api/products', { body: { product: compact(a) } })),
  }),
  tool({
    name: 'list_sale_sources',
    title: 'Listar fontes de venda',
    description: 'Fontes de venda (webhooks de checkout/plataformas que registram vendas no CRM) e seus mapeamentos.',
    perm: VIEW,
    run: async (_a, api) => fromApi(await api.request('GET', '/api/sale-sources')),
  }),
  tool({
    name: 'get_sale_source',
    title: 'Ver fonte de venda',
    description: 'Uma fonte de venda pelo id.',
    perm: VIEW,
    input: { id: UUID.describe('id da fonte') },
    run: async ({ id }, api) => fromApi(await api.request('GET', `/api/sale-sources/${id}`)),
  }),
  tool({
    name: 'list_sale_source_events',
    title: 'Eventos recebidos da fonte de venda',
    description: 'Webhooks recebidos por uma fonte de venda (pendentes, processados, com falha), mais recentes primeiro, com total.',
    perm: VIEW,
    input: {
      id: UUID.describe('id da fonte'),
      status: z.enum(['pending', 'processed', 'failed']).optional().describe('Filtra pelo status do evento'),
      page: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    run: async ({ id, ...q }, api) => fromApi(await api.request('GET', `/api/sale-sources/${id}/events`, { query: q })),
  }),
]
