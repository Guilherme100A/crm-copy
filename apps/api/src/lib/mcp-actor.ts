// Chamada interna das ferramentas MCP: o servidor MCP chama a própria API (`app.fetch`) em nome do usuário dono da
// credencial, reusando validação, permissões, auditoria e realtime de cada rota. O ator viaja no `env` do fetch sob
// um Symbol: requests vindos da rede (`@hono/node-server`) nunca têm essa chave, então não dá para forjar.
import type { AuthUser, CompanyMember } from '@crm/core'
import type { PermissionKey } from '@crm/shared'

export const MCP_ACTOR = Symbol('crm.mcp_actor')

export interface McpActor {
  user: AuthUser
  companyId: string
  member: CompanyMember
  perms: ReadonlySet<PermissionKey>
  credentialId: string
}

export function mcpActorOf(env: unknown): McpActor | undefined {
  if (!env || typeof env !== 'object') return undefined
  return (env as { [MCP_ACTOR]?: McpActor })[MCP_ACTOR]
}
