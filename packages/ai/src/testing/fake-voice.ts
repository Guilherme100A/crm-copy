// FakeTts / FakeStt: determinísticos, sem rede (SPEC 3.10).
import { createHash } from 'node:crypto'
import { TTS_MIME, type SttProvider, type SttRequest, type SttResult, type TtsProvider, type TtsRequest, type TtsResult } from '../port/voice'

const MAGIC = new TextEncoder().encode('FAKETTS1')

/** Bytes determinísticos por (texto, voz): cabeçalho fixo + SHA-256 encadeado; tamanho cresce com o texto. */
export function fakeTtsBytes(textValue: string, voiceId: string): Uint8Array {
  const size = MAGIC.length + Math.max(32, textValue.length * 8)
  const out = new Uint8Array(size)
  out.set(MAGIC, 0)
  let offset = MAGIC.length
  for (let block = 0; offset < size; block++) {
    const digest = createHash('sha256').update(`${voiceId}\u0000${textValue}\u0000${block}`).digest()
    const chunk = digest.subarray(0, Math.min(digest.length, size - offset))
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

export class FakeTts implements TtsProvider {
  readonly calls: TtsRequest[] = []

  get callCount(): number {
    return this.calls.length
  }

  async synthesize(req: TtsRequest): Promise<TtsResult> {
    req.signal?.throwIfAborted()
    this.calls.push(req)
    return { audio: fakeTtsBytes(req.text, req.voiceId), mime: TTS_MIME[req.format] ?? 'application/octet-stream', chars: req.text.length }
  }
}

export interface FakeSttOptions {
  /** Texto devolvido (fixo ou calculado pelo request). */
  text?: string | ((req: SttRequest) => string)
  /** Duração fixa; padrão `max(1, bytes / 16000)`. */
  seconds?: number
  language?: string
}

export class FakeStt implements SttProvider {
  readonly calls: SttRequest[] = []

  constructor(private readonly opts: FakeSttOptions = {}) {}

  get callCount(): number {
    return this.calls.length
  }

  async transcribe(req: SttRequest): Promise<SttResult> {
    req.signal?.throwIfAborted()
    this.calls.push(req)
    const { text: t = '', seconds, language } = this.opts
    return {
      text: typeof t === 'function' ? t(req) : t,
      seconds: seconds ?? Math.max(1, req.audio.byteLength / 16000),
      language: language ?? req.language,
    }
  }
}
