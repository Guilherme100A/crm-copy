// AC-T06-02..05: auth state Baileys cifrado no Postgres via usePostgresAuthState(db, sessionId).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { lit, sql, sqlOk } from '../helpers/pg'
import { bytes, credRowCount, loadAuthState, migratedWaDb, newSession, norm, poolOf, type WaDb } from './support'

let wa: WaDb
let usePostgresAuthState: (db: any, sessionId: string, opts?: any) => Promise<any>

beforeAll(async () => {
  usePostgresAuthState = await loadAuthState()
  wa = await migratedWaDb()
})

afterAll(async () => {
  await wa?.close()
})

const open = (sessionId: string) => usePostgresAuthState(wa.db, sessionId)

describe('T06 — session_credentials cifrado', () => {
  it('AC-T06-02 session_credentials só tem colunas de identificação e de cifra (nenhum valor em texto)', () => {
    const cols = sqlOk(
      wa.tmp.url,
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'session_credentials' ORDER BY 1;`,
    ).map(([n, t]) => `${n}:${t}`)
    expect(cols.sort()).toEqual(
      [
        'auth_tag:bytea',
        'ciphertext:bytea',
        'iv:bytea',
        'key_id:text',
        'key_type:text',
        'key_version:integer',
        'session_id:uuid',
        'updated_at:timestamp with time zone',
      ].sort(),
    )
  })

  it('AC-T06-02 um marcador salvo como credencial (creds e chaves) não aparece em nenhuma coluna lida em texto', async () => {
    const sid = newSession(wa.tmp.url)
    const MARKER = `MARCADOR_T06_${bytes(6).toString('hex')}`
    const auth = await open(sid)
    auth.state.creds.me = { id: '5511999990000:1@s.whatsapp.net', name: MARKER }
    await auth.saveCreds()
    await auth.state.keys.set({
      session: { '5511999990000.0': Buffer.from(MARKER) },
      'lid-mapping': { '5511999990000': MARKER },
      'sender-key': { '120363000000000000@g.us::5511999990000::0': Buffer.from(`${MARKER}-sender`) },
    })
    expect(credRowCount(wa.tmp.url, sid)).toBeGreaterThanOrEqual(4)

    const needles = [
      MARKER,
      Buffer.from(MARKER).toString('hex'),
      Buffer.from(MARKER).toString('base64').replace(/=+$/, ''),
    ]
    // todas as colunas de todas as linhas da sessão, em várias leituras de texto (row::text, escape, hex, base64)
    const dump = sqlOk(
      wa.tmp.url,
      `SELECT t::text, encode(ciphertext, 'escape'), encode(ciphertext, 'hex'), encode(iv, 'escape'), encode(auth_tag, 'escape')
         FROM public.session_credentials t WHERE session_id = ${lit(sid)};`,
    )
      .flat()
      .join('\n')
    for (const n of needles) expect(dump.includes(n), `marcador (${n}) visível em session_credentials`).toBe(false)
    // nenhuma outra tabela de public recebeu o marcador
    const tables = sqlOk(wa.tmp.url, `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';`).map(
      (r) => r[0]!,
    )
    for (const t of tables.filter((x) => x !== 'session_credentials')) {
      const hit = sqlOk(wa.tmp.url, `SELECT count(*) FROM public."${t}" x WHERE x::text LIKE ${lit(`%${MARKER}%`)};`)[0]![0]
      expect(hit, `marcador em public.${t}`).toBe('0')
    }
    // e o valor continua legível pela API (cifrado ≠ perdido)
    const again = await open(sid)
    expect(again.state.creds.me?.name).toBe(MARKER)
  })
})

describe('T06 — keys.get/set e restart', () => {
  it("AC-T06-03 keys.set({ 'pre-key': { '1': null } }) remove a chave", async () => {
    const sid = newSession(wa.tmp.url)
    const auth = await open(sid)
    const kp = { public: bytes(), private: bytes() }
    await auth.state.keys.set({ 'pre-key': { '1': kp, '2': { public: bytes(), private: bytes() } } })
    expect(norm((await auth.state.keys.get('pre-key', ['1']))['1'])).toEqual(norm(kp))
    expect(credRowCount(wa.tmp.url, sid, 'pre-key', '1')).toBe(1)

    await auth.state.keys.set({ 'pre-key': { '1': null } })
    expect((await auth.state.keys.get('pre-key', ['1']))['1'] ?? undefined).toBeUndefined()
    expect(credRowCount(wa.tmp.url, sid, 'pre-key', '1'), 'linha não removida do banco').toBe(0)
    // só a chave pedida sai; a outra fica
    expect(credRowCount(wa.tmp.url, sid, 'pre-key', '2')).toBe(1)
    // e continua removida após restart
    const fresh = await open(sid)
    expect((await fresh.state.keys.get('pre-key', ['1']))['1'] ?? undefined).toBeUndefined()
    expect((await fresh.state.keys.get('pre-key', ['2']))['2']).toBeDefined()
  })

  const SAMPLES: Record<string, Record<string, any>> = {
    'pre-key': { '7': { public: bytes(), private: bytes() } },
    session: { '5511988887777.0': bytes(64) },
    'sender-key': { '120363000000000000@g.us::5511988887777::0': bytes(48) },
    'sender-key-memory': { '120363000000000000@g.us': { '5511988887777:0@s.whatsapp.net': true } },
    'app-state-sync-key': {
      AAAAAGu1: { keyData: bytes(32), fingerprint: { rawId: 7, currentIndex: 2, deviceIndexes: [0, 1] }, timestamp: 1_760_000_000_000 },
    },
    'app-state-sync-version': { regular_high: { version: 12, hash: bytes(128), indexValueMap: { abc: { valueMac: bytes(32) } } } },
    'lid-mapping': { '5511988887777': '112233445566', '112233445566_reverse': '5511988887777' },
    'device-list': { '5511988887777': ['0', '12', '34'] },
    tctoken: { '5511988887777@s.whatsapp.net': { token: bytes(24), timestamp: '1760000000' } },
    'tipo-arbitrario': { x: { qualquer: 'coisa', n: 1, b: bytes(8), lista: [1, 'dois'] } },
  }

  for (const [type, entries] of Object.entries(SAMPLES)) {
    it(`AC-T06-03 keys.get de '${type}' faz round-trip (mesma instância e após restart)`, async () => {
      const sid = newSession(wa.tmp.url)
      const auth = await open(sid)
      await auth.state.keys.set({ [type]: entries })
      const ids = Object.keys(entries)
      const got = await auth.state.keys.get(type, ids)
      for (const id of ids) expect(norm(got[id]), `${type}/${id}`).toEqual(norm(entries[id]))
      // id inexistente não aparece
      const miss = await auth.state.keys.get(type, ['nao-existe'])
      expect(miss['nao-existe'] ?? undefined).toBeUndefined()
      // restart: novo state lê do Postgres
      const fresh = await open(sid)
      const got2 = await fresh.state.keys.get(type, ids)
      for (const id of ids) expect(norm(got2[id]), `${type}/${id} após restart`).toEqual(norm(entries[id]))
    })
  }

  it('AC-T06-03 recriar o state (restart) recarrega creds idênticas', async () => {
    const sid = newSession(wa.tmp.url)
    const first = await open(sid)
    expect(first.state.creds).toBeTruthy()
    first.state.creds.me = { id: '5511977776666:3@s.whatsapp.net', lid: '998877665544:3@lid', name: 'Conta T06' }
    first.state.creds.registered = true
    first.state.creds.platform = 'smba'
    await first.saveCreds()
    const before = norm(first.state.creds)

    const second = await open(sid)
    expect(norm(second.state.creds)).toEqual(before)
    // creds com Buffers preservam os bytes (chaves de identidade)
    expect(norm(second.state.creds.noiseKey)).toEqual(norm(first.state.creds.noiseKey))
    expect(norm(second.state.creds.signedIdentityKey)).toEqual(norm(first.state.creds.signedIdentityKey))
  })

  it('AC-T06-03 sessão nova sem creds salvas gera creds iniciais diferentes por sessão', async () => {
    const a = await open(newSession(wa.tmp.url))
    const b = await open(newSession(wa.tmp.url))
    expect(a.state.creds.noiseKey).toBeTruthy()
    expect(norm(a.state.creds.noiseKey)).not.toEqual(norm(b.state.creds.noiseKey))
  })
})

describe('T06 — AAD amarra a credencial à sessão', () => {
  it('AC-T06-04 creds gravadas numa sessão e lidas com outro sessionId falham na decifragem', async () => {
    const a = newSession(wa.tmp.url)
    const b = newSession(wa.tmp.url)
    const auth = await open(a)
    auth.state.creds.me = { id: '5511966665555:1@s.whatsapp.net', name: 'A' }
    await auth.saveCreds()
    // controle: a própria sessão lê
    expect((await open(a)).state.creds.me?.name).toBe('A')
    // copia a linha cifrada de A para B (mesmo key_type/key_id)
    sqlOk(
      wa.tmp.url,
      `INSERT INTO public.session_credentials (session_id, key_type, key_id, ciphertext, iv, auth_tag, key_version)
         SELECT ${lit(b)}, key_type, key_id, ciphertext, iv, auth_tag, key_version FROM public.session_credentials
          WHERE session_id = ${lit(a)};`,
    )
    expect(credRowCount(wa.tmp.url, b)).toBeGreaterThan(0)
    await expect(open(b)).rejects.toThrow()
  })

  it('AC-T06-04 chave gravada numa sessão e lida com outro sessionId falha na decifragem', async () => {
    const a = newSession(wa.tmp.url)
    const b = newSession(wa.tmp.url)
    const authA = await open(a)
    await authA.state.keys.set({ 'pre-key': { '9': { public: bytes(), private: bytes() } } })
    const authB = await open(b) // B tem creds próprias (nenhuma linha copiada ainda)
    sqlOk(
      wa.tmp.url,
      `INSERT INTO public.session_credentials (session_id, key_type, key_id, ciphertext, iv, auth_tag, key_version)
         SELECT ${lit(b)}, key_type, key_id, ciphertext, iv, auth_tag, key_version FROM public.session_credentials
          WHERE session_id = ${lit(a)} AND key_type = 'pre-key' AND key_id = '9';`,
    )
    await expect(authB.state.keys.get('pre-key', ['9'])).rejects.toThrow()
    // controle: em A a mesma linha decifra
    const fresh = await open(a)
    expect((await fresh.state.keys.get('pre-key', ['9']))['9']).toBeDefined()
  })

  it('AC-T06-04 trocar key_id da linha (mesma sessão) também falha (AAD inclui keyType/keyId)', async () => {
    const a = newSession(wa.tmp.url)
    const authA = await open(a)
    await authA.state.keys.set({ 'pre-key': { '10': { public: bytes(), private: bytes() } } })
    const r = sql(wa.tmp.url, `UPDATE public.session_credentials SET key_id = '11' WHERE session_id = ${lit(a)} AND key_type = 'pre-key' AND key_id = '10';`)
    expect(r.code, r.stderr).toBe(0)
    const fresh = await open(a)
    await expect(fresh.state.keys.get('pre-key', ['11'])).rejects.toThrow()
  })
})

describe('T06 — cache de chaves (makeCacheableSignalKeyStore)', () => {
  it('AC-T06-05 leituras repetidas da mesma chave dentro do cache não geram nova query', async () => {
    const sid = newSession(wa.tmp.url)
    const writer = await open(sid)
    const kp = { public: bytes(), private: bytes() }
    await writer.state.keys.set({ 'pre-key': { '42': kp }, session: { '5511955554444.0': bytes(40) } })

    const pool = poolOf(wa.db)
    expect(pool, 'Database sem $client (pg.Pool)').toBeTruthy()
    const reader = await open(sid)
    const qSpy = vi.spyOn(pool, 'query')
    const cSpy = vi.spyOn(pool, 'connect')
    const calls = () => qSpy.mock.calls.length + cSpy.mock.calls.length
    try {
      // prova de que o spy enxerga o client usado pelo auth state: chave inexistente não fica em cache e vai ao banco
      const c0 = calls()
      await reader.state.keys.get('pre-key', ['nao-existe-t06'])
      expect(calls(), 'leitura de chave ausente não passou pelo client (spy)').toBeGreaterThan(c0)

      const first = await reader.state.keys.get('pre-key', ['42'])
      expect(norm(first['42'])).toEqual(norm(kp))
      const afterFirst = calls()

      for (let i = 0; i < 5; i++) {
        const again = await reader.state.keys.get('pre-key', ['42'])
        expect(norm(again['42'])).toEqual(norm(kp))
      }
      expect(calls() - afterFirst, 'leituras repetidas geraram novas queries').toBe(0)

      // outra chave ainda não lida → vai ao banco; depois fica em cache
      await reader.state.keys.get('session', ['5511955554444.0'])
      const afterSession = calls()
      await reader.state.keys.get('session', ['5511955554444.0'])
      await reader.state.keys.get('pre-key', ['42'])
      expect(calls()).toBe(afterSession)
    } finally {
      qSpy.mockRestore()
      cSpy.mockRestore()
    }
  })
})
