import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENTS_KEY, voicesQuery } from '@/features/agents/api'
import { HttpError } from '@/lib/http'
import { VOICE_SAMPLE_MAX_BYTES, VOICES_KEY, voicesApi } from './api'
import { addSamples, formatBytes, isAudioFile, sampleError, voiceErrorKey, voiceFormError } from './form'

const f = (name: string, size = 1000, type = 'audio/mpeg') => ({ name, size, type })

afterEach(() => vi.restoreAllMocks())

describe('aba Vozes (AC-T92-03)', () => {
  it('a chave das vozes é a mesma do voicesQuery (lista e seletor das Configurações)', () => {
    expect(VOICES_KEY).toEqual(voicesQuery().queryKey)
    expect(VOICES_KEY[0]).toBe(AGENTS_KEY[0])
  })

  it('1 a 3 amostras de áudio até 10 MB', () => {
    expect(sampleError([])).toBe('count')
    expect(sampleError([f('a.mp3'), f('b.wav'), f('c.ogg')])).toBeNull()
    expect(sampleError([f('a.mp3'), f('b.mp3'), f('c.mp3'), f('d.mp3')])).toBe('count')
    expect(sampleError([f('a.mp3', VOICE_SAMPLE_MAX_BYTES + 1)])).toBe('tooLarge')
    expect(sampleError([f('a.mp3', 0)])).toBe('empty')
    expect(sampleError([f('a.txt', 10, 'text/plain')])).toBe('unsupported')
    expect(isAudioFile({ name: 'gravacao', type: 'audio/webm;codecs=opus' })).toBe(true)
    expect(isAudioFile({ name: 'voz.FLAC', type: '' })).toBe(true)
    expect(isAudioFile({ name: 'x.pdf', type: 'application/pdf' })).toBe(false)
  })

  it('anexar mais que 3 corta no máximo e avisa', () => {
    expect(addSamples([1], [2, 3])).toEqual({ files: [1, 2, 3], overflow: false })
    expect(addSamples([1, 2], [3, 4])).toEqual({ files: [1, 2, 3], overflow: true })
  })

  it('nome obrigatório (1 a 100) antes das amostras', () => {
    expect(voiceFormError('  ', [f('a.mp3')])).toBe('name')
    expect(voiceFormError('x'.repeat(101), [f('a.mp3')])).toBe('name')
    expect(voiceFormError('Minha voz', [])).toBe('count')
    expect(voiceFormError('Minha voz', [f('a.mp3')])).toBeNull()
  })

  it('erros do servidor pelo error_code', () => {
    const e = (code: string, status: number, errorCode?: string) => new HttpError(status, code, 'x', errorCode ? { error_code: errorCode } : undefined)
    expect(voiceErrorKey(e('VALIDATION_ERROR', 422, 'provider_not_configured'))).toBe('notConfigured')
    expect(voiceErrorKey(e('VALIDATION_ERROR', 422, 'audios_count'))).toBe('count')
    expect(voiceErrorKey(e('VALIDATION_ERROR', 422, 'unsupported_audio'))).toBe('unsupported')
    expect(voiceErrorKey(e('PAYLOAD_TOO_LARGE', 413, 'too_large'))).toBe('tooLarge')
    expect(voiceErrorKey(e('QUOTA_EXCEEDED', 429))).toBe('quota')
    expect(voiceErrorKey(e('UPSTREAM_ERROR', 502))).toBe('upstream')
    expect(voiceErrorKey(e('NOT_FOUND', 404))).toBe('notFound')
    expect(voiceErrorKey(new Error('x'))).toBe('generic')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
  })

  it('criar envia name, language e as amostras em audios (multipart)', async () => {
    const http = await import('@/lib/http')
    const post = vi.spyOn(http.api, 'post').mockResolvedValue({ voice: { id: 'v1' } })
    const files = [new File(['a'], 'a.mp3', { type: 'audio/mpeg' }), new File(['b'], 'b.wav', { type: 'audio/wav' })]
    expect(await voicesApi.create({ name: 'Voz', language: 'pt', audios: files })).toEqual({ id: 'v1' })
    const [path, body] = post.mock.calls[0]!
    expect(path).toBe('/api/ai-voices')
    const form = body as FormData
    expect(form.get('name')).toBe('Voz')
    expect(form.get('language')).toBe('pt')
    expect(form.getAll('audios').map((x) => (x as File).name)).toEqual(['a.mp3', 'b.wav'])
  })

  it('manter e excluir chamam as rotas da voz', async () => {
    const http = await import('@/lib/http')
    const post = vi.spyOn(http.api, 'post').mockResolvedValue({ voice: { id: 'v1', status: 'kept' } })
    const del = vi.spyOn(http.api, 'delete').mockResolvedValue({ deleted: true, removed_from_agents: [{ id: 'a', name: 'Lia' }], warning: 'w' })
    expect(await voicesApi.keep('v1')).toMatchObject({ status: 'kept' })
    expect(post).toHaveBeenCalledWith('/api/ai-voices/v1/keep')
    expect((await voicesApi.remove('v1')).removed_from_agents).toEqual([{ id: 'a', name: 'Lia' }])
    expect(del).toHaveBeenCalledWith('/api/ai-voices/v1')
  })

  it('prévia lê o áudio binário; erro JSON vira HttpError', async () => {
    const ok = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/mpeg' } }))
    const blob = await voicesApi.preview('v1', ok as unknown as typeof fetch)
    expect(blob.size).toBe(3)
    const [url, init] = ok.mock.calls[0]! as unknown as [string, RequestInit]
    expect(url).toContain('/api/ai-voices/v1/preview')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['X-Requested-With']).toBe('crm')
    const fail = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: 'QUOTA_EXCEEDED', message: 'Sem saldo', details: {} } }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const err = await voicesApi.preview('v1', fail as unknown as typeof fetch).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect(voiceErrorKey(err)).toBe('quota')
  })
})
