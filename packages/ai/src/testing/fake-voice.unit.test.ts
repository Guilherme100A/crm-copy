import { describe, expect, it } from 'vitest'
import { FakeStt, FakeTts } from './fake-voice'

describe('FakeTts (AC-T04-05)', () => {
  it('bytes determinísticos por (texto, voz)', async () => {
    const tts = new FakeTts()
    const a = await tts.synthesize({ text: 'olá', voiceId: 'v1', format: 'mp3' })
    const b = await new FakeTts().synthesize({ text: 'olá', voiceId: 'v1', format: 'mp3' })
    const c = await tts.synthesize({ text: 'olá', voiceId: 'v2', format: 'mp3' })
    const d = await tts.synthesize({ text: 'oi', voiceId: 'v1', format: 'ogg_opus' })
    expect(a.audio).toBeInstanceOf(Uint8Array)
    expect(Buffer.from(a.audio).equals(Buffer.from(b.audio))).toBe(true)
    expect(Buffer.from(a.audio).equals(Buffer.from(c.audio))).toBe(false)
    expect(Buffer.from(a.audio).equals(Buffer.from(d.audio))).toBe(false)
    expect(a).toMatchObject({ mime: 'audio/mpeg', chars: 3 })
    expect(d.mime).toBe('audio/ogg')
    expect(tts.callCount).toBe(3)
  })
})

describe('FakeStt (AC-T04-05)', () => {
  it('devolve o texto configurado e seconds > 0', async () => {
    const stt = new FakeStt({ text: 'olá mundo' })
    const r = await stt.transcribe({ audio: new Uint8Array(100), mime: 'audio/ogg', language: 'pt' })
    expect(r.text).toBe('olá mundo')
    expect(r.seconds).toBeGreaterThan(0)
    expect(r.language).toBe('pt')
    expect((await new FakeStt({ seconds: 2.5 }).transcribe({ audio: new Uint8Array(1), mime: 'audio/ogg' })).seconds).toBe(2.5)
    expect((await new FakeStt().transcribe({ audio: new Uint8Array(48000), mime: 'audio/ogg' })).seconds).toBe(3)
  })
})
