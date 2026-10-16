// FakeElevenLabsVoices (T80): servidor HTTP local que imita a ElevenLabs para vozes — Instant Voice Cloning
// (`POST /v1/voices/add`, multipart), exclusão (`DELETE /v1/voices/:id`) e TTS (`POST /v1/text-to-speech/:id`).
// Confere o header `xi-api-key` contra as chaves aceitas (vazio = qualquer). Nunca a ElevenLabs real.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeClone {
  voiceId: string
  apiKey: string
  name: string
  labels: Record<string, unknown> | null
  files: { filename: string; type: string; size: number }[]
}

export interface FakeTtsCall {
  voiceId: string
  apiKey: string
  text: string
  modelId: string | null
  outputFormat: string | null
}

export class FakeElevenLabsVoices {
  readonly clones: FakeClone[] = []
  readonly deleted: string[] = []
  readonly ttsCalls: FakeTtsCall[] = []
  /** Chaves aceitas; vazio = aceita qualquer `xi-api-key` não vazia. */
  readonly apiKeys = new Set<string>()
  url = ''
  private server: Server | undefined
  private failures: number[] = []
  private seq = 0

  async start(): Promise<{ url: string; close(): Promise<void> }> {
    this.server = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', () => r()))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    return { url: this.url, close: () => this.close() }
  }

  async close(): Promise<void> {
    const s = this.server
    this.server = undefined
    if (!s) return
    await new Promise<void>((r) => {
      s.close(() => r())
      s.closeAllConnections()
    })
  }

  /** A próxima requisição responde este status HTTP. */
  failNext(status: number): void {
    this.failures.push(status)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const raw = Buffer.concat(chunks)
    const url = new URL(req.url ?? '/', this.url)
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const fail = this.failures.shift()
    if (fail) return json(fail, { detail: { status: 'fake_failure', message: `falha simulada ${fail}` } })
    const apiKey = String(req.headers['xi-api-key'] ?? '')
    if (!apiKey || (this.apiKeys.size && !this.apiKeys.has(apiKey))) return json(401, { detail: { status: 'invalid_api_key', message: 'Invalid API key' } })

    if (req.method === 'POST' && url.pathname === '/v1/voices/add') {
      const form = await new Request(url, { method: 'POST', headers: { 'content-type': String(req.headers['content-type'] ?? '') }, body: raw }).formData()
      const files = form.getAll('files').filter((f) => typeof f !== 'string') as unknown as { name: string; type: string; size: number }[]
      const name = String(form.get('name') ?? '')
      if (!name || !files.length) return json(422, { detail: [{ loc: ['body', !name ? 'name' : 'files'], msg: 'field required', type: 'missing' }] })
      const labelsRaw = form.get('labels')
      const voiceId = `fake-voice-${++this.seq}`
      this.clones.push({
        voiceId,
        apiKey,
        name,
        labels: typeof labelsRaw === 'string' ? (JSON.parse(labelsRaw) as Record<string, unknown>) : null,
        files: files.map((f) => ({ filename: f.name, type: f.type, size: f.size })),
      })
      return json(200, { voice_id: voiceId, requires_verification: false })
    }
    const del = /^\/v1\/voices\/([^/]+)$/.exec(url.pathname)
    if (req.method === 'DELETE' && del) {
      this.deleted.push(decodeURIComponent(del[1]!))
      return json(200, { status: 'ok' })
    }
    const tts = /^\/v1\/text-to-speech\/([^/]+)$/.exec(url.pathname)
    if (req.method === 'POST' && tts) {
      const body = JSON.parse(raw.toString('utf8') || '{}') as { text?: string; model_id?: string }
      const voiceId = decodeURIComponent(tts[1]!)
      this.ttsCalls.push({ voiceId, apiKey, text: body.text ?? '', modelId: body.model_id ?? null, outputFormat: url.searchParams.get('output_format') })
      res.writeHead(200, { 'content-type': 'audio/mpeg' })
      // "MP3" de mentira: cabeçalho ID3 + o texto (para conferir no teste).
      res.end(Buffer.concat([Buffer.from('ID3'), Buffer.from(`${voiceId}:${body.text ?? ''}`, 'utf8')]))
      return
    }
    return json(404, { detail: { status: 'not_found', message: `fake: ${req.method} ${url.pathname}` } })
  }
}
