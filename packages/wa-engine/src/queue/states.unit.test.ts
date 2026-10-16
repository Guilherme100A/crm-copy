import { describe, expect, it } from 'vitest'
import { phoneToJid } from './jid'
import { canTransitionMessage, CANCELLABLE_STATUSES, MESSAGE_STATUSES, MESSAGE_TRANSITIONS } from './states'
import type { Database } from '../db'
import { MessageQueue, MessageQueueConfigError, queueName, toConnectionOptions } from './queue'

describe('estados da mensagem (SPEC 3.3)', () => {
  it('caminho feliz queued → processing → sent → delivered → read', () => {
    expect(canTransitionMessage('queued', 'processing')).toBe(true)
    expect(canTransitionMessage('processing', 'sent')).toBe(true)
    expect(canTransitionMessage('sent', 'delivered')).toBe(true)
    expect(canTransitionMessage('delivered', 'read')).toBe(true)
  })

  it('retry e falha', () => {
    expect(canTransitionMessage('processing', 'retrying')).toBe(true)
    expect(canTransitionMessage('retrying', 'processing')).toBe(true)
    expect(canTransitionMessage('processing', 'failed')).toBe(true)
  })

  it('cancelamento só antes do envio', () => {
    expect(CANCELLABLE_STATUSES).toEqual(['queued', 'retrying'])
    for (const s of ['sent', 'delivered', 'read', 'failed', 'cancelled', 'processing'] as const) {
      expect(canTransitionMessage(s, 'cancelled')).toBe(false)
    }
  })

  it('estados terminais não saem', () => {
    for (const s of ['read', 'failed', 'cancelled'] as const) expect(MESSAGE_TRANSITIONS[s]).toEqual([])
    for (const s of MESSAGE_STATUSES) expect(canTransitionMessage(s, s)).toBe(false)
  })
})

describe('helpers', () => {
  it('phoneToJid', () => {
    expect(phoneToJid('+5511999999999')).toBe('5511999999999@s.whatsapp.net')
    expect(phoneToJid('5511@s.whatsapp.net')).toBe('5511@s.whatsapp.net')
    expect(() => phoneToJid('+')).toThrow()
  })

  it('queueName é session:<id>', () => {
    expect(queueName('abc')).toBe('session:abc')
  })

  it('toConnectionOptions converte url', () => {
    expect(toConnectionOptions({ url: 'redis://user:p%40ss@h:6380/2' })).toEqual({ host: 'h', port: 6380, username: 'user', password: 'p@ss', db: 2 })
    expect(toConnectionOptions({ host: 'x', port: 1 })).toEqual({ host: 'x', port: 1 })
  })

  it('fila consumidora exige deliver (ponto único send/deliver); só produtora não', () => {
    const db = {} as Database
    expect(() => new MessageQueue({ db })).toThrow(MessageQueueConfigError)
    expect(() => new MessageQueue({ db, consume: false })).not.toThrow()
  })
})
