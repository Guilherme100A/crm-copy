// AC-T29-05: SIGTERM fecha sockets e filas; ao subir de novo, as sessões reconectam sem perder nem duplicar
// mensagens enfileiradas. O desligamento usa POST /internal/fake/shutdown, que dispara o MESMO caminho do
// SIGTERM do main.ts (no Windows, process.kill(pid, 'SIGTERM') encerra o filho sem rodar handlers).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, connectedSession, fake, newWorkerEnv, phone, rand, startWorker, waitFor, type Worker, type WorkerEnv } from './support'

let env: WorkerEnv
let w1: Worker | undefined
let w2: Worker | undefined

beforeAll(() => {
  env = newWorkerEnv()
})

afterAll(async () => {
  for (const w of [w1, w2]) await w?.shutdown().catch(() => w?.kill())
  env?.cleanup()
}, 60_000)

describe('T29 — desligamento e retomada (AC-T29-05)', () => {
  it('AC-T29-05 shutdown (SIGTERM) sai limpo; no novo boot a sessão reconecta e cada mensagem enfileirada sai uma única vez', async () => {
    w1 = await startWorker(env)
    const sid = await connectedSession(w1, env)
    const to = phone()
    await call(w1, env, 'contacts', 'recordConsent', { phone: to, source: 'inbound' })

    // derruba a conexão (queda transitória): as mensagens são aceitas e ficam retidas na fila até reconectar
    expect((await fake(w1, env, `sessions/${sid}/close`, { reason: 'transient' })).status).toBe(200)
    const texts = [0, 1, 2].map((i) => `retida ${i} ${rand(2)}`)
    const ids: string[] = []
    for (const text of texts) ids.push((await call(w1, env, 'messages', 'enqueue', { sessionId: sid, phone: to, content: { text }, actor: 'crm:user-t29' })).id)
    for (const id of ids) expect((await call(w1, env, 'messages', 'get', id)).status).toBe('queued')

    // SIGTERM: fecha sockets e filas e o processo sai com código 0
    const code = await w1.shutdown()
    expect(code, w1.output().slice(-2000)).toBe(0)

    // novo boot no mesmo banco/Redis
    w2 = await startWorker(env)
    const boot2 = (await fake(w2, env, 'boot', undefined, 'GET')).body.bootId
    await waitFor(async () => (await fake(w2!, env, `sessions/${sid}/open`)).status === 200, 30_000, 'transporte reconectando no novo boot')
    for (const id of ids) await waitFor(async () => (await call(w2!, env, 'messages', 'get', id)).status === 'sent', 30_000, `mensagem ${id} sent`)

    // nenhuma perdida, nenhuma duplicada (histórico de envios persistido por boot)
    const history = (await fake(w2, env, `sessions/${sid}/sent-history`, undefined, 'GET')).body.items ?? []
    const all = JSON.stringify(history)
    for (const text of texts) {
      const n = all.split(text).length - 1
      expect(n, `"${text}" enviada ${n} vezes`).toBe(1)
    }
    expect(boot2).toBeTruthy()
    const status = (await call(w2, env, 'sessions', 'get', sid)).status
    expect(['WARMING', 'STABLE']).toContain(status)
  })
})
