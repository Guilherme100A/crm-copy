// Tela de consentimento do OAuth MCP (T115): lê o pedido salvo pelo `/authorize` e aprova/nega com a sessão do CRM.
// A resposta traz a URL de volta ao cliente (`redirect_uri` com `code` ou `error`), que a página abre.
import { queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/http'

export interface AuthorizationRequest {
  request_id: string
  client: { client_id: string; name: string; redirect_uri: string }
  credential: { id: string; name: string }
  company: { id: string; name: string }
  scope: string
  expires_at: string
}

export const consentQuery = (request: string) =>
  queryOptions({
    queryKey: ['mcp-oauth', 'consent', request],
    queryFn: () =>
      api.get<{ authorization_request: AuthorizationRequest }>('/api/mcp-oauth/consent', { query: { request } }),
    retry: false,
    staleTime: 0,
  })

/** Corpo da decisão: aprovar confirma a empresa da credencial; negar não precisa dela. */
export function decisionBody(req: Pick<AuthorizationRequest, 'request_id' | 'company'>, approve: boolean) {
  return approve
    ? { request: req.request_id, company_id: req.company.id, approve: true }
    : { request: req.request_id, approve: false }
}

/** Host do `redirect_uri` exibido na tela (para o usuário reconhecer para onde volta). */
export function redirectHost(uri: string): string {
  try {
    return new URL(uri).host
  } catch {
    return uri
  }
}

export const mcpOAuthApi = {
  decide: (req: Pick<AuthorizationRequest, 'request_id' | 'company'>, approve: boolean) =>
    api.post<{ redirect_to: string }>('/api/mcp-oauth/consent', decisionBody(req, approve)),
}
