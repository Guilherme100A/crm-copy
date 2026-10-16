import { describe, expect, it } from 'vitest'
import * as port from '@crm/wa-port'
import { EVENT_TYPES, firstAccepted, jsonClone, tryParse } from './support'

const parse = (x: unknown) => (port as any).parseWaEvent(x)

describe('T03 — WaEvent v1 / parseWaEvent', () => {
  it('AC-T03-01 @crm/wa-port exporta parseWaEvent', () => {
    expect(typeof (port as any).parseWaEvent).toBe('function')
  })

  for (const type of EVENT_TYPES) {
    it(`AC-T03-01 aceita ${type} com payload válido e faz round-trip JSON idêntico`, () => {
      const { input, parsed, errors } = firstAccepted(parse, type)
      expect(input, `nenhuma forma válida de ${type} aceita:\n${errors.join('\n')}`).toBeDefined()
      expect(parsed.type).toBe(type)
      expect(parsed.v).toBe(1)
      // nada é perdido nem acrescentado pela validação
      expect(jsonClone(parsed)).toEqual(input)
      // parse(JSON.parse(JSON.stringify(ev))) devolve o mesmo evento
      const again = tryParse(parse, JSON.parse(JSON.stringify(parsed)))
      expect(again.ok, again.ok ? '' : again.error).toBe(true)
      expect(jsonClone((again as any).value)).toEqual(jsonClone(parsed))
      expect(JSON.stringify(jsonClone((again as any).value))).toBe(JSON.stringify(jsonClone(parsed)))
    })

    it(`AC-T03-01 rejeita ${type} com v !== 1`, () => {
      const { input } = firstAccepted(parse, type)
      expect(input, `nenhuma forma válida de ${type} aceita`).toBeDefined()
      for (const v of [0, 2, '1', null]) {
        const r = tryParse(parse, { ...input, v })
        expect(r.ok, `${type} com v=${JSON.stringify(v)} deveria ser rejeitado`).toBe(false)
      }
      const { v: _omit, ...noV } = input as Record<string, unknown>
      expect(tryParse(parse, noV).ok, `${type} sem v deveria ser rejeitado`).toBe(false)
    })
  }

  it('AC-T03-01 rejeita type fora do catálogo e entradas que não são evento', () => {
    const { input } = firstAccepted(parse, 'session.state')
    expect(input).toBeDefined()
    for (const type of ['message.unknown', 'contact.lid-mapping', 'session.pairing-code', '', 'MESSAGE.INBOUND']) {
      expect(tryParse(parse, { ...input, type }).ok, `type "${type}" deveria ser rejeitado`).toBe(false)
    }
    for (const junk of [null, undefined, 42, 'texto', [], {}, { v: 1 }]) {
      expect(tryParse(parse, junk).ok, `${JSON.stringify(junk)} deveria ser rejeitado`).toBe(false)
    }
  })

  it('AC-T03-01 rejeita payload sem o id da sessão', () => {
    const { input } = firstAccepted(parse, 'message.status')
    expect(input).toBeDefined()
    const { session_id: _a, sessionId: _b, ...rest } = input as Record<string, unknown>
    expect(tryParse(parse, rest).ok).toBe(false)
  })
})
