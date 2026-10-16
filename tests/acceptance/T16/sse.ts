// Cliente SSE caixa-preta (text/event-stream) sobre fetch ou app.request(), com leitura incremental.
export interface SseMessage {
  event: string
  id?: string
  data: string
  retry?: number
  /** instante de chegada (ms) */
  at: number
}

export type Fetcher = (url: string, init: RequestInit) => Response | Promise<Response>

export interface SseConnectOptions {
  cookie?: string
  lastEventId?: string
  headers?: Record<string, string>
}

export interface SseConnection {
  status: number
  headers: Headers
  /** corpo já lido quando a resposta não é um stream (ex.: 401/404) */
  text?: string
  messages: SseMessage[]
  /** resolve quando o servidor encerra o stream */
  ended: Promise<void>
  isEnded: () => boolean
  /** espera a próxima mensagem que satisfaça o predicado (procura também nas já recebidas a partir de `from`) */
  waitFor: (pred: (m: SseMessage) => boolean, timeoutMs?: number, from?: number) => Promise<SseMessage>
  events: (type?: string) => SseMessage[]
  close: () => Promise<void>
}

export async function connectSse(fetcher: Fetcher, path: string, opts: SseConnectOptions = {}): Promise<SseConnection> {
  const ctrl = new AbortController()
  const headers: Record<string, string> = { accept: 'text/event-stream', ...(opts.headers ?? {}) }
  if (opts.cookie) headers.cookie = opts.cookie
  if (opts.lastEventId) headers['last-event-id'] = opts.lastEventId
  const res = await fetcher(path, { method: 'GET', headers, signal: ctrl.signal })

  const messages: SseMessage[] = []
  const waiters = new Set<() => void>()
  const notify = () => {
    for (const w of [...waiters]) w()
  }
  let ended = false
  let resolveEnded!: () => void
  const endedP = new Promise<void>((r) => (resolveEnded = r))
  const markEnded = () => {
    if (ended) return
    ended = true
    resolveEnded()
    notify()
  }

  const isStream = res.ok && (res.headers.get('content-type') ?? '').includes('text/event-stream') && res.body
  let text: string | undefined
  const reader = isStream ? res.body!.getReader() : null
  if (!reader) {
    text = await res.text().catch(() => '')
    markEnded()
  } else {
    const decoder = new TextDecoder()
    let buf = ''
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n')
          let idx: number
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            const msg: SseMessage = { event: 'message', data: '', at: Date.now() }
            const data: string[] = []
            let any = false
            for (const line of block.split('\n')) {
              if (!line || line.startsWith(':')) continue
              const c = line.indexOf(':')
              const field = c < 0 ? line : line.slice(0, c)
              const val = c < 0 ? '' : line.slice(c + 1).replace(/^ /, '')
              any = true
              if (field === 'event') msg.event = val
              else if (field === 'data') data.push(val)
              else if (field === 'id') msg.id = val
              else if (field === 'retry') msg.retry = Number(val)
            }
            if (!any) continue
            msg.data = data.join('\n')
            messages.push(msg)
          }
          notify()
        }
      } catch {
        /* abortado */
      } finally {
        markEnded()
      }
    })()
  }

  const waitFor = (pred: (m: SseMessage) => boolean, timeoutMs = 10_000, from = 0) =>
    new Promise<SseMessage>((resolve, reject) => {
      const check = () => {
        const found = messages.slice(from).find(pred)
        if (found) {
          cleanup()
          resolve(found)
        } else if (ended) {
          cleanup()
          reject(new Error(`stream encerrado sem a mensagem esperada; recebidas: ${summary(messages)}`))
        }
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`timeout (${timeoutMs} ms) esperando mensagem SSE; recebidas: ${summary(messages)}`))
      }, timeoutMs)
      const cleanup = () => {
        clearTimeout(timer)
        waiters.delete(check)
      }
      waiters.add(check)
      check()
    })

  return {
    status: res.status,
    headers: res.headers,
    text,
    messages,
    ended: endedP,
    isEnded: () => ended,
    waitFor,
    events: (type?: string) => messages.filter((m) => m.event !== 'ping' && (type === undefined || m.event === type)),
    close: async () => {
      ctrl.abort()
      await reader?.cancel().catch(() => {})
      markEnded()
    },
  }
}

export const summary = (ms: SseMessage[]) => JSON.stringify(ms.map((m) => `${m.event}${m.id ? `#${m.id}` : ''}`).slice(-20))

export const envelopeOf = (m: SseMessage) => JSON.parse(m.data) as { id: string; type: string; company_id: string; at: string; data: any }

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
