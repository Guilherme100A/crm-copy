import { describe, expect, it } from 'vitest'
import { parseWaEvent, safeParseWaEvent, WA_EVENT_TYPES, WaEventParseError, type WaEvent } from './events'

const base = { v: 1 as const, session_id: 'sess-1', at: '2026-10-15T12:00:00.000Z' }
const media = { session_id: 'sess-1', message_id: 'm1', mime: 'image/jpeg', size: 10, sha256: 'abc', key: 'blobs/m1', status: 'ready' as const }

const samples: Record<(typeof WA_EVENT_TYPES)[number], WaEvent> = {
  'message.inbound': {
    ...base,
    type: 'message.inbound',
    message: {
      id: 'm1',
      from: '5511999999999@s.whatsapp.net',
      alt_jid: '123@lid',
      from_me: false,
      timestamp: 1760000000000,
      push_name: 'Ana',
      text: 'oi',
      type: 'imageMessage',
      media,
      quoted_id: 'm0',
      ad: { ctwa_clid: 'clid', source_id: 'ad-1', source_url: 'https://fb.me/x' },
    },
  },
  'message.status': { ...base, type: 'message.status', message_id: 'msg-1', transport_message_id: 'wamid-1', status: 'delivered' },
  'session.state': { ...base, type: 'session.state', from: 'WARMING', to: 'STABLE' },
  'session.connection': { ...base, type: 'session.connection', state: 'close', reason: 'forbidden', status_code: 403 },
  'session.qr': { ...base, type: 'session.qr', qr: 'data:image/png;base64,AAAA' },
  'session.pairing_code': { ...base, type: 'session.pairing_code', code: 'ABCD1234' },
  'contact.upsert': { ...base, type: 'contact.upsert', contact: { jid: '123@lid', phone: '+5511999999999', lid: '123@lid', name: 'Ana' } },
  'contact.lid_mapping': { ...base, type: 'contact.lid_mapping', lid: '123@lid', pn: '+5511999999999' },
  'presence.update': { ...base, type: 'presence.update', jid: '5511999999999@s.whatsapp.net', presence: 'composing' },
  'history.batch': {
    ...base,
    type: 'history.batch',
    sync_type: 'RECENT',
    messages: [{ id: 'h1', from: '5511999999999@s.whatsapp.net', from_me: true, timestamp: 1, type: 'conversation', text: 'antigo' }],
  },
}

describe('parseWaEvent', () => {
  it.each(WA_EVENT_TYPES)('aceita %s e faz round-trip JSON idêntico', (type) => {
    const event = samples[type]
    const json = JSON.stringify(event)
    const parsed = parseWaEvent(JSON.parse(json))
    expect(parsed).toEqual(event)
    expect(JSON.stringify(parsed)).toBe(json)
    expect(parseWaEvent(json)).toEqual(event)
  })

  it('preserva a ordem das chaves da entrada e descarta chaves desconhecidas', () => {
    const shuffled = { type: 'session.state', to: 'STABLE', at: base.at, from: null, session_id: 's', v: 1 }
    expect(JSON.stringify(parseWaEvent(shuffled))).toBe(JSON.stringify(shuffled))
    expect(parseWaEvent({ ...shuffled, extra: 1 })).not.toHaveProperty('extra')
  })

  it('cobre todos os tipos da SPEC 3.8', () => {
    expect([...WA_EVENT_TYPES].sort()).toEqual(Object.keys(samples).sort())
  })

  it.each([0, 2, '1', undefined])('rejeita v = %s', (v) => {
    expect(() => parseWaEvent({ ...samples['session.qr'], v })).toThrow(WaEventParseError)
  })

  it('rejeita tipo desconhecido, payload inválido e JSON quebrado', () => {
    expect(() => parseWaEvent({ ...base, type: 'message.unknown' })).toThrow(WaEventParseError)
    expect(() => parseWaEvent({ ...base, type: 'message.status', message_id: 'x', status: 'bogus' })).toThrow(WaEventParseError)
    expect(() => parseWaEvent({ ...base, type: 'session.qr', qr: 'x', at: 'ontem' })).toThrow(WaEventParseError)
    expect(() => parseWaEvent('{nope')).toThrow(WaEventParseError)
    expect(() => parseWaEvent(null)).toThrow(WaEventParseError)
  })

  it('safeParseWaEvent não lança e lista os problemas', () => {
    const bad = safeParseWaEvent({ ...base, type: 'session.state', from: null, to: 'NOPE' })
    expect(bad.success).toBe(false)
    if (!bad.success) expect(bad.error.issues.map((i) => i.path)).toContain('to')
    expect(safeParseWaEvent(samples['session.state'])).toEqual({ success: true, data: samples['session.state'] })
  })
})
