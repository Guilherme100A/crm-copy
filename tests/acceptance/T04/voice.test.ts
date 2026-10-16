import { describe, expect, it } from 'vitest'
import { exp, fakes, toBytes } from './contract'

const T = '@crm/ai/testing'

describe('T04 — FakeTts / FakeStt', () => {
  it('AC-T04-05 FakeTts devolve bytes determinísticos por (texto, voz)', async () => {
    const FakeTts = exp(fakes, 'FakeTts', T)
    const a = new FakeTts()
    const b = new FakeTts()
    const req = { text: 'Olá, tudo bem?', voiceId: 'voz-1', format: 'mp3' }

    const r1 = await a.synthesize(req)
    const r2 = await a.synthesize({ ...req })
    const r3 = await b.synthesize({ ...req }) // outra instância: mesmo resultado
    const bytes1 = toBytes(r1.audio)
    expect(bytes1.length).toBeGreaterThan(0)
    expect(toBytes(r2.audio)).toEqual(bytes1)
    expect(toBytes(r3.audio)).toEqual(bytes1)
    expect(typeof r1.mime).toBe('string')
    expect(r1.mime.length).toBeGreaterThan(0)
    expect(r1.chars).toBe(req.text.length)

    const otherText = toBytes((await a.synthesize({ ...req, text: 'Outro texto' })).audio)
    const otherVoice = toBytes((await a.synthesize({ ...req, voiceId: 'voz-2' })).audio)
    expect(otherText).not.toEqual(bytes1)
    expect(otherVoice).not.toEqual(bytes1)
  })

  it('AC-T04-05 FakeStt devolve o texto configurado e seconds > 0', async () => {
    const FakeStt = exp(fakes, 'FakeStt', T)
    const stt = new FakeStt({ text: 'quero comprar o plano anual' })
    for (const audio of [new Uint8Array([1, 2, 3]), new Uint8Array(64_000)]) {
      const r = await stt.transcribe({ audio, mime: 'audio/ogg', language: 'pt' })
      expect(r.text).toBe('quero comprar o plano anual')
      expect(typeof r.seconds).toBe('number')
      expect(r.seconds).toBeGreaterThan(0)
    }
  })

  it('AC-T04-05 o áudio do FakeTts transcrito pelo FakeStt devolve o texto configurado', async () => {
    const tts = new (exp(fakes, 'FakeTts', T))()
    const stt = new (exp(fakes, 'FakeStt', T))({ text: 'olá' })
    const { audio, mime } = await tts.synthesize({ text: 'olá', voiceId: 'v', format: 'ogg_opus' })
    const r = await stt.transcribe({ audio: toBytes(audio), mime })
    expect(r.text).toBe('olá')
    expect(r.seconds).toBeGreaterThan(0)
  })
})
