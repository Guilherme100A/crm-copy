import type { WaEvent } from '@crm/wa-port'
import { describe, expect, it } from 'vitest'
import { canonicalJson, waEventKey } from './idempotency'

const at = '2026-10-15T12:00:00.000Z'

describe('waEventKey', () => {
  it('message.inbound usa (session_id, message.id)', () => {
    const e: WaEvent = {
      v: 1,
      type: 'message.inbound',
      session_id: 's1',
      at,
      message: { id: 'm1', from: '1@s.whatsapp.net', from_me: false, timestamp: 1, type: 'conversation', text: 'a' },
    }
    expect(waEventKey(e)).toBe('message.inbound:s1:m1')
    expect(waEventKey({ ...e, at: '2026-10-16T00:00:00.000Z', message: { ...e.message, text: 'b' } })).toBe('message.inbound:s1:m1')
  })

  it('message.status inclui o status', () => {
    const e: WaEvent = { v: 1, type: 'message.status', session_id: 's1', at, message_id: 'x', status: 'sent' }
    expect(waEventKey(e)).toBe('message.status:s1:x:sent')
    expect(waEventKey({ ...e, status: 'read' })).toBe('message.status:s1:x:read')
  })

  it('demais tipos: hash do JSON canônico (mesmo payload em outra ordem → mesma chave)', () => {
    const a: WaEvent = { v: 1, type: 'session.state', session_id: 's1', at, from: 'WARMING', to: 'STABLE' }
    const b = { to: 'STABLE', from: 'WARMING', at, session_id: 's1', type: 'session.state', v: 1 } as WaEvent
    expect(waEventKey(a)).toBe(waEventKey(b))
    expect(waEventKey(a)).toMatch(/^session\.state:[0-9a-f]{64}$/)
    expect(waEventKey({ ...a, to: 'DEGRADED' })).not.toBe(waEventKey(a))
  })

  it('canonicalJson ordena chaves e ignora undefined', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: undefined }] })).toBe('{"a":[{"d":2}],"b":1}')
  })
})
