// Servidor MCP (T94): credenciais (token estático ou OAuth) e ferramentas por empresa; as de `./tools` chamam a API
// como o usuário dono da credencial.
export * from './credentials'
export * from './server'
export { MCP_API_TOOLS, registerAllApiTools } from './tools/index'
export type { HttpMethod, McpApi, McpApiContext, McpApiRequest, McpApiResponse } from './tools/index'
