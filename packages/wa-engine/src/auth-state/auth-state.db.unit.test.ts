// Postgres real (SPEC 3.10): banco descartável migrado.
import { randomBytes } from 'node:crypto'
import { createDb, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createCipher, DecryptionError, generateCredentialsKey } from '@crm/node-kit'
import { BufferJSON } from '@whiskeysockets/baileys'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { sessionCredentials, sessions } from '../db'
import { credentialAad, usePostgresAuthState } from './index'

const cipher = createCipher({ key: generateCredentialsKey() })
let temp: TempDatabase
let db: Database

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true, set: 'wa' })
  db = createDb(temp.url, { max: 4 })
}, 120_000)

afterAll(async () => {
  await db?.$client.end()
  await temp?.drop()
})

async function newSession(): Promise<string> {
  const [row] = await db
    .insert(sessions)
    .values({ name: `s-${randomBytes(4).toString('hex')}` })
    .returning({ id: sessions.id })
  return row!.id
}

describe('usePostgresAuthState', () => {
  it('gera creds iniciais e as recarrega idênticas após restart', async () => {
    const id = await newSession()
    const a = await usePostgresAuthState(db, id, { cipher })
    expect(Buffer.isBuffer(a.state.creds.noiseKey.private)).toBe(true)
    a.state.creds.me = { id: '5511999999999@s.whatsapp.net', name: 'Teste' }
    await a.saveCreds()

    const b = await usePostgresAuthState(db, id, { cipher })
    expect(b.state.creds).toEqual(a.state.creds)
    expect(Buffer.from(b.state.creds.noiseKey.private).equals(Buffer.from(a.state.creds.noiseKey.private))).toBe(true)
    expect(b.state.creds.registrationId).toBe(a.state.creds.registrationId)
  })

  it('keys.set/get faz round-trip de tipos arbitrários e null remove', async () => {
    const id = await newSession()
    const { state } = await usePostgresAuthState(db, id, { cipher })
    const pre = { private: randomBytes(32), public: randomBytes(32) }
    await state.keys.set({
      'pre-key': { '1': pre, '2': pre },
      'app-state-sync-key': { K1: { keyData: randomBytes(32), timestamp: 123 } as never },
      'lid-mapping': { '5511999999999': '123456789@lid', '123456789_reverse': '5511999999999' },
      'device-list': { '5511999999999': ['0', '12'] },
      'sender-key-memory': { 'g@g.us': { 'a@s.whatsapp.net': true } },
      tctoken: { 'a@s.whatsapp.net': { token: Buffer.from('tok'), timestamp: '1' } },
    })

    const reloaded = (await usePostgresAuthState(db, id, { cipher })).state
    const got = await reloaded.keys.get('pre-key', ['1', '2', '3'])
    expect(Buffer.from(got['1']!.private).equals(pre.private)).toBe(true)
    expect(got['3']).toBeUndefined()
    const sync = await reloaded.keys.get('app-state-sync-key', ['K1'])
    expect(sync.K1?.constructor.name).toBe('AppStateSyncKeyData')
    expect(await reloaded.keys.get('lid-mapping', ['5511999999999', '123456789_reverse'])).toEqual({
      '5511999999999': '123456789@lid',
      '123456789_reverse': '5511999999999',
    })
    expect(await reloaded.keys.get('device-list', ['5511999999999'])).toEqual({ '5511999999999': ['0', '12'] })
    expect(await reloaded.keys.get('sender-key-memory', ['g@g.us'])).toEqual({ 'g@g.us': { 'a@s.whatsapp.net': true } })
    const tc = await reloaded.keys.get('tctoken', ['a@s.whatsapp.net'])
    expect(Buffer.from(tc['a@s.whatsapp.net']!.token).toString()).toBe('tok')

    await reloaded.keys.set({ 'pre-key': { '1': null } })
    expect(Object.keys(await reloaded.keys.get('pre-key', ['1', '2']))).toEqual(['2'])
    const fresh = (await usePostgresAuthState(db, id, { cipher })).state
    expect(Object.keys(await fresh.keys.get('pre-key', ['1', '2']))).toEqual(['2'])
    expect(await fresh.keys.get('pre-key', [])).toEqual({})
  })

  it('nada em texto puro nas colunas de session_credentials', async () => {
    const id = await newSession()
    const marker = `MARCADOR-${randomBytes(8).toString('hex')}`
    const { state, saveCreds } = await usePostgresAuthState(db, id, { cipher })
    state.creds.me = { id: marker }
    await saveCreds()
    await state.keys.set({ session: { peer: Buffer.from(marker) }, 'lid-mapping': { k: marker } })

    const { rows } = await db.$client.query('select * from session_credentials where session_id = $1', [id])
    expect(rows.length).toBe(3)
    for (const row of rows) {
      for (const v of Object.values(row)) {
        const text = Buffer.isBuffer(v) ? v.toString('latin1') : String(v)
        expect(text).not.toContain(marker)
        if (Buffer.isBuffer(v)) {
          expect(v.toString('utf8')).not.toContain(marker)
          expect(v.toString('base64')).not.toContain(Buffer.from(marker).toString('base64'))
        }
      }
    }
  })

  it('credencial gravada com um sessionId e lida com outro falha na decifragem (AAD)', async () => {
    const a = await newSession()
    const b = await newSession()
    const authA = await usePostgresAuthState(db, a, { cipher })
    authA.state.creds.me = { id: 'a@s.whatsapp.net' }
    await authA.saveCreds()
    await authA.state.keys.set({ session: { peer: Buffer.from('segredo') } })

    // Move as linhas de A para B: mesmo ciphertext, AAD esperado diferente.
    await db.$client.query('update session_credentials set session_id = $1 where session_id = $2', [b, a])
    await expect(usePostgresAuthState(db, b, { cipher })).rejects.toBeInstanceOf(DecryptionError)
    await db.$client.query(`delete from session_credentials where session_id = $1 and key_type = 'creds'`, [b])
    const authB = await usePostgresAuthState(db, b, { cipher })
    await expect(authB.state.keys.get('session', ['peer'])).rejects.toBeInstanceOf(DecryptionError)

    // O mesmo payload continua decifrável com o AAD da sessão de origem: a falha é só do AAD.
    const [row] = await db.select().from(sessionCredentials).where(eq(sessionCredentials.sessionId, b))
    const json = cipher.decrypt<string>(row!, credentialAad(a, 'session', 'peer'))
    expect(Buffer.from(JSON.parse(json, BufferJSON.reviver) as Uint8Array).toString()).toBe('segredo')
  })

  it('leituras repetidas da mesma chave dentro do cache não geram nova query', async () => {
    const id = await newSession()
    const { state } = await usePostgresAuthState(db, id, { cipher })
    await state.keys.set({ session: { peer: Buffer.from('x') } })
    const spy = vi.spyOn(db.$client, 'query')
    try {
      const first = await state.keys.get('session', ['peer'])
      const callsAfterFirst = spy.mock.calls.length
      const second = await state.keys.get('session', ['peer'])
      const third = await state.keys.get('session', ['peer'])
      expect(spy.mock.calls.length).toBe(callsAfterFirst)
      expect(Buffer.from(second.peer!).equals(Buffer.from(first.peer!))).toBe(true)
      expect(Buffer.from(third.peer!).toString()).toBe('x')
    } finally {
      spy.mockRestore()
    }

    // Sem cache, toda leitura vai ao banco.
    const raw = (await usePostgresAuthState(db, id, { cipher, cache: false })).state
    const spy2 = vi.spyOn(db.$client, 'query')
    try {
      await raw.keys.get('session', ['peer'])
      await raw.keys.get('session', ['peer'])
      expect(spy2.mock.calls.length).toBe(2)
    } finally {
      spy2.mockRestore()
    }
  })

  it('clear remove todas as credenciais da sessão', async () => {
    const id = await newSession()
    const auth = await usePostgresAuthState(db, id, { cipher })
    await auth.saveCreds()
    await auth.state.keys.set({ 'pre-key': { '1': { private: randomBytes(32), public: randomBytes(32) } } })
    await auth.clear()
    const { rows } = await db.$client.query('select 1 from session_credentials where session_id = $1', [id])
    expect(rows).toEqual([])
  })

  // T117: o BaileysTransport reconhece o store já cacheado e não o envolve de novo.
  it('com cache, o key store vem marcado como cacheável; com cache:false, não', async () => {
    const marker = Symbol.for('crm.wa-engine.cacheable-key-store')
    const cached = await usePostgresAuthState(db, await newSession(), { cipher })
    expect((cached.state.keys as unknown as Record<symbol, unknown>)[marker]).toBe(true)
    const raw = await usePostgresAuthState(db, await newSession(), { cipher, cache: false })
    expect((raw.state.keys as unknown as Record<symbol, unknown>)[marker]).toBeUndefined()
  })
})
