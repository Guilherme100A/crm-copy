// API das credenciais MCP (T94; 09 §6): listar, criar (o token vem só na resposta) e revogar.
import { queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/http'

export interface McpCredentialDto {
  id: string
  name: string
  auth_type: 'static' | 'oauth'
  status: 'active' | 'expired'
  expires_at: string | null
  last_used_at: string | null
  created_at: string
}

export interface McpCreateInput {
  name: string
  auth_type: 'static'
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

/** Corpo do POST a partir do formulário (nome aparado; `0` dias = sem expiração). */
export function createBody(name: string, days: ExpirationOption): { mcp_credential: McpCreateInput } {
  return { mcp_credential: { name: name.trim(), auth_type: 'static', ...(days > 0 ? { expires_in_days: days } : {}) } }
}

export const mcpApi = {
  create: (name: string, days: ExpirationOption) =>
    api.post<{ mcp_credential: McpCredentialDto; token: string; mcp_endpoint_url: string }>('/api/mcp_credentials', createBody(name, days)),
  revoke: (id: string) => api.delete(`/api/mcp_credentials/${encodeURIComponent(id)}`),
}
