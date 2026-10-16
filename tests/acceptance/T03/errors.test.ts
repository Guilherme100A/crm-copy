import { describe, expect, it } from 'vitest'
import * as port from '@crm/wa-port'

// Tabela do pipeline do ai-manager (AI-MANAGER-MAP §4).
const TABLE: Array<[string, number]> = [
  ['UNAUTHORIZED', 401],
  ['SESSION_NOT_FOUND', 404],
  ['SESSION_NOT_CONNECTED', 409],
  ['CONTACT_NOT_ALLOWED', 403],
  ['WARMUP_LIMIT', 429],
  ['RATE_LIMIT', 429],
]

describe('T03 — SendRejectedError', () => {
  it('AC-T03-02 @crm/wa-port exporta SendRejectedError', () => {
    expect(typeof (port as any).SendRejectedError).toBe('function')
  })

  for (const [code, status] of TABLE) {
    it(`AC-T03-02 SendRejectedError('${code}') expõe code=${code} e status=${status}`, () => {
      const Err = (port as any).SendRejectedError
      const e = new Err(code, `rejeitado: ${code}`)
      expect(e).toBeInstanceOf(Error)
      expect(e).toBeInstanceOf(Err)
      expect(e.code).toBe(code)
      expect(e.status).toBe(status)
      expect(e.message).toBe(`rejeitado: ${code}`)
      expect(e.name).toBe('SendRejectedError')
    })
  }
})
