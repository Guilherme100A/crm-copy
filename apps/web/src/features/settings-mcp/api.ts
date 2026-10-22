// API das credenciais MCP (T94; 09 §6): listar, criar (o token vem só na resposta) e revogar.
// T115: credencial `oauth` (conector do Claude) sem token: a resposta traz a `connector_url`; status `pending` até o
// cliente concluir o OAuth e `connected` (com `connected_client_hint`) depois — sem realtime, atualiza ao recarregar.
import { queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/http'

export type McpAuthType = 'static' | 'oauth'
export const MCP_AUTH_TYPES: readonly McpAuthType[] = ['static', 'oauth']
/** `write` libera as ferramentas que gravam, nos limites das permissões de quem criou ou autorizou a credencial. */
export type McpAccess = 'read' | 'write'
export const MCP_ACCESS_MODES: readonly McpAccess[] = ['read', 'write']

export interface McpCredentialDto {
  id: string
  name: string
  auth_type: McpAuthType
  access?: McpAccess
  status: 'active' | 'expired' | 'pending' | 'connected'
  expires_at: string | null
  last_used_at: string | null
  created_at: string
  /** T115: nome do cliente OAuth conectado. */
  connected_client_hint?: string | null
  /** T115: URL do conector (`<API>/api/mcp/<id>`) das credenciais `oauth`. */
  connector_url?: string | null
}

export interface McpCreateInput {
  name: string
  auth_type: McpAuthType
  access?: McpAccess
  expires_in_days?: number
}

/** Opções de expiração da tela (dias; `0` = nunca). */
export const EXPIRATION_OPTIONS = [0, 30, 90, 365] as const
export type ExpirationOption = (typeof EXPIRATION_OPTIONS)[number]

export const MCP_KEY = ['mcp-credentials'] as const

export const mcpCredentialsQuery = () =>
  queryOptions({
    queryKey: MCP_KEY,
    queryFn: () => api.get<{ mcp_credentials: McpCredentialDto[]; mcp_endpoint_url: string }>('/api/mcp_credentials'),
  })

/** Corpo do POST a partir do formulário (nome aparado; `0` dias = sem expiração; OAuth não expira; `read` é o padrão da API). */
export function createBody(name: string, days: ExpirationOption, authType: McpAuthType = 'static', access: McpAccess = 'read'): { mcp_credential: McpCreateInput } {
  return {
    mcp_credential: {
      name: name.trim(),
      auth_type: authType,
      ...(access === 'write' ? { access } : {}),
      ...(authType === 'static' && days > 0 ? { expires_in_days: days } : {}),
    },
  }
}

/** Rótulo do status: "Conectada · <cliente>" quando há cliente OAuth conectado. */
export function statusLabel(c: Pick<McpCredentialDto, 'status' | 'connected_client_hint'>, t: (key: string, vars?: Record<string, string>) => string): string {
  return c.status === 'connected' && c.connected_client_hint ? t('status.connectedWith', { client: c.connected_client_hint }) : t(`status.${c.status}`)
}

export const mcpApi = {
  create: (name: string, days: ExpirationOption, authType: McpAuthType = 'static', access: McpAccess = 'read') =>
    api.post<{ mcp_credential: McpCredentialDto; token: string | null; mcp_endpoint_url: string }>('/api/mcp_credentials', createBody(name, days, authType, access)),
  revoke: (id: string) => api.delete(`/api/mcp_credentials/${encodeURIComponent(id)}`),
}
