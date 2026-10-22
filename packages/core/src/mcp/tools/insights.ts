// Ferramentas MCP de métricas e funil (via API do CRM): dashboard de vendas e de atendimento, vendas, funil do Kanban
// e métricas dos anúncios da Meta. Datas `YYYY-MM-DD` são dias no fuso da empresa (a resposta traz `range.time_zone`).
import { z, type ZodRawShape } from 'zod'
import { compact, fromApi, tool, UUID, type ToolSpec } from './shared'

const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('Dia YYYY-MM-DD no fuso da empresa')
const ids = (what: string) => z.array(UUID).max(100).optional().describe(`Filtra por ${what} (ids)`)
const csv = (v: readonly string[] | undefined) => (v && v.length ? v.join(',') : undefined)
const SALE_STATUS = z.enum(['approved', 'refunded', 'chargeback', 'pending'])

export const insightsTools: readonly ToolSpec<ZodRawShape>[] = [
  tool({
    name: 'get_sales_metrics',
    title: 'Métricas de vendas',
    description:
      'Dashboard de vendas do período (padrão: hoje). KPIs: new_leads (contatos novos), sales_count, revenue_cents, avg_ticket_cents, ' +
      'conversion_rate (vendas ÷ leads, 0–1), spend_cents (gasto em anúncios), roas (receita ÷ gasto), profit_pre_fees_cents, expenses_cents e ' +
      'profit_cents. Todo valor *_cents é em centavos (divida por 100 para reais). Traz também a comparação com o período anterior e os ' +
      'quebrados por dia/hora, conexão, estado (UF) e produto. Intervalo de até 366 dias; cache de 5 min (force_refresh recalcula).',
    perm: 'dashboard.sales',
    input: {
      start_date: DATE.optional(),
      end_date: DATE.optional(),
      connection_ids: ids('conexões de WhatsApp'),
      product_ids: ids('produtos'),
      force_refresh: z.boolean().optional().describe('Ignora o cache de 5 minutos'),
    },
    run: async (a, api) =>
      fromApi(
        await api.request('GET', '/api/dashboard', {
          query: compact({
            start_date: a.start_date,
            end_date: a.end_date,
            connection_ids: csv(a.connection_ids),
            product_ids: csv(a.product_ids),
            force_refresh: a.force_refresh ? 1 : undefined,
          }),
        }),
      ),
  }),

  tool({
    name: 'get_attendance_metrics',
    title: 'Métricas de atendimento',
    description:
      'Dashboard de atendimento do período (padrão: hoje). attendance traz new_leads, attended_leads, resolved_leads, unanswered_chats e ' +
      'response_time_seconds (tempo médio de resposta, em segundos), a comparação com o período anterior (previous, trends) e os quebrados ' +
      'por tempo, dia da semana × hora (picos), conexão, atendente (leads_by_user) e departamento. Intervalo de até 92 dias.',
    perm: 'dashboard.support',
    input: {
      start_date: DATE.optional(),
      end_date: DATE.optional(),
      connection_ids: ids('conexões de WhatsApp'),
      force_refresh: z.boolean().optional(),
    },
    run: async (a, api) =>
      fromApi(
        await api.request('GET', '/api/dashboard/attendance', {
          query: compact({ start_date: a.start_date, end_date: a.end_date, connection_ids: csv(a.connection_ids), force_refresh: a.force_refresh ? 1 : undefined }),
        }),
      ),
  }),

  tool({
    name: 'list_sales',
    title: 'Listar vendas',
    description:
      'Histórico de vendas, mais recentes primeiro, com filtros. amount_cents em centavos. source: manual, flow (bloco de pagamento do fluxo) ' +
      'ou webhook (gateway/plataforma). Paginação por page/limit (até 100).',
    perm: 'dashboard.sales',
    input: {
      start_date: DATE.optional(),
      end_date: DATE.optional(),
      status: z.array(SALE_STATUS).max(4).optional(),
      source: z.enum(['manual', 'flow', 'webhook']).optional(),
      contact_id: UUID.optional(),
      connection_ids: ids('conexões'),
      product_ids: ids('produtos'),
      page: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    run: async (a, api) =>
      fromApi(
        await api.request('GET', '/api/sales', {
          query: compact({
            start_date: a.start_date,
            end_date: a.end_date,
            status: csv(a.status),
            source: a.source,
            contact_id: a.contact_id,
            connection_ids: csv(a.connection_ids),
            product_ids: csv(a.product_ids),
            page: a.page,
            limit: a.limit,
          }),
        }),
      ),
  }),

  tool({
    name: 'get_sale',
    title: 'Ver venda',
    description: 'Uma venda pelo id (valor em centavos, status, produto, contato, conexão e atribuição de anúncio).',
    perm: 'dashboard.sales',
    input: { id: UUID },
    run: async (a, api) => fromApi(await api.request('GET', `/api/sales/${a.id}`)),
  }),

  tool({
    name: 'record_sale',
    title: 'Registrar venda',
    description:
      'Registra uma venda manual. amount_cents em centavos (R$ 49,90 = 4990). Com external_id repetido, atualiza a venda existente em vez de ' +
      'duplicar. sold_at em ISO 8601 (padrão: agora).',
    perm: 'sales.edit',
    kind: 'write',
    input: {
      amount_cents: z.number().int().min(0),
      currency: z.string().max(10).optional().describe('ISO-4217, padrão BRL'),
      sold_at: z.string().max(40).optional(),
      status: SALE_STATUS.optional(),
      product_id: UUID.optional(),
      contact_id: UUID.optional(),
      connection_id: UUID.optional(),
      external_id: z.string().max(200).optional().describe('Id do pedido no seu sistema (idempotência)'),
      customer_name: z.string().max(255).optional(),
    },
    run: async (a, api) => fromApi(await api.request('POST', '/api/sales', { body: { sale: compact(a) } })),
  }),

  tool({
    name: 'delete_sale',
    title: 'Excluir venda',
    description: 'Exclui uma venda (sai do dashboard e das métricas). Não dá para desfazer.',
    perm: 'sales.edit',
    kind: 'destructive',
    input: { id: UUID },
    run: async (a, api) => fromApi(await api.request('DELETE', `/api/sales/${a.id}`)),
  }),

  tool({
    name: 'list_kanban_boards',
    title: 'Listar quadros Kanban',
    description:
      'Quadros (CRMs) do Kanban da empresa, com as colunas e um resumo (total de cards, valor em centavos e conversão). Use o id em ' +
      'get_kanban_funnel e list_kanban_cards.',
    perm: 'kanban.view',
    run: async (_a, api) => fromApi(await api.request('GET', '/api/crms')),
  }),

  tool({
    name: 'get_kanban_funnel',
    title: 'Funil do Kanban',
    description:
      'Funil de um quadro Kanban: por coluna, na ordem, column_count (cards só nela) e o acumulado (ela + as posteriores), com a taxa de ' +
      'passagem entre etapas; conversion_count/conversion_rate contam as colunas marcadas como meta de conversão. totals traz leads, compras ' +
      'e receita (total_revenue_cents em centavos). Filtros opcionais iguais aos dos cards.',
    perm: 'kanban.view',
    input: {
      board_id: UUID.describe('id do quadro (list_kanban_boards)'),
      label_ids: ids('etiquetas'),
      assigned_to: UUID.optional().describe('id do atendente'),
      updated_from: z.string().max(40).optional().describe('ISO 8601'),
      updated_to: z.string().max(40).optional().describe('ISO 8601'),
    },
    run: async (a, api) =>
      fromApi(
        await api.request('GET', `/api/crms/${a.board_id}/stats`, {
          query: compact({ label_ids: csv(a.label_ids), assigned_to: a.assigned_to, updated_from: a.updated_from, updated_to: a.updated_to }),
        }),
      ),
  }),

  tool({
    name: 'list_kanban_cards',
    title: 'Listar cards do Kanban',
    description: 'Cards de um quadro (cada card é um chat), com coluna, valor em centavos e contato. Paginação page/limit (até 120).',
    perm: 'kanban.view',
    input: {
      board_id: UUID,
      column_id: UUID.optional(),
      label_ids: ids('etiquetas'),
      assigned_to: UUID.optional(),
      page: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).max(120).optional(),
    },
    run: async (a, api) =>
      fromApi(
        await api.request('GET', `/api/crms/${a.board_id}/cards`, {
          query: compact({ column_id: a.column_id, label_ids: csv(a.label_ids), assigned_to: a.assigned_to, page: a.page, limit: a.limit }),
        }),
      ),
  }),

  tool({
    name: 'move_kanban_card',
    title: 'Mover card do Kanban',
    description: 'Move um card para outra coluna do mesmo quadro (opcionalmente antes de outro card). Devolve o card e os totais das colunas.',
    perm: 'kanban.edit',
    kind: 'write',
    input: { board_id: UUID, card_id: UUID, column_id: UUID, before_card_id: UUID.optional() },
    run: async (a, api) =>
      fromApi(
        await api.request('PATCH', `/api/crms/${a.board_id}/cards/${a.card_id}/move`, {
          body: compact({ column_id: a.column_id, before_card_id: a.before_card_id }),
        }),
      ),
  }),

  tool({
    name: 'get_ad_metrics',
    title: 'Métricas dos anúncios (Meta)',
    description:
      'Campanhas, conjuntos e anúncios das contas de anúncio ligadas, com gasto (meta_spend), compras e valor pelo pixel/Meta, conversas ' +
      'iniciadas, cliques, impressões, custo por compra/lead e as vendas internas do CRM atribuídas ao anúncio (purchases_leona, ' +
      'purchase_value_leona, roas_internal). Valores monetários em unidades da moeda (reais, não centavos); *_display já convertido para ' +
      'display_currency. Sem date_preset/since/until = hoje. Pode demorar: se status vier "loading"/"refreshing"/"partial", chame de novo ' +
      'em alguns segundos com os mesmos parâmetros até "ready". warnings: rate_limited (dados do cache), no_ad_accounts, fx_rate_missing.',
    perm: 'facebook.campaigns',
    input: {
      date_preset: z.enum(['today', 'yesterday', '7d', '30d', 'month', 'custom']).optional(),
      since: DATE.optional().describe('Com date_preset custom'),
      until: DATE.optional().describe('Com date_preset custom'),
      status_filter: z.enum(['active', 'all']).optional().describe('Padrão: só ativos'),
      ad_account_ids: z.array(z.string().max(100)).max(50).optional(),
      display_currency: z.string().length(3).optional().describe('ISO-4217, padrão BRL'),
      force_refresh: z.boolean().optional(),
    },
    run: async (a, api) =>
      fromApi(
        await api.request('GET', '/api/meta/structure-bundle', {
          query: compact({
            async: 1,
            date_preset: a.date_preset,
            since: a.since,
            until: a.until,
            status_filter: a.status_filter,
            ad_account_ids: csv(a.ad_account_ids),
            display_currency: a.display_currency,
            force_refresh: a.force_refresh ? 1 : undefined,
          }),
        }),
      ),
  }),
]
