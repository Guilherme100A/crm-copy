// AC-T122-02 — disparo em massa no worker montado como produção (T120): startProductionWorker chama configureMassDispatch,
// a fila 'mass-dispatch' prepara e roda os ticks sozinha. Montagem reaproveitada da suíte T120 (wa-worker real, WA_GATEWAY=rpc).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { messageFlow, phone, sentTexts, startSystem, tenant, waitFor, type System } from '../T120/setup'

let sys: System

beforeAll(async () => {
  sys = await startSystem()
}, 300_000)

afterAll(async () => {
  await sys?.close()
}, 120_000)

describe('T122 — disparos na montagem de produção', () => {
  it('AC-T122-02 disparo criado pela API (T60) é preparado e envia pelo wa-worker fake, terminando completed', async () => {
    const t = await tenant(sys)
    const text = `Oferta da semana ${Math.random().toString(36).slice(2, 8)}`
    const flow = await messageFlow(t, text)
    const to = phone()
    // pela API: o contato criado pelo CRM registra o consentimento no engine (regra 1.4 nº 3), como em produção
    const created = await t.c.post('/api/contacts', { name: 'Destinatária T122', phone_e164: to })
    expect(created.status, created.text).toBe(201)
    const ct = { id: (created.body.contact ?? created.body).id as string }

    const res = await t.c.post('/api/mass-dispatches', {
      name: 'Disparo T122',
      manifest: { version: 1, mode: 'ids', filters: {}, ids: [ct.id] },
      targets: [{ connection_id: t.connectionId, flow_id: flow }],
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      window_start: '00:00',
      window_end: '23:59',
      interval_min_seconds: 0,
      interval_max_seconds: 0,
    })
    expect(res.status, res.text).toBe(201)
    const id = res.body.mass_dispatch.id

    // preparação pelo worker de produção (fila mass-dispatch)
    await waitFor(async () => {
      const md = (await t.c.get(`/api/mass-dispatches/${id}`)).body.mass_dispatch
      return md?.preparation_progress?.phase === 'completed' || ['scheduled', 'running', 'completed'].includes(md?.status) ? md : undefined
    }, 60_000, 'preparação do disparo')

    // ao menos 1 mensagem pelo transporte do wa-worker
    try {
      await waitFor(async () => ((await sentTexts(sys, t)).includes(text) ? true : undefined), 90_000, 'envio do fluxo do disparo no wa-worker')
    } catch (err) {
      const md = (await t.c.get(`/api/mass-dispatches/${id}`)).body.mass_dispatch
      const rs = (await t.c.get(`/api/mass-dispatches/${id}/recipients`)).body.items
      const runs = await sys.q(`SELECT status, error, trigger FROM crm.flow_runs WHERE contact_id = $1`, [ct.id])
      throw new Error(`${String(err)}\ndispatch: ${JSON.stringify(md)}\nrecipients: ${JSON.stringify(rs)}\nruns: ${JSON.stringify(runs)}\nsent: ${JSON.stringify(await sentTexts(sys, t))}`)
    }

    const done = await waitFor(async () => {
      const md = (await t.c.get(`/api/mass-dispatches/${id}`)).body.mass_dispatch
      return md?.status === 'completed' ? md : undefined
    }, 90_000, 'disparo completed')
    expect(done).toMatchObject({ status: 'completed', sent_count: 1, pending_count: 0, failed_count: 0 })
    expect(done.finished_at).toBeTruthy()

    const rs = await t.c.get(`/api/mass-dispatches/${id}/recipients`)
    expect(rs.body.items).toEqual([expect.objectContaining({ contact_id: ct.id, status: 'started' })])
    // o run do fluxo nasceu do disparo e a mensagem foi enviada uma única vez
    const [run] = await sys.q(`SELECT trigger FROM crm.flow_runs WHERE contact_id = $1 ORDER BY started_at DESC LIMIT 1`, [ct.id])
    expect(run.trigger).toMatchObject({ kind: 'mass_dispatch', dispatch_id: id })
    expect((await sentTexts(sys, t)).filter((s) => s === text)).toHaveLength(1)
  }, 300_000)
})
