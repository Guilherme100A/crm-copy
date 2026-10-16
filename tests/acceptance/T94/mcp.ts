// Cliente MCP mínimo (Streamable HTTP, JSON-RPC 2.0) para a suíte T94, sem depender do SDK no pacote de testes.
// Protocolo conferido no @modelcontextprotocol/sdk 1.31.0 instalado (LATEST_PROTOCOL_VERSION '2025-11-25';
// POST exige Accept com application/json e text/event-stream; a resposta pode ser JSON ou SSE `event: message`;
// sessão opcional pelo header `mcp-session-id`).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export const PROTOCOL_VERSION = '2025-06-18'

export type Fetcher = (path: string, init: RequestInit) => Promise<Response>

export interface RpcResult {
  status: number
  headers: Headers
  /** Mensagem JSON-RPC da resposta (a do `id` pedido), ou `undefined` (202 / sem corpo). */
  message: Any
  text: string
}

/** Extrai as mensagens JSON-RPC de um corpo JSON ou SSE. */
export function parseMessages(text: string, contentType: string | null): Any[] {
  if (!text.trim()) return []
  if (contentType?.includes('text/event-stream')) {
    const out: Any[] = []
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n')
      if (data) {
        try {
          out.push(JSON.parse(data))
        } catch {
          /* bloco não-JSON */
        }
      }
    }
    return out
  }
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return []
  }
}

export class McpClient {
  sessionId: string | undefined
  private seq = 0

  constructor(
    private readonly fetcher: Fetcher,
    readonly path: string,
    private readonly token: string | null,
  ) {}

  headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTOCOL_VERSION,
      ...(this.token !== null ? { authorization: `Bearer ${this.token}` } : {}),
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
      ...extra,
    }
  }

  /** Envia uma requisição (com id) ou notificação (sem id). */
  async send(method: string, params?: Any, opts: { notification?: boolean } = {}): Promise<RpcResult> {
    const id = opts.notification ? undefined : ++this.seq
    const body = { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}), ...(id !== undefined ? { id } : {}) }
    const res = await this.fetcher(this.path, { method: 'POST', headers: this.headers(), body: JSON.stringify(body) })
    const text = await res.text()
    const sid = res.headers.get('mcp-session-id')
    if (sid) this.sessionId = sid
    const messages = parseMessages(text, res.headers.get('content-type'))
    return { status: res.status, headers: res.headers, message: messages.find((m) => m?.id === id) ?? messages[0], text }
  }

  /** initialize + notifications/initialized. Devolve o resultado do initialize. */
  async initialize(): Promise<RpcResult> {
    const init = await this.send('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'radar-t94', version: '1.0.0' } })
    if (init.status === 200 && init.message?.result) await this.send('notifications/initialized', undefined, { notification: true })
    return init
  }

  async listTools(): Promise<Any[]> {
    const r = await this.send('tools/list', {})
    if (r.status !== 200 || !r.message?.result) throw new Error(`tools/list: ${r.status} ${r.text}`)
    return r.message.result.tools
  }

  /** tools/call; devolve o `result` (com `isError`, `content`, `structuredContent`). */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<Any> {
    const r = await this.send('tools/call', { name, arguments: args })
    if (r.status !== 200 || !r.message) throw new Error(`tools/call ${name}: ${r.status} ${r.text}`)
    if (r.message.error) return { isError: true, error: r.message.error, content: [] }
    return r.message.result
  }
}

/** Dados de um resultado de ferramenta: `structuredContent` ou o JSON do 1º bloco de texto. */
export function toolData(result: Any): Any {
  if (result?.structuredContent !== undefined) return result.structuredContent
  const text = (result?.content ?? []).find((c: Any) => c?.type === 'text')?.text
  if (typeof text !== 'string') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
