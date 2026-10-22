// Ferramentas MCP de Pixels da Meta / Conversions API e links rastreáveis (via API do CRM; tudo exige `facebook.pixel`).
// Rotas: `/api/meta/pixels[/:id[/events]]` e `/api/meta/tracked-links[/:id]`. O token da Meta nunca volta em claro.
import { CAPI_EVENT_STATUSES, TRACKED_LINK_CODE_MODES } from '@crm/db'
import { z } from 'zod'
import { compact, fromApi, tool, UUID, type ToolSpec } from './shared'
import type { ZodRawShape } from 'zod'

const PERM = 'facebook.pixel' as const
const digits = z.string().regex(/^\d+$/, 'Só dígitos')
/** Paginação das rotas do CRM (`pageQuerySchema`: `page` e `limit`). */
const paging = {
  page: z.number().int().min(1).optional().describe('Página (1 = primeira)'),
  limit: z.number().int().min(1).max(100).optional().describe('Itens por página (1–100, padrão 20)'),
}

const pixelFields = {
  name: z.string().min(2).max(255).describe('Nome do pixel no CRM (2–255 caracteres)'),
  pixel_id: digits.max(64).describe('ID do pixel / dataset da Meta (só dígitos)'),
  access_token: z.string().max(4096).describe('Token de acesso da Conversions API (Gerenciador de Eventos → Configurações)'),
  platform: z.string().max(32).optional().describe('Plataforma (padrão do CRM se omitido)'),
  auto_send_sales: z.boolean().optional().describe('Envia Purchase automaticamente a cada venda registrada'),
  page_id: digits.min(3).max(32).nullable().optional().describe('ID da Página do Facebook (3–32 dígitos); necessário para Business Messaging'),
  whatsapp_business_account_id: digits.min(3).max(32).nullable().optional().describe('ID da conta do WhatsApp Business (WABA), 3–32 dígitos'),
  test_event_code: z
    .string()
    .regex(/^[A-Za-z0-9_-]{2,64}$/)
    .nullable()
    .optional()
    .describe('Código de "Testar eventos" do Gerenciador de Eventos (ex.: TEST12345); null remove'),
  default_country: z.string().max(8).nullable().optional().describe('País padrão (ISO, ex.: BR) para normalizar telefones'),
  auto_lead_on_ad: z.boolean().optional().describe('Envia Lead automático quando um contato chega por anúncio'),
}

const linkFields = {
  name: z.string().max(120).optional().describe('Nome do link'),
  slug: z.string().max(63).nullable().optional().describe('Slug público (/api/w/<slug>); vazio gera um'),
  connection_id: z.string().max(64).nullable().optional().describe('Conexão de WhatsApp de destino (id); ou use phone'),
  phone: z.string().max(32).nullable().optional().describe('Telefone de destino (E.164) se não usar connection_id'),
  message: z.string().max(500).nullable().optional().describe('Mensagem pré-preenchida no wa.me'),
  utm_source: z.string().max(255).nullable().optional(),
  utm_medium: z.string().max(255).nullable().optional(),
  utm_campaign: z.string().max(255).nullable().optional(),
  utm_content: z.string().max(255).nullable().optional(),
  utm_term: z.string().max(255).nullable().optional(),
  active: z.boolean().optional(),
  code_mode: z.enum(TRACKED_LINK_CODE_MODES).optional().describe('Código de rastreio na mensagem: visible, discreet ou off'),
  probable_match: z.boolean().optional().describe('Aceita casamento provável (sem código) dentro da janela'),
  match_window_minutes: z.number().int().min(1).max(1440).optional().describe('Janela do casamento provável, em minutos'),
}

export const pixelsTools: readonly ToolSpec<ZodRawShape>[] = [
  tool({
    name: 'list_pixels',
    title: 'Listar pixels da Meta',
    description: 'Pixels/datasets da Conversions API configurados na empresa. ID do pixel e token vêm mascarados.',
    perm: PERM,
    run: async (_a, api) => fromApi(await api.request('GET', '/api/meta/pixels')),
  }),
  tool({
    name: 'get_pixel',
    title: 'Ver pixel da Meta',
    description: 'Um pixel pelo id do CRM (não o ID da Meta), com o status de verificação da Business Manager. O token vem mascarado.',
    perm: PERM,
    input: { id: UUID.describe('id do pixel no CRM') },
    run: async ({ id }, api) => fromApi(await api.request('GET', `/api/meta/pixels/${id}`)),
  }),
  tool({
    name: 'create_pixel',
    title: 'Cadastrar pixel da Meta',
    description:
      'Cadastra um pixel da Conversions API. Obrigatórios: name, pixel_id (só dígitos) e access_token. Para Business Messaging (eventos de conversa do WhatsApp) informe também page_id e/ou whatsapp_business_account_id. O token é guardado cifrado.',
    perm: PERM,
    kind: 'write',
    input: pixelFields,
    run: async (a, api) => fromApi(await api.request('POST', '/api/meta/pixels', { body: { pixel_config: compact(a) } })),
  }),
  tool({
    name: 'update_pixel',
    title: 'Editar pixel da Meta',
    description:
      'Altera só os campos enviados. access_token ausente ou vazio mantém o token atual. Mudar page_id ou WABA zera a verificação da Business Manager. Use null para limpar campos opcionais.',
    perm: PERM,
    kind: 'write',
    input: {
      id: UUID.describe('id do pixel no CRM'),
      name: pixelFields.name.optional(),
      pixel_id: pixelFields.pixel_id.optional(),
      access_token: pixelFields.access_token.optional(),
      platform: pixelFields.platform,
      auto_send_sales: pixelFields.auto_send_sales,
      page_id: pixelFields.page_id,
      whatsapp_business_account_id: pixelFields.whatsapp_business_account_id,
      test_event_code: pixelFields.test_event_code,
      default_country: pixelFields.default_country,
      auto_lead_on_ad: pixelFields.auto_lead_on_ad,
    },
    run: async ({ id, ...rest }, api) => fromApi(await api.request('PUT', `/api/meta/pixels/${id}`, { body: { pixel_config: compact(rest) } })),
  }),
  tool({
    name: 'delete_pixel',
    title: 'Excluir pixel da Meta',
    description: 'Exclui o pixel do CRM (não mexe na Meta). Blocos de fluxo que enviam evento para ele deixam de enviar.',
    perm: PERM,
    kind: 'destructive',
    input: { id: UUID.describe('id do pixel no CRM') },
    run: async ({ id }, api) => fromApi(await api.request('DELETE', `/api/meta/pixels/${id}`)),
  }),
  tool({
    name: 'list_pixel_events',
    title: 'Eventos enviados ao pixel',
    description:
      'Log da Conversions API de um pixel (diagnóstico "Eventos enviados"): status, modo, nomes dos identificadores enviados e pontuação estimada, com resumo por status. "sent" = aceito pela CAPI, não quer dizer atribuído pela Meta. Datas em ISO 8601.',
    perm: PERM,
    input: {
      id: UUID.describe('id do pixel no CRM'),
      status: z.enum(CAPI_EVENT_STATUSES).optional(),
      mode: z.enum(['business_messaging', 'chat', 'system_generated']).optional(),
      event_name: z.string().max(64).optional().describe('Ex.: Purchase, Lead, LeadSubmitted'),
      source: z.enum(['flow', 'sale', 'manual', 'ad_lead']).optional(),
      from: z.string().optional().describe('Início (ISO 8601)'),
      to: z.string().optional().describe('Fim (ISO 8601)'),
      ...paging,
    },
    run: async ({ id, ...q }, api) => fromApi(await api.request('GET', `/api/meta/pixels/${id}/events`, { query: q })),
  }),
  tool({
    name: 'list_tracked_links',
    title: 'Listar links rastreáveis',
    description: 'Links rastreáveis (anúncio com destino site/link → wa.me) com cliques, conversas certas e prováveis, e vendas. Anúncio de clique para WhatsApp não usa link.',
    perm: PERM,
    run: async (_a, api) => fromApi(await api.request('GET', '/api/meta/tracked-links')),
  }),
  tool({
    name: 'create_tracked_link',
    title: 'Criar link rastreável',
    description: 'Cria um link público (/api/w/<slug>) que grava o clique (fbclid, UTMs) e redireciona para o wa.me. Informe connection_id ou phone.',
    perm: PERM,
    kind: 'write',
    input: linkFields,
    run: async (a, api) => fromApi(await api.request('POST', '/api/meta/tracked-links', { body: compact(a) })),
  }),
  tool({
    name: 'update_tracked_link',
    title: 'Editar link rastreável',
    description: 'Altera os campos enviados de um link rastreável (ex.: active=false desativa; o link passa a dar 404).',
    perm: PERM,
    kind: 'write',
    input: { id: UUID.describe('id do link'), ...linkFields },
    run: async ({ id, ...rest }, api) => fromApi(await api.request('PUT', `/api/meta/tracked-links/${id}`, { body: compact(rest) })),
  }),
  tool({
    name: 'delete_tracked_link',
    title: 'Excluir link rastreável',
    description: 'Exclui o link rastreável; anúncios que apontam para ele passam a cair em 404.',
    perm: PERM,
    kind: 'destructive',
    input: { id: UUID.describe('id do link') },
    run: async ({ id }, api) => fromApi(await api.request('DELETE', `/api/meta/tracked-links/${id}`)),
  }),
]
