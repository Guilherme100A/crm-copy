import { describe, expect, it } from 'vitest'
import * as port from '@crm/wa-port'
import { ensureSession, exportTarget, firstAccepted, newFakeGateway, sendReq, subscribeEvents } from './support'

const parse = (x: unknown) => (port as any).parseWaEvent(x)

describe('T03 — FakeWaGateway', () => {
  it('AC-T03-03 FakeWaGateway é exposto no subpath público @crm/wa-port/testing', async () => {
    expect(exportTarget('testing'), 'package.json sem exports["./testing"]').toBeTruthy()
    const gw = await newFakeGateway()
    expect(Array.isArray(gw.sent)).toBe(true)
    expect(typeof gw.send).toBe('function')
    expect(typeof gw.emit).toBe('function')
    expect(typeof gw.failNext).toBe('function')
  })

  it('AC-T03-03 send registra em sent[] e devolve MessageView queued', async () => {
    const gw = await newFakeGateway()
    const sid = await ensureSession(gw)
    const req = sendReq(sid, 'primeira')
    const view = await gw.send(req)
    expect(view.status).toBe('queued')
    expect(typeof view.id).toBe('string')
    expect(view.id.length).toBeGreaterThan(0)
    expect(view.phone).toBe(req.phone)
    expect(gw.sent).toHaveLength(1)
    const rec = JSON.stringify(gw.sent[0])
    expect(rec).toContain(req.phone)
    expect(rec).toContain('primeira')

    const view2 = await gw.send(sendReq(sid, 'segunda'))
    expect(view2.status).toBe('queued')
    expect(view2.id).not.toBe(view.id)
    expect(gw.sent).toHaveLength(2)
    expect(JSON.stringify(gw.sent[1])).toContain('segunda')
  })

  it("AC-T03-03 failNext('SESSION_NOT_CONNECTED') faz o próximo send rejeitar com 409 (só o próximo)", async () => {
    const gw = await newFakeGateway()
    const sid = await ensureSession(gw)
    gw.failNext('SESSION_NOT_CONNECTED')
    const err: any = await gw.send(sendReq(sid)).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(err, 'send deveria rejeitar').toBeDefined()
    expect(err).toBeInstanceOf((port as any).SendRejectedError)
    expect(err.code).toBe('SESSION_NOT_CONNECTED')
    expect(err.status).toBe(409)

    const ok = await gw.send(sendReq(sid, 'depois'))
    expect(ok.status).toBe('queued')
    expect(JSON.stringify(gw.sent)).toContain('depois')
  })

  it("AC-T03-03 failNext('RATE_LIMIT') rejeita com 429 conforme a tabela do pipeline", async () => {
    const gw = await newFakeGateway()
    const sid = await ensureSession(gw)
    gw.failNext('RATE_LIMIT')
    const err: any = await gw.send(sendReq(sid)).catch((e: unknown) => e)
    expect(err?.code).toBe('RATE_LIMIT')
    expect(err?.status).toBe(429)
  })

  it('AC-T03-03 emit entrega o evento a todos os assinantes', async () => {
    const gw = await newFakeGateway()
    const { input } = firstAccepted(parse, 'message.status')
    expect(input, 'nenhum message.status válido para emitir').toBeDefined()
    const a: any[] = []
    const b: any[] = []
    const c: any[] = []
    subscribeEvents(gw, (ev) => a.push(ev))
    subscribeEvents(gw, (ev) => b.push(ev))
    subscribeEvents(gw, (ev) => c.push(ev))
    await gw.emit(input)
    await new Promise((r) => setTimeout(r, 20))
    for (const got of [a, b, c]) {
      expect(got).toHaveLength(1)
      expect(JSON.parse(JSON.stringify(got[0]))).toEqual(input)
    }
  })
})
