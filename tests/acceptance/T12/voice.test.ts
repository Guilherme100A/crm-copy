// AC-T12-04: ElevenLabsTts e GroqStt com fetch injetado: modelo, voz/idioma e mapeamento de erros sem vazar a chave.
import { beforeAll, describe, expect, it } from 'vitest'
import { eleven, fakeFetch, groq, jsonResponse, port } from './support'

const EL_KEY = 'el-secret-key-ABC123'
const GROQ_KEY = 'gsk_secret_key_XYZ789'

let ElevenLabsTts: any
let GroqStt: any
let LlmUpstreamError: any

beforeAll(async () => {
  ;({ ElevenLabsTts } = await eleven())
  ;({ GroqStt } = await groq())
  ;({ LlmUpstreamError } = await port())
})

const audioBytes = new Uint8Array([79, 103, 103, 83, 0, 2, 0, 0])

describe('T12 — ElevenLabsTts', () => {
  it('AC-T12-04 envia voz, modelo padrão e formato opus; devolve áudio, mime e caracteres', async () => {
    const f = fakeFetch(() => new Response(audioBytes, { status: 200, headers: { 'content-type': 'audio/ogg' } }))
    const tts = new ElevenLabsTts({ apiKey: EL_KEY, fetch: f })
    const r = await tts.synthesize({ text: 'Olá, tudo bem?', voiceId: 'voz-123', format: 'ogg_opus' })
    expect(f.calls).toHaveLength(1)
    const c = f.calls[0]!
    const u = new URL(c.url)
    expect(c.method).toBe('POST')
    expect(u.pathname).toBe('/v1/text-to-speech/voz-123')
    expect(u.searchParams.get('output_format') ?? '').toMatch(/^opus_48000/)
    expect(c.headers.get('xi-api-key')).toBe(EL_KEY)
    expect(c.body).toMatchObject({ text: 'Olá, tudo bem?', model_id: 'eleven_flash_v2_5' })
    expect(Buffer.from(r.audio)).toEqual(Buffer.from(audioBytes))
    expect(r.mime).toContain('audio/ogg')
    expect(r.chars).toBe('Olá, tudo bem?'.length)
  })

  it('AC-T12-04 modelo informado no pedido substitui o padrão', async () => {
    const f = fakeFetch(() => new Response(audioBytes, { status: 200 }))
    const tts = new ElevenLabsTts({ apiKey: EL_KEY, fetch: f })
    await tts.synthesize({ text: 'oi', voiceId: 'v2', format: 'mp3', model: 'eleven_multilingual_v2' })
    expect((f.calls[0]!.body as any).model_id).toBe('eleven_multilingual_v2')
    expect(new URL(f.calls[0]!.url).searchParams.get('output_format') ?? '').toMatch(/^mp3_/)
  })

  for (const status of [401, 429, 500, 503]) {
    it(`AC-T12-04 HTTP ${status} vira LlmUpstreamError sem a chave na mensagem`, async () => {
      const f = fakeFetch(() => jsonResponse(status, { detail: { status: 'erro', message: `chave ${EL_KEY} inválida` } }))
      const tts = new ElevenLabsTts({ apiKey: EL_KEY, fetch: f })
      const err: any = await tts.synthesize({ text: 'oi', voiceId: 'v', format: 'mp3' }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(LlmUpstreamError)
      expect(err.code).toBe('UPSTREAM_ERROR')
      expect(err.details?.status).toBe(status)
      expect(err.details?.provider).toBe('elevenlabs')
      expect(String(err.message)).not.toContain(EL_KEY)
      expect(JSON.stringify(err.details ?? {})).not.toContain(EL_KEY)
    })
  }
})

describe('T12 — GroqStt', () => {
  it('AC-T12-04 envia whisper-large-v3-turbo, idioma pt e Bearer; devolve texto e duração', async () => {
    const f = fakeFetch(() => jsonResponse(200, { text: 'olá mundo', duration: 3.4, language: 'portuguese' }))
    // host falso explícito: a URL é montada a partir da baseUrl configurável (nenhum host real nos testes)
    const stt = new GroqStt({ apiKey: GROQ_KEY, fetch: f, baseUrl: 'http://groq.fake.test/openai/v1' })
    const r = await stt.transcribe({ audio: audioBytes, mime: 'audio/ogg' })
    expect(f.calls).toHaveLength(1)
    const c = f.calls[0]!
    expect(c.method).toBe('POST')
    expect(c.url).toBe('http://groq.fake.test/openai/v1/audio/transcriptions')
    expect(c.headers.get('authorization')).toBe(`Bearer ${GROQ_KEY}`)
    const form = c.body as FormData
    expect(form).toBeInstanceOf(FormData)
    expect(form.get('model')).toBe('whisper-large-v3-turbo')
    expect(form.get('language')).toBe('pt')
    expect(form.get('file')).toBeTruthy()
    expect(r.text).toBe('olá mundo')
    expect(r.seconds).toBeCloseTo(3.4)
  })

  it('AC-T12-04 idioma do pedido é respeitado', async () => {
    const f = fakeFetch(() => jsonResponse(200, { text: 'hola', duration: 1 }))
    const stt = new GroqStt({ apiKey: GROQ_KEY, fetch: f })
    await stt.transcribe({ audio: audioBytes, mime: 'audio/ogg', language: 'es' })
    expect((f.calls[0]!.body as FormData).get('language')).toBe('es')
  })

  for (const status of [401, 429, 500, 502]) {
    it(`AC-T12-04 HTTP ${status} vira LlmUpstreamError sem a chave na mensagem`, async () => {
      const f = fakeFetch(() => jsonResponse(status, { error: { message: `Invalid API Key ${GROQ_KEY}` } }))
      const stt = new GroqStt({ apiKey: GROQ_KEY, fetch: f })
      const err: any = await stt.transcribe({ audio: audioBytes, mime: 'audio/ogg' }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(LlmUpstreamError)
      expect(err.code).toBe('UPSTREAM_ERROR')
      expect(err.details?.status).toBe(status)
      expect(err.details?.provider).toBe('groq')
      expect(String(err.message)).not.toContain(GROQ_KEY)
      expect(JSON.stringify(err.details ?? {})).not.toContain(GROQ_KEY)
    })
  }
})
