import { describe, expect, it } from 'vitest'
import { deriveConnectionStatus, type ConnectionStatusInput } from './status'

const base: ConnectionStatusInput = { sessionState: 'STABLE', connectionState: 'open', lastDisconnectReason: null }

describe('deriveConnectionStatus', () => {
  it.each<[string, Partial<ConnectionStatusInput>, string]>([
    ['STABLE + aberto → connected', {}, 'connected'],
    ['STABLE com estado desconhecido conta como aberto', { connectionState: null }, 'connected'],
    ['WARMING aberto → connected', { sessionState: 'WARMING' }, 'connected'],
    ['DEGRADED aberto → connected', { sessionState: 'DEGRADED' }, 'connected'],
    ['STABLE com queda transitória → connecting', { connectionState: 'close', lastDisconnectReason: 'transient' }, 'connecting'],
    ['PAUSED → paused', { sessionState: 'PAUSED', connectionState: 'open' }, 'paused'],
    ['loggedOut → disconnected', { sessionState: 'DISCONNECTED', connectionState: 'close', lastDisconnectReason: 'loggedOut' }, 'disconnected'],
    ['forbidden → banned (sessão pausada)', { sessionState: 'PAUSED', connectionState: 'close', lastDisconnectReason: 'forbidden' }, 'banned'],
    ['forbidden → banned (desconectada)', { sessionState: 'DISCONNECTED', connectionState: 'close', lastDisconnectReason: 'forbidden' }, 'banned'],
    ['reaberta depois do 403 volta a connected', { sessionState: 'STABLE', connectionState: 'open', lastDisconnectReason: 'forbidden' }, 'connected'],
    ['NEW sem QR → pending', { sessionState: 'NEW', connectionState: null }, 'pending'],
    ['NEW com QR pedido → connecting', { sessionState: 'NEW', connectionState: null, qrRequested: true }, 'connecting'],
    ['sessão sumiu do gateway → disconnected', { sessionState: null }, 'disconnected'],
  ])('%s', (_name, over, status) => {
    expect(deriveConnectionStatus({ ...base, ...over }).status).toBe(status)
  })

  it('badges de aquecimento, saúde, reinício e exclusão', () => {
    expect(deriveConnectionStatus({ ...base, sessionState: 'WARMING' }).badges).toEqual(['warming'])
    expect(deriveConnectionStatus({ ...base, sessionState: 'DEGRADED', requiresRestart: true, scheduledForDeletion: true }).badges).toEqual([
      'degraded',
      'requires_restart',
      'scheduled_deletion',
    ])
    expect(deriveConnectionStatus(base).badges).toEqual([])
  })
})
