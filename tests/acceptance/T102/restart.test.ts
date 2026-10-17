// AC-T102-07: reiniciar wa-worker, worker e API do sistema montado (ver setup.ts) com mensagens na fila e runs em
// espera não perde nem duplica mensagens, e os runs continuam.
// Filas cobertas: (1) envios do CRM aceitos pelo engine com a sessão caída (fila do wa-worker); (2) mensagens recebidas
// no stream wsm:events com o worker parado (consumer group do CRM); (3) runs `waiting` por resposta e por prazo.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  action,
  activeFlow,
  bodyOf,
  chatOf,
  edge,
  fake,
  history,
  node,
  phone,
  receive,
  runsOf,
  say,
  sentHistory,
  sleep,
  startSystem,
  tag,
  tenant,
  waitFor,
  type System,
} from './setup'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

let sys: System

beforeAll(async () => {
  sys = await startSystem()
}, 300_000)

afterAll(async () => {
  await sys?.close()
}, 120_000)

const digits = (e164: string) => e164.replace(/\D/g, '')

/** Fluxo: pergunta + espera (resposta → ramo de resposta; prazo → ramo de timeout). */
function waitFlow(k: string, ask: string, onReply: string, onTimeout: string, timeout: { value: number; unit: string }) {
  return {
    nodes: [
      node('W', 'wait_response', [
        { ...action('W-m', 'send_message', { message_text: ask }), order: 0 },
        { ...action('W-w', 'wait_for_response', { wait_indefinitely: false, timeout_value: timeout.value, timeout_unit: timeout.unit }), order: 1 },
      ]),
      say(`R${k}`, onReply),
      say(`T${k}`, onTimeout),
    ],
    edges: [edge('start', 'source', 'W'), edge('W', 'source', `R${k}`), edge('W', 'timeout', `T${k}`)],
  }
}

describe('T102 — reinício dos processos (AC-T102-07)', () => {
  it('AC-T102-07 reiniciar wa-worker, worker e api com mensagens na fila e runs em espera: nada se perde nem duplica e os runs continuam', async () => {
    const t = await tenant(sys)
    const k = tag()

    // runs em espera: X espera resposta (prazo longo); Z espera o prazo (job atrasado do flow-timer, vence após o reinício)
    const ASK_X = `Qual o número do pedido? ${k}`
    const REPLY_X = `Recebido, obrigado ${k}`
    const TIMEOUT_X = `Sem resposta X ${k}`
    const fx = waitFlow('x', ASK_X, REPLY_X, TIMEOUT_X, { value: 1, unit: 'hours' })
    const flowX = await activeFlow(t, fx.nodes, fx.edges)
    const ASK_Z = `Ainda está aí? ${k}`
    const REPLY_Z = `Resposta Z ${k}`
    const TIMEOUT_Z = `Encerrando por falta de resposta ${k}`
    const fz = waitFlow('z', ASK_Z, REPLY_Z, TIMEOUT_Z, { value: 75, unit: 'seconds' })
    const flowZ = await activeFlow(t, fz.nodes, fz.edges)
    const cfg = await t.c.put(`/api/connection-flow-configs/${t.connectionId}`, {
      keyword_triggers: [
        { flow_id: flowX, conditions: [{ keyword: `pedido${k}`, match_type: 'equals' }] },
        { flow_id: flowZ, conditions: [{ keyword: `ajuda${k}`, match_type: 'equals' }] },
      ],
    })
    expect(cfg.status, cfg.text).toBe(200)

    const px = phone()
    const pz = phone()
    const py = phone()
    await receive(sys, t.sessionId, px, `pedido${k}`)
    await receive(sys, t.sessionId, pz, `ajuda${k}`)
    const chatX = await chatOf(sys, t.companyId, px)
    const chatZ = await chatOf(sys, t.companyId, pz)
    await waitFor(async () => (await runsOf(sys, chatX)).some((r: Any) => r.status === 'waiting'), 45_000, 'run X waiting')
    await waitFor(async () => (await runsOf(sys, chatZ)).some((r: Any) => r.status === 'waiting'), 45_000, 'run Z waiting')
    const zWaitingSince = Date.now()
    // contato Y (outra empresa/conexão: a sessão nova tem limite de envios por minuto) já tem chat para receber a fila
    const tY = await tenant(sys)
    await receive(sys, tY.sessionId, py, 'oi, primeira')
    const chatY = await chatOf(sys, tY.companyId, py)
    await waitFor(async () => (await history(tY, chatY)).some((m: Any) => bodyOf(m) === 'oi, primeira'), 20_000, 'primeira de Y')

    // (2) worker parado: mensagens recebidas ficam no stream
    await sys.stopWorker()
    const IN = [`entrada 1 ${k}`, `entrada 2 ${k}`]
    for (const text of IN) await receive(sys, tY.sessionId, py, text)

    // (1) sessão caída: o engine aceita e segura os envios na fila da sessão
    expect((await fake(sys.wa, sys.wenv, `sessions/${tY.sessionId}/close`, { reason: 'transient' })).status).toBe(200)
    await sleep(500)
    const OUT = [`fila 1 ${k}`, `fila 2 ${k}`, `fila 3 ${k}`]
    const outIds: string[] = []
    for (const text of OUT) {
      const r = await tY.c.post(`/api/chats/${chatY}/messages`, { type: 'text', text, client_message_id: `t102-${k}-${text.slice(-6).replace(/\W/g, '')}-${outIds.length}` })
      expect(r.status, r.text).toBe(201)
      outIds.push(r.body.message.id)
    }
    await sleep(500)
    expect((await sentHistory(sys, tY.sessionId)).filter((h) => OUT.includes(h.content?.text)), 'envio saiu com a sessão caída').toHaveLength(0)

    // reinício dos três processos
    const bootBefore = (await fake(sys.wa, sys.wenv, 'boot', undefined, 'GET')).body.bootId
    await sys.restartWaWorker()
    expect((await fake(sys.wa, sys.wenv, 'boot', undefined, 'GET')).body.bootId).not.toBe(bootBefore)
    await sys.restartApi()
    await sys.startWorker()
    // a sessão volta no novo wa-worker
    for (const sid of [t.sessionId, tY.sessionId])
      await waitFor(async () => (await fake(sys.wa, sys.wenv, `sessions/${sid}/open`)).status === 200, 60_000, 'sessão restaurada no novo boot')

    // (1) os 3 envios saem exatamente uma vez e ficam `sent` (ou além) no CRM
    await waitFor(async () => (await sentHistory(sys, tY.sessionId)).filter((h) => OUT.includes(h.content?.text)).length >= 3, 60_000, 'envios da fila após o reinício')
    await sleep(3000)
    const hist = await sentHistory(sys, tY.sessionId)
    for (const text of OUT) expect(hist.filter((h) => h.content?.text === text), `"${text}" enviado`).toHaveLength(1)
    for (const h of hist.filter((x) => OUT.includes(x.content?.text))) expect(h.to).toContain(digits(py))
    await waitFor(
      async () => {
        const msgs = await history(tY, chatY)
        return outIds.every((id) => ['sent', 'delivered', 'read'].includes(msgs.find((m: Any) => m.id === id)?.status))
      },
      45_000,
      'mensagens enfileiradas com status sent no CRM',
    )

    // (2) as recebidas com o worker parado entram no histórico uma vez cada
    await waitFor(async () => (await history(tY, chatY)).filter((m: Any) => IN.includes(bodyOf(m))).length >= 2, 45_000, 'recebidas durante a parada')
    const msgsY = await history(tY, chatY)
    for (const text of IN) expect(msgsY.filter((m: Any) => bodyOf(m) === text), `"${text}" no histórico`).toHaveLength(1)
    for (const text of OUT) expect(msgsY.filter((m: Any) => bodyOf(m) === text), `"${text}" no histórico`).toHaveLength(1)

    // (3a) run X continua com a resposta do contato. O FakeTransport do novo boot numera as recebidas de novo a partir de
    // FAKE-IN-1 (no WhatsApp real os ids são aleatórios) e o CRM deduplica por (company_id, wa_message_id): as 2 recebidas
    // desta sessão antes do reinício ocupam FAKE-IN-1..n, então n mensagens descartáveis consomem esses ids antes.
    const [{ n: usedIds }] = await sys.q(
      `SELECT coalesce(max(substring(wa_message_id from 'FAKE-IN-([0-9]+)')::int), 0) AS n FROM crm.messages WHERE company_id = $1 AND direction = 'inbound'`,
      [t.companyId],
    )
    const burner = phone()
    for (let i = 0; i < usedIds; i++) await receive(sys, t.sessionId, burner, `descartável ${i}`)
    await sleep(1500)
    await receive(sys, t.sessionId, px, '12345')
    await waitFor(async () => (await sentHistory(sys, t.sessionId)).some((h) => h.content?.text === REPLY_X), 45_000, 'ramo de resposta do run X').catch(async (e) => {
      const runs = await sys.q(`SELECT id, status, current_node_key, seq, wait, error FROM crm.flow_runs WHERE chat_id = $1`, [chatX])
      const msgs = (await history(t, chatX)).map((m: Any) => [m.direction, bodyOf(m), m.wa_message_id, m.status])
      const st = (await fake(sys.wa, sys.wenv, `sessions/${t.sessionId}/state`, undefined, 'GET')).body
      const kit: Any = await import('@crm/node-kit')
      const redis = kit.redisConnection({ url: process.env.REDIS_URL })
      const rows: Any[] = await redis.xrange(sys.wenv.stream, '-', '+')
      await redis.quit()
      const evs = rows.map(([, f]: Any) => JSON.parse(f[f.indexOf('event') + 1])).filter((ev: Any) => ev.session_id === t.sessionId)
      const brief = evs.map((ev: Any) => [ev.type, ev.state ?? ev.to ?? '', ev.reason ?? '', ev.message?.id ?? '', ev.message?.text ?? ''].join('|'))
      const dbm = await sys.q(`SELECT wa_message_id, body FROM crm.messages WHERE company_id = $1 AND direction = 'inbound' ORDER BY created_at`, [t.companyId])
      ;(e as Error).message += `
stream da sessão: ${JSON.stringify(brief)}
inbound no banco: ${JSON.stringify(dbm)}`
      throw new Error(`${(e as Error).message}
runs X: ${JSON.stringify(runs)}
histórico X: ${JSON.stringify(msgs)}
sessão: ${JSON.stringify({ connected: st.connected, sent: st.sent?.length })}
histórico de envios: ${JSON.stringify((await sentHistory(sys, t.sessionId)).map((h) => h.content?.text))}`)
    })
    await waitFor(async () => (await runsOf(sys, chatX)).every((r: Any) => r.status === 'completed'), 20_000, 'run X concluído')

    // (3b) run Z: o prazo vence depois do reinício e o ramo de timeout sai uma vez
    const left = Math.max(0, zWaitingSince + 75_000 - Date.now())
    await waitFor(async () => (await sentHistory(sys, t.sessionId)).some((h) => h.content?.text === TIMEOUT_Z), left + 60_000, 'ramo de timeout do run Z').catch(async (e) => {
      const runs = await sys.q(`SELECT id, status, current_node_key, seq, wait, error FROM crm.flow_runs WHERE chat_id = $1`, [chatZ])
      throw new Error(`${(e as Error).message}
runs Z: ${JSON.stringify(runs)}
envios: ${JSON.stringify((await sentHistory(sys, t.sessionId)).map((h) => h.content?.text))}`)
    })
    await waitFor(async () => (await runsOf(sys, chatZ)).every((r: Any) => r.status === 'completed'), 20_000, 'run Z concluído')

    await sleep(3000)
    const final = await sentHistory(sys, t.sessionId)
    for (const text of [ASK_X, REPLY_X, ASK_Z, TIMEOUT_Z]) expect(final.filter((h) => h.content?.text === text), `"${text}" uma vez`).toHaveLength(1)
    for (const text of [TIMEOUT_X, REPLY_Z]) expect(final.map((h) => h.content?.text), `ramo errado "${text}"`).not.toContain(text)
    const hx = (await history(t, chatX)).map(bodyOf)
    expect(hx.filter((b) => b === REPLY_X)).toHaveLength(1)
    expect(hx.filter((b) => b === '12345')).toHaveLength(1)
  })
})
