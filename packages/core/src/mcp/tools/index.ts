// Ferramentas MCP via API do CRM, por área. A ordem define a ordem em `tools/list`.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { conversationsTools } from './conversations'
import { flowsTools } from './flows'
import { insightsTools } from './insights'
import { paymentsTools } from './payments'
import { pixelsTools } from './pixels'
import { registerApiTools, type McpApiContext } from './shared'

export const MCP_API_TOOLS = [...conversationsTools, ...flowsTools, ...insightsTools, ...pixelsTools, ...paymentsTools] as const

export function registerAllApiTools(server: McpServer, ctx: McpApiContext): string[] {
  return registerApiTools(server, ctx, MCP_API_TOOLS)
}

export type { HttpMethod, McpApi, McpApiContext, McpApiRequest, McpApiResponse } from './shared'
