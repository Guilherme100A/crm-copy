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
  // T94: credenciais do servidor MCP (09 §2).
  { id: 'mcp_credentials', labelKey: 'settings-mcp:tab', group: 'integrations', permissions: ['settings.mcp.view'], load: () => import('@/features/settings-mcp/mcp-tab') },
]
