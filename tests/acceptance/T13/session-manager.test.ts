import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { lit, sqlOk } from '../helpers/pg'
import { credCount, engine, fakeManager, flush, healthTypes, migratedWaDb, mockSocket, status, transport, type WaDb } from './support'

let wa: WaDb
const managers: any[] = []

beforeAll(async () => {
  wa = await migratedWaDb()
})

afterAll(async () => {
  for (const m of managers) await m.stop?.().catch(() => {})
  await wa?.close()
})

async function make(extra: Record<string, unknown> = {}) {
  // O banco é compartilhado pelo arquivo: um só manager vivo por vez (o start() retoma as sessões anteriores).
  for (const m of managers.splice(0)) await m.stop?.().catch(() => {})
  const fm = await fakeManager(wa.db, extra)
  managers.push(fm.manager)
  await fm.manager.start()
  return fm
}

const uniq = (p: string) => `${p}-${Math.random().toString(36).slice(2, 8)}`

/** Cria a sessão, abre o QR e conecta no fake. */
async function connected(fm: Awaited<ReturnType<typeof make>>, name = uniq('s')) {
  const s = await fm.manager.create({ name })
  await fm.manager.startQr(s.id)
  await fm.idle()
  fm.fake(s.id).open()
  await fm.idle()
  return s.id as string
}

describe('T13 — conexão', () => {
  it('AC-T13-01 abrir conexão no FakeTransport leva a sessão a WARMING, grava health_event connected e persiste credenciais cifradas', async () => {
    const fm = await make()
    const s = await fm.manager.create({ name: uniq('ac01') })
    expect(status(wa.url, s.id)).toBe('NEW')
    await fm.manager.startQr(s.id)
    await fm.idle()
    expect(fm.fake(s.id).connectCalls.length).toBe(1)

    fm.fake(s.id).open()
    await fm.idle()

    expect(status(wa.url, s.id)).toBe('WARMING')
    expect(healthTypes(wa.url, s.id)).toContain('connected')
    expect(credCount(wa.url, s.id)).toBeGreaterThan(0)
    // só material cifrado: nenhuma linha sem ciphertext/iv/auth_tag
    const bad = sqlOk(
      wa.url,
      `SELECT count(*) FROM public.session_credentials WHERE session_id = ${lit(s.id)}
         AND (ciphertext IS NULL OR iv IS NULL OR auth_tag IS NULL OR length(ciphertext) = 0);`,
    )[0]![0]
    expect(bad).toBe('0')
    expect(fm.of('connected', s.id)).toHaveLength(1)
    expect(fm.of('state', s.id).map((e) => e.to)).toContain('WARMING')
  })
})

describe('T13 — quedas', () => {
  it('AC-T13-02 close(loggedOut) → DISCONNECTED, sem reconexão e credenciais apagadas', async () => {
    const fm = await make()
    const id = await connected(fm, uniq('ac02-logout'))
    expect(credCount(wa.url, id)).toBeGreaterThan(0)
    const f = fm.fake(id)
    const calls = f.connectCalls.length

    await f.close('loggedOut')
    await fm.idle()

    expect(status(wa.url, id)).toBe('DISCONNECTED')
    expect(credCount(wa.url, id)).toBe(0)
    expect(f.connectCalls.length).toBe(calls)
    expect(fm.fakes.get(id)).toHaveLength(1)
    expect(fm.of('reconnect', id)).toEqual([])
  })

  it('AC-T13-02 close(forbidden) → PAUSED', async () => {
    const fm = await make()
    const id = await connected(fm, uniq('ac02-403'))
    const f = fm.fake(id)
    const calls = f.connectCalls.length
    await f.close('forbidden')
    await fm.idle()
    expect(status(wa.url, id)).toBe('PAUSED')
    expect(f.connectCalls.length).toBe(calls)
    expect(fm.of('reconnect', id)).toEqual([])
  })

  it('AC-T13-02 close(transient) → reconexões com backoff 1s·2ⁿ (sleep injetado) e DISCONNECTED após 5 falhas', async () => {
    const fm = await make()
    const id = await connected(fm, uniq('ac02-transient'))
    const f = fm.fake(id)
    expect(f.connectCalls.length).toBe(1)

    // queda inicial + uma queda depois de cada uma das 5 reconexões
    for (let i = 1; i <= 6; i++) {
      await f.close('transient')
      await fm.idle()
      if (i <= 5) expect(f.connectCalls.length, `reconexão ${i}`).toBe(1 + i)
    }

    const rec = fm.of('reconnect', id)
    expect(rec.map((r) => r.attempt)).toEqual([1, 2, 3, 4, 5])
    expect(rec.map((r) => r.delayMs)).toEqual([1000, 2000, 4000, 8000, 16000])
    expect(fm.sleeps).toEqual(expect.arrayContaining([1000, 2000, 4000, 8000, 16000]))
    expect(f.connectCalls.length).toBe(6) // nenhuma 6ª reconexão
    expect(status(wa.url, id)).toBe('DISCONNECTED')
  })

  it('AC-T13-02 queda transitória seguida de conexão bem-sucedida volta a conectar (sem DISCONNECTED)', async () => {
    const fm = await make()
    const id = await connected(fm, uniq('ac02-recover'))
    const f = fm.fake(id)
    await f.close('transient')
    await fm.idle()
    expect(f.connectCalls.length).toBe(2)
    f.open()
    await fm.idle()
    expect(status(wa.url, id)).not.toBe('DISCONNECTED')
    expect(fm.of('connected', id).length).toBe(2)
  })
})

describe('T13 — reinício do manager', () => {
  it('AC-T13-03 reiniciar o manager com o mesmo banco reconecta as sessões com credenciais e estado ≠ DISCONNECTED; PAUSED continua PAUSED', async () => {
    const fm1 = await make()
    const active = await connected(fm1, uniq('ac03-active'))
    const paused = await connected(fm1, uniq('ac03-paused'))
    await fm1.manager.pause(paused)
    await fm1.idle()
    expect(status(wa.url, paused)).toBe('PAUSED')
    const gone = await connected(fm1, uniq('ac03-gone'))
    await fm1.fake(gone).close('loggedOut')
    await fm1.idle()
    expect(status(wa.url, gone)).toBe('DISCONNECTED')
    const fresh = (await fm1.manager.create({ name: uniq('ac03-new') })).id // NEW, sem credenciais
    await fm1.manager.stop()

    const statusBefore = { active: status(wa.url, active), paused: status(wa.url, paused) }
    expect(statusBefore.active).not.toBe('DISCONNECTED')
    expect(statusBefore.paused).toBe('PAUSED')

    const fm2 = await make()
    await fm2.idle()

    expect(fm2.fakes.get(active)?.at(-1)?.connectCalls.length, 'sessão ativa não reconectou').toBe(1)
    expect(fm2.fakes.get(paused)?.at(-1)?.connectCalls.length, 'sessão PAUSED não reconectou').toBe(1)
    expect(fm2.fakes.get(gone)?.at(-1)?.connectCalls.length ?? 0, 'sessão DISCONNECTED reconectou').toBe(0)
    expect(fm2.fakes.get(fresh)?.at(-1)?.connectCalls.length ?? 0, 'sessão sem credenciais reconectou').toBe(0)

    fm2.fake(active).open()
    fm2.fake(paused).open()
    await fm2.idle()
    expect(status(wa.url, active)).not.toBe('DISCONNECTED')
    expect(status(wa.url, paused)).toBe('PAUSED')
  })
})

describe('T13 — pareamento e QR', () => {
  it('AC-T13-04 requestPairingCode só pede o código após o primeiro qr e uma vez por socket', async () => {
    const { BaileysTransport } = await transport()
    // Só os sockets da sessão deste teste: o start() também retoma sessões de testes anteriores.
    const bySession = new Map<string, ReturnType<typeof mockSocket>[]>()
    const fm = await make({
      transportFactory: (sid: string) =>
        new BaileysTransport({
          makeSocket: () => {
            const s = mockSocket()
            bySession.set(sid, [...(bySession.get(sid) ?? []), s])
            return s
          },
        }),
    })
    const s = await fm.manager.create({ name: uniq('ac04-pair') })
    const sockets = () => bySession.get(s.id) ?? []
    const pending = fm.manager.requestPairingCode(s.id, '+5511999998888')
    pending.catch(() => {})
    await flush(10)

    expect(sockets()).toHaveLength(1)
    expect(sockets()[0]!.pairingCalls, 'pediu o código antes do primeiro qr').toEqual([])

    sockets()[0]!.ev.emit('connection.update', { qr: 'QR-1' })
    await flush(10)
    expect(sockets()[0]!.pairingCalls).toHaveLength(1)
    expect(sockets()[0]!.pairingCalls[0]).toMatch(/5511999998888/)

    sockets()[0]!.ev.emit('connection.update', { qr: 'QR-2' })
    sockets()[0]!.ev.emit('connection.update', { qr: 'QR-3' })
    await flush(10)
    expect(sockets()[0]!.pairingCalls, 'pediu o código mais de uma vez no mesmo socket').toHaveLength(1)

    await expect(pending).resolves.toMatchObject({ code: 'PAIR1234' })
  })

  it('AC-T13-04 requestPairingCode repassa o telefone ao transporte e resolve com o código emitido', async () => {
    const fm = await make()
    const s = await fm.manager.create({ name: uniq('ac04-fake') })
    const pending = fm.manager.requestPairingCode(s.id, '+5511999998888')
    pending.catch(() => {})
    await fm.idle().catch(() => {})
    await flush(10)
    const f = fm.fake(s.id)
    expect(String(f.lastConnect?.pairingPhone ?? '')).toMatch(/5511999998888/)
    f.emitQr('QR-PAIR')
    f.emitPairingCode('ABCD1234')
    await expect(pending).resolves.toMatchObject({ code: 'ABCD1234' })
  })

  it('AC-T13-04 QR exposto como data URL PNG', async () => {
    const fm = await make()
    const s = await fm.manager.create({ name: uniq('ac04-qr') })
    await fm.manager.startQr(s.id)
    await fm.idle()
    fm.fake(s.id).emitQr('2@abcdefghijklmnopqrstuvwxyz0123456789,ABCDEF==,GHIJ==')
    await fm.idle()

    let info: any
    for (let i = 0; i < 50 && !info?.qr; i++) {
      info = await fm.manager.getQr(s.id)
      if (!info?.qr) await new Promise((r) => setTimeout(r, 20))
    }
    expect(info?.qr).toMatch(/^data:image\/png;base64,/)
    const png = Buffer.from(String(info.qr).split(',')[1]!, 'base64')
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(fm.of('qr', s.id).length).toBeGreaterThan(0)
  })
})

describe('T13 — serialização e transições', () => {
  it('AC-T13-05 restart e logout concorrentes na mesma sessão executam em série', async () => {
    const fm = await make()
    const id = await connected(fm, uniq('ac05-serial'))
    const order: string[] = []
    const first = fm.fake(id)

    const restart = fm.manager.restart(id).then(() => {
      order.push('restart:done')
      order.push(`restart:fakes=${fm.fakes.get(id)!.length}`)
    })
    const logout = fm.manager.logout(id).then(() => order.push('logout:done'))
    await Promise.all([restart, logout])
    await fm.idle()

    expect(order).toEqual(['restart:done', 'restart:fakes=2', 'logout:done'])
    const list = fm.fakes.get(id)!
    expect(list).toHaveLength(2)
    expect(first.closed || first.loggedOut, 'o 1º transporte não foi encerrado pelo restart').toBe(true)
    expect(list[1].connectCalls.length, 'o restart não conectou o 2º transporte antes do logout').toBe(1)
    expect(list[1].loggedOut || list[1].closed, 'o logout não encerrou o 2º transporte').toBe(true)
    expect(status(wa.url, id)).toBe('DISCONNECTED')
    expect(credCount(wa.url, id)).toBe(0)
  })

  it('AC-T13-05 transição inválida → INVALID_TRANSITION', async () => {
    const { canTransition } = await engine()
    expect(canTransition('NEW', 'STABLE')).toBe(false)
    expect(canTransition('NEW', 'WARMING')).toBe(true)
    expect(canTransition('WARMING', 'STABLE')).toBe(true)
    expect(canTransition('STABLE', 'DEGRADED')).toBe(true)
    expect(canTransition('DEGRADED', 'STABLE')).toBe(true)

    const fm = await make()
    const s = await fm.manager.create({ name: uniq('ac05-invalid') })
    const err = await fm.manager.resume(s.id).then(
      () => null,
      (e: any) => e,
    )
    expect(err, 'resume em NEW deveria rejeitar').not.toBeNull()
    expect(err.code).toBe('INVALID_TRANSITION')
    expect(status(wa.url, s.id)).toBe('NEW')
  })
})

describe('T13 — proxy', () => {
  async function withProxy(available: boolean) {
    const { ProxyService } = await engine()
    const fm = await make()
    const port = 20000 + Math.floor(Math.random() * 20000)
    const url = `http://user:senha@proxy.test.invalid:${port}`
    const p = await new ProxyService(wa.db).create({ url })
    if (!available) sqlOk(wa.url, `UPDATE public.proxies SET available = false WHERE id = ${lit(p.id)};`)
    const s = await fm.manager.create({ name: uniq(`ac06-${available ? 'ok' : 'down'}`), proxyId: p.id })
    return { fm, id: s.id as string, url, proxyId: p.id as string }
  }

  it('AC-T13-06 sessão com proxy indisponível falha a conexão e fica DISCONNECTED, sem tentativa direta', async () => {
    const { fm, id } = await withProxy(false)
    const result = await fm.manager.startQr(id).then(
      () => 'ok',
      (e: any) => e,
    )
    await fm.idle()
    expect(result, 'startQr com proxy indisponível deveria falhar').not.toBe('ok')
    const calls = (fm.fakes.get(id) ?? []).flatMap((f) => f.connectCalls)
    expect(calls, 'houve tentativa de conexão (direta) com proxy indisponível').toEqual([])
    expect(status(wa.url, id)).toBe('DISCONNECTED')
  })

  it('AC-T13-06 sessão com proxy disponível conecta pelo proxy (proxyUrl no transporte)', async () => {
    const { fm, id, url } = await withProxy(true)
    await fm.manager.startQr(id)
    await fm.idle()
    expect(fm.fake(id).connectCalls).toHaveLength(1)
    expect(fm.fake(id).connectCalls[0].proxyUrl).toBe(url)
  })

  it('AC-T13-06 senha do proxy fica só cifrada no banco', async () => {
    const { proxyId } = await withProxy(true)
    const row = sqlOk(wa.url, `SELECT p::text FROM public.proxies p WHERE id = ${lit(proxyId)};`)[0]![0]!
    expect(row).not.toContain('senha')
  })

  it('AC-T13-06 sessão sem proxy conecta direto', async () => {
    const fm = await make()
    const s = await fm.manager.create({ name: uniq('ac06-direct') })
    await fm.manager.startQr(s.id)
    await fm.idle()
    expect(fm.fake(s.id).connectCalls).toHaveLength(1)
    expect(fm.fake(s.id).connectCalls[0].proxyUrl).toBeUndefined()
  })
})
