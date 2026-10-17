// Registro das abas do hub `/settings?tab=` (SPEC 2.4, compartilhado ADITIVO; spec 16 §2.1/17 §2): cada tarefa de
// configurações acrescenta a sua aba aqui (id da query, rótulo i18n, grupo, permissão e componente lazy).
import type { ComponentType } from 'react'

export type SettingsGroup = 'account' | 'automation' | 'integrations'

export interface SettingsTab {
  /** Valor de `?tab=` (ex.: `team`, `tags`, `quick_replies`). */
  id: string
  /** `<módulo>:<chave>` no i18n. */
  labelKey: string
  group: SettingsGroup
  /** Qualquer uma basta; owner sempre vê; vazio = sempre. */
  permissions?: readonly string[]
  /** Usuário `support` não vê a aba (spec 16 §2.1). */
  hiddenForSupport?: boolean
  /** T54: só estes papéis na empresa ativa veem a aba (ex.: `support_access` = owner/admin, 16 §8.4). */
  roles?: readonly ('owner' | 'admin' | 'member')[]
  /** Conteúdo da aba (carregado sob demanda). */
  load: () => Promise<{ default: ComponentType }>
}

export const SETTINGS_GROUPS: readonly SettingsGroup[] = ['account', 'automation', 'integrations']

/** Abas registradas, na ordem de exibição dentro de cada grupo. */
export const SETTINGS_TABS: SettingsTab[] = [
  // T53: Empresa (sub-abas Dados Corporativos, Departamentos e Horários em `?company_tab=`).
  {
    id: 'accounts',
    labelKey: 'settings-company:tab',
    group: 'account',
    permissions: ['settings.accounts.view'],
    load: () => import('@/features/settings-company/company-tab'),
  },
  // T54: Equipe, Convites para Plataforma e Acesso de suporte (16 §2.1, posições 2–4).
  { id: 'team', labelKey: 'settings-team:tab', group: 'account', permissions: ['team.view'], load: () => import('@/features/settings-team/tab') },
  { id: 'platform_invitations', labelKey: 'settings-invitations:tab', group: 'account', permissions: ['settings.platform_invitations.view'], load: () => import('@/features/settings-invitations/tab') },
  { id: 'support_access', labelKey: 'settings-support:tab', group: 'account', roles: ['owner', 'admin'], hiddenForSupport: true, load: () => import('@/features/settings-support/tab') },
  // T94: credenciais do servidor MCP (09 §2).
  { id: 'mcp_credentials', labelKey: 'settings-mcp:tab', group: 'integrations', permissions: ['settings.mcp.view'], load: () => import('@/features/settings-mcp/mcp-tab') },
  // T58: conteúdo (17 §2.1); modelos internos usam o id `message_templates`.
  { id: 'quick_replies', labelKey: 'settings-quick-replies:tab', group: 'automation', permissions: ['settings.quick_replies.view'], load: () => import('@/features/settings-quick-replies/tab') },
  { id: 'message_templates', labelKey: 'settings-templates:tab', group: 'automation', permissions: ['settings.message_templates.view'], load: () => import('@/features/settings-templates/tab') },
  { id: 'global_variables', labelKey: 'settings-variables:tab', group: 'automation', load: () => import('@/features/settings-variables/tab') },
  { id: 'custom_fields', labelKey: 'settings-fields:tab', group: 'automation', permissions: ['settings.fields.view'], load: () => import('@/features/settings-fields/tab') },
  { id: 'tags', labelKey: 'settings-labels:tab', group: 'automation', permissions: ['settings.labels.view'], load: () => import('@/features/settings-labels/tab') },
  // T59: consumo de IA (12 §3.10) e hub de integrações (19 §2.2; `?cat=ai|sales|tracking`).
  { id: 'ai_usage', labelKey: 'settings-ai-usage:tab', group: 'account', permissions: ['ai_usage.view'], load: () => import('@/features/settings-ai-usage/usage-tab') },
  { id: 'integrations', labelKey: 'integrations:tab', group: 'integrations', permissions: ['settings.integrations.view'], load: () => import('@/features/integrations/hub-tab') },
]
