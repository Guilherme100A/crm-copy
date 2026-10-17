// AC-T102-03..05: jornadas completas de automação, IA e risco no sistema montado como produção (ver setup.ts).
// Cada jornada entra pelas portas públicas (HTTP da API, wa-worker fake) e é observada pelo transporte fake, pela API,
// pelo e-mail em memória do worker e pelas linhas crm.* de resultado.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { expectApiError } from '../helpers/http'
import {
  action,
  activeFlow,
  aiKey,
  bodyOf,
  chatOf,
  connection,
  edge,
  fake,
  history,
  llmCallsOf,
  MODEL,
  node,
  phone,
  receive,
  runsOf,
  say,
  sent,
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
let llm: Any

beforeAll(async () => {
  sys = await startSystem()
  llm = await import('@crm/ai/testing')
}, 300_000)

afterAll(async () => {
  await sys?.close()
}, 120_000)

// O FakeLlm do processo é um só: passos de roteiro não consumidos não podem vazar para o próximo teste.
afterEach(async () => {
  for (let i = 0; sys?.llm && sys.llm.remaining > 0 && i < 20; i++)
    await sys.llm.generate({ model: { provider: 'openai', model: 'drain' }, instructions: '', messages: [], tenantId: 'drain' }).catch(() => {})
})

const digits = (e164: string) => e164.replace(/\D/g, '')
/** Textos enviados pelo transporte fake da sessão para o contato. */
const textsTo = async (sessionId: string, e164: string) => (await sent(sys, sessionId)).filter((s) => s.to.includes(digits(e164))).map((s) => s.text)

// ---------------------------------------------------------------- AC-T102-03 automação

const menuTexts = (k: string) => ({
  WELCOME: `Bem-vindo à loja ${k}!`,
  B1: `Ramo vendas ${k}`,
  B2: `Ramo suporte ${k}`,
  OTHER: `Opção inválida ${k}`,
  TIMEOUT: `Tempo esgotado ${k}`,
})

/** Fluxo boas-vindas → menu (espera a resposta, prazo de 8 s) → ramos, como fluxo de boas-vindas da conexão. */
async function menuFlow(t: Any, k: string): Promise<string> {
  const { WELCOME, B1, B2, OTHER, TIMEOUT } = menuTexts(k)
  const menu = node('M', 'interactive_menu', [
    action('M-a', 'send_interactive_menu', {
      menuType: 'list',
      buttonLabel: 'Ver opções',
      message: `Escolha uma opção ${k}`,
      options: [
        { id: 'vendas', title: 'Vendas' },
        { id: 'suporte', title: 'Suporte' },
      ],
      // > 5 s: o prazo vira job atrasado do BullMQ (flow-timer), como em produção
      timeout_value: 8,
      timeout_unit: 'seconds',
    }),
  ])
  const flowId = await activeFlow(
    t,
    [say('W', WELCOME), menu, say('B1', B1), say('B2', B2), say('O', OTHER), say('T', TIMEOUT)],
    [edge('start', 'source', 'W'), edge('W', 'source', 'M'), edge('M', 'option:vendas', 'B1'), edge('M', 'option:suporte', 'B2'), edge('M', 'other', 'O'), edge('M', 'timeout', 'T')],
  )
  const cfg = await t.c.put(`/api/connection-flow-configs/${t.connectionId}`, { welcome_flow_id: flowId })
  expect(cfg.status, cfg.text).toBe(200)
  return flowId
}

describe('T102 — jornada de automação (AC-T102-03)', () => {
  it('AC-T102-03 boas-vindas + menu + espera: "2" segue o ramo 2; sem resposta segue o ramo de timeout', async () => {
    const t = await tenant(sys)
    const k = tag()
    const { WELCOME, B1, B2, OTHER, TIMEOUT } = menuTexts(k)
    await menuFlow(t, k)

    // contato 1: chega, recebe boas-vindas e menu, responde "2"
    const p1 = phone()
    await receive(sys, t.sessionId, p1, 'oi, tudo bem?')
    const chat1 = await chatOf(sys, t.companyId, p1)
    await waitFor(async () => (await textsTo(t.sessionId, p1)).some((s) => s.includes(`Escolha uma opção ${k}`)), 45_000, 'menu enviado ao contato 1')
    const first = await textsTo(t.sessionId, p1)
    expect(first.filter((s) => s === WELCOME), 'boas-vindas 1 vez').toHaveLength(1)
    const menuText = first.find((s) => s.includes(`Escolha uma opção ${k}`))!
    expect(menuText).toMatch(/1\D+Vendas/)
    expect(menuText).toMatch(/2\D+Suporte/)
    expect(first.indexOf(WELCOME)).toBeLessThan(first.indexOf(menuText))
    await waitFor(async () => (await runsOf(sys, chat1)).some((r: Any) => r.status === 'waiting'), 20_000, 'run do contato 1 esperando a resposta')

    await receive(sys, t.sessionId, p1, '2')
    await waitFor(async () => (await textsTo(t.sessionId, p1)).includes(B2), 45_000, 'ramo 2 enviado').catch(async (e) => {
      const kit: Any = await import('@crm/node-kit')
      const redis = kit.redisConnection({ url: process.env.REDIS_URL })
      const keys: string[] = await redis.keys(`${process.env.CRM_QUEUE_PREFIX}:*`)
      const queues = [...new Set(keys.map((k) => k.split(':')[1]))]
      const counts: Any = {}
      for (const qn of queues) {
        const b = `${process.env.CRM_QUEUE_PREFIX}:${qn}`
        counts[qn] = { wait: await redis.llen(`${b}:wait`), active: await redis.llen(`${b}:active`), delayed: await redis.zcard(`${b}:delayed`), failed: await redis.zcard(`${b}:failed`) }
        if (counts[qn].failed) counts[qn].lastFailed = await redis.zrange(`${b}:failed`, -1, -1).then(async (ids: string[]) => (ids[0] ? redis.hget(`${b}:${ids[0]}`, 'failedReason') : null))
      }
      await redis.quit()
      const act = await sys.q(`SELECT pid, state, wait_event_type, wait_event, now() - query_start AS age, left(query, 160) AS q FROM pg_stat_activity WHERE datname = current_database() AND state <> 'idle' AND pid <> pg_backend_pid()`)
      const runs = await sys.q(`SELECT id, status, current_node_key, seq, wait, error FROM crm.flow_runs WHERE chat_id = $1`, [chat1])
      const msgs = (await history(t, chat1)).map((m: Any) => [m.direction, bodyOf(m), m.wa_message_id])
      throw new Error(`${(e as Error).message}
filas: ${JSON.stringify(counts)}
pg: ${JSON.stringify(act)}
runs: ${JSON.stringify(runs)}
histórico: ${JSON.stringify(msgs)}`)
    })
    await waitFor(async () => (await runsOf(sys, chat1)).every((r: Any) => r.status === 'completed'), 20_000, 'run do contato 1 concluído')
    // espera passar o prazo do menu: o timeout não pode disparar num run que já seguiu
    await sleep(10_000)
    const after1 = await textsTo(t.sessionId, p1)
    expect(after1.filter((s) => s === B2), 'ramo 2 uma vez').toHaveLength(1)
    expect(after1, 'ramo errado').not.toContain(B1)
    expect(after1).not.toContain(OTHER)
    expect(after1, 'timeout num run que já respondeu').not.toContain(TIMEOUT)
    // o histórico do chat registra o que o fluxo enviou
    const h1 = (await history(t, chat1)).map(bodyOf)
    expect(h1).toContain(WELCOME)
    expect(h1).toContain(B2)

    // contato 2: recebe o menu e não responde → ramo de timeout. Vai por outra empresa com o mesmo fluxo: a sessão nova
    // tem limite de envios por minuto (gate RATE_LIMIT) e o FakeTransport numera as recebidas por transporte (FAKE-IN-n),
    // que colidiriam com as da 1ª conexão no índice (company_id, wa_message_id).
    const t2 = await tenant(sys)
    await menuFlow(t2, k)
    const c2 = t2
    const p2 = phone()
    await receive(sys, c2.sessionId, p2, 'olá')
    const chat2 = await chatOf(sys, t2.companyId, p2)
    await waitFor(async () => (await textsTo(c2.sessionId, p2)).some((s) => s.includes(`Escolha uma opção ${k}`)), 45_000, 'menu enviado ao contato 2')
    await waitFor(async () => (await textsTo(c2.sessionId, p2)).includes(TIMEOUT), 60_000, 'ramo de timeout enviado').catch(async (e) => {
      const runs = await sys.q(`SELECT id, status, current_node_key, seq, wait, error FROM crm.flow_runs WHERE chat_id = $1`, [chat2])
      throw new Error(`${(e as Error).message}
runs: ${JSON.stringify(runs)}
enviados: ${JSON.stringify(await textsTo(c2.sessionId, p2))}`)
    })
    const after2 = await textsTo(c2.sessionId, p2)
    expect(after2.filter((s) => s === TIMEOUT)).toHaveLength(1)
    expect(after2).not.toContain(B1)
    expect(after2).not.toContain(B2)
    await waitFor(async () => (await runsOf(sys, chat2)).every((r: Any) => r.status === 'completed'), 20_000, 'run do contato 2 concluído')
  })
})

// ---------------------------------------------------------------- AC-T102-04 IA

const walletOf = async (t: Any) => {
  const r = await t.c.get('/api/ai/wallet')
  if (r.status !== 200) throw new Error(`carteira: ${r.status} ${r.text}`)
  return r.body.wallet
}
const chatDto = async (t: Any, chatId: string) => (await t.c.get(`/api/chats/${chatId}`)).body?.chat
const eventsOf = async (t: Any, chatId: string): Promise<Any[]> => (await t.c.get(`/api/chats/${chatId}/events`)).body?.items ?? []
const usageCount = async (companyId: string) => (await sys.q(`SELECT count(*)::int AS n FROM crm.ai_usage WHERE company_id = $1`, [companyId]))[0].n as number

describe('T102 — jornada de IA (AC-T102-04)', () => {
  it('AC-T102-04 agente ativo responde com o FakeLlm e consome créditos; a habilidade transfere para humano; carteira esgotada transfere sem chamar o LLM', async () => {
    const t = await tenant(sys)
    await aiKey(t, 'openai')
    // créditos da empresa (como a recarga da plataforma deixaria)
    await sys.q(
      `INSERT INTO crm.ai_wallets (company_id, balance_credits, status) VALUES ($1, 1000000000, 'ok')
       ON CONFLICT (company_id) DO UPDATE SET balance_credits = 1000000000, max_overrun_credits = 0, status = 'ok'`,
      [t.companyId],
    )
    const agent = await t.c.post('/api/ai-agents', {
      name: `Agente ${tag()}`,
      generated_prompt: 'Você é um atendente cordial da loja.',
      model: { provider: 'openai', model: MODEL },
      settings: { buffer_enabled: false, split_messages: false },
      skills: [{ when_text: 'o cliente pede para falar com um humano', action_type: 'transfer_human', action_params: {} }],
    })
    expect(agent.status, agent.text).toBe(201)
    const agentId = agent.body.agent.id
    const pub = await t.c.post(`/api/ai-agents/${agentId}/publish`, {})
    expect(pub.status, pub.text).toBe(200)

    const p = phone()
    await receive(sys, t.sessionId, p, 'oi')
    const chatId = await chatOf(sys, t.companyId, p)
    // a 1ª mensagem (antes do agente) termina de ser processada antes de vincular o agente
    await waitFor(async () => (await history(t, chatId)).some((m: Any) => bodyOf(m) === 'oi'), 20_000, '1ª mensagem no histórico')
    await sleep(2000)
    const link = await t.c.patch(`/api/chats/${chatId}`, { ai_agent_id: agentId })
    expect(link.status, link.text).toBe(200)

    // 1) resposta do agente pelo FakeLlm, consumindo créditos
    const w0 = await walletOf(t)
    const u0 = await usageCount(t.companyId)
    const calls0 = llmCallsOf(sys, t.companyId).length
    const answer = `Temos cursos de segunda a sexta ${tag()}`
    sys.llm.enqueue(llm.text(answer))
    await receive(sys, t.sessionId, p, 'quais cursos vocês têm?')
    await waitFor(async () => (await textsTo(t.sessionId, p)).includes(answer), 60_000, 'resposta do agente no wa-worker')
    const turn = llmCallsOf(sys, t.companyId).slice(calls0)
    expect(turn, `chamadas ao LLM no turno: ${turn.length}`).toHaveLength(1)
    await waitFor(async () => (await usageCount(t.companyId)) === u0 + 1, 20_000, '1 linha em ai_usage')
    const w1 = await waitFor(async () => {
      const w = await walletOf(t)
      return Number(w.balance_credits) < Number(w0.balance_credits) ? w : undefined
    }, 20_000, 'saldo de créditos debitado')
    expect(Number(w1.lifetime_spent_credits)).toBeGreaterThan(Number(w0.lifetime_spent_credits ?? 0))
    const reply = await waitFor(async () => (await history(t, chatId)).find((m: Any) => bodyOf(m) === answer), 20_000, 'resposta no histórico')
    expect(reply.sender_type).toBe('ai')

    // 2) habilidade "transferir para humano": o LLM chama a ferramenta e o chat volta para a fila humana
    const bye = `Vou te passar para um atendente ${tag()}`
    sys.llm.enqueue(llm.toolCall('transfer_human', { reason: 'pediu humano' }), llm.text(bye))
    const calls1 = llmCallsOf(sys, t.companyId).length
    await receive(sys, t.sessionId, p, 'quero falar com um humano, por favor')
    await waitFor(async () => (await chatDto(t, chatId))?.ai_agent_id === null, 60_000, 'chat transferido (sem agente)').catch(async (e) => {
      const calls = llmCallsOf(sys, t.companyId).slice(calls1).map((c: Any) => ({ tools: (c.tools ?? []).map((x: Any) => x.name), n: c.messages?.length }))
      const st = await sys.q(`SELECT paused, paused_reason FROM crm.ai_conversation_state WHERE chat_id = $1`, [chatId]).catch(() => [])
      throw new Error(`${(e as Error).message}
chat: ${JSON.stringify(await chatDto(t, chatId))}
eventos: ${JSON.stringify((await eventsOf(t, chatId)).map((x: Any) => [x.type, x.detail]))}
chamadas LLM: ${JSON.stringify(calls)}
roteiro restante: ${sys.llm.remaining}
estado IA: ${JSON.stringify(st)}
enviados: ${JSON.stringify(await textsTo(t.sessionId, p))}`)
    })
    const lastCall = llmCallsOf(sys, t.companyId).at(-1)
    expect(llmCallsOf(sys, t.companyId).length).toBeGreaterThan(calls1)
    expect((lastCall.tools ?? []).map((x: Any) => x.name)).toContain('transfer_human')
    const transferred = await chatDto(t, chatId)
    expect(transferred.status).toBe('waiting')
    expect(transferred.assigned_user_id ?? null).toBeNull()
    const ev = await waitFor(async () => (await eventsOf(t, chatId)).find((e: Any) => e.type === 'ai_transferred'), 20_000, 'evento ai_transferred')
    expect(ev.detail?.reason).toBe('transfer_human')
    await waitFor(async () => (await textsTo(t.sessionId, p)).includes(bye), 30_000, 'mensagem de transferência')
    expect(await usageCount(t.companyId)).toBeGreaterThan(u0 + 1)
    // depois da transferência o agente não responde mais
    const calls2 = llmCallsOf(sys, t.companyId).length
    await receive(sys, t.sessionId, p, 'alô?')
    await sleep(6000)
    expect(llmCallsOf(sys, t.companyId).length, 'agente respondeu depois de transferir').toBe(calls2)

    // 3) carteira esgotada: novo contato com o agente → transfere sem chamar o LLM e sem consumir
    const p2 = phone()
    await receive(sys, t.sessionId, p2, 'oi')
    const chat2 = await chatOf(sys, t.companyId, p2)
    expect((await t.c.patch(`/api/chats/${chat2}`, { ai_agent_id: agentId })).status).toBe(200)
    await sys.q(`UPDATE crm.ai_wallets SET balance_credits = 0, max_overrun_credits = 0, status = 'exhausted' WHERE company_id = $1`, [t.companyId])
    const calls3 = llmCallsOf(sys, t.companyId).length
    const u3 = await usageCount(t.companyId)
    const sentBefore = (await textsTo(t.sessionId, p2)).length
    await receive(sys, t.sessionId, p2, 'qual o preço do curso?')
    await waitFor(async () => (await chatDto(t, chat2))?.ai_agent_id === null, 60_000, 'chat transferido por falta de créditos')
    const ev2 = await waitFor(async () => (await eventsOf(t, chat2)).find((e: Any) => e.type === 'ai_transferred'), 20_000, 'evento ai_transferred (sem saldo)')
    expect(ev2.detail?.reason).toBe('no_balance')
    expect((await chatDto(t, chat2)).status).toBe('waiting')
    expect(llmCallsOf(sys, t.companyId).length, 'LLM chamado com a carteira esgotada').toBe(calls3)
    expect(await usageCount(t.companyId)).toBe(u3)
    expect((await textsTo(t.sessionId, p2)).length, 'agente respondeu sem créditos').toBe(sentBefore)
  })
})

// ---------------------------------------------------------------- AC-T102-05 risco

describe('T102 — jornada de risco (AC-T102-05)', () => {
  it('AC-T102-05 conexão recebe 403 → PAUSED/banida, alerta por e-mail ao dono e envio seguinte rejeitado com SESSION_NOT_CONNECTED', async () => {
    const t = await tenant(sys)
    const p = phone()
    await receive(sys, t.sessionId, p, 'oi')
    const chatId = await chatOf(sys, t.companyId, p)
    const ok = await t.c.post(`/api/chats/${chatId}/messages`, { type: 'text', text: `antes do ban ${tag()}` })
    expect(ok.status, ok.text).toBe(201)
    const sentBefore = (await sent(sys, t.sessionId)).length

    const mailsBefore = sys.workerMail.messages.length
    const close = await fake(sys.wa, sys.wenv, `sessions/${t.sessionId}/close`, { reason: 'forbidden', statusCode: 403 })
    expect(close.status, JSON.stringify(close.body)).toBe(200)

    const conn = await waitFor(
      async () => {
        const c = (await t.c.get(`/api/connections/${t.connectionId}`)).body?.connection
        return c?.session_state === 'PAUSED' && c?.status === 'banned' ? c : undefined
      },
      30_000,
      'conexão PAUSED/banida',
    ).catch(async (e) => {
      throw new Error(`${(e as Error).message}; conexão: ${JSON.stringify((await t.c.get(`/api/connections/${t.connectionId}`)).body)}`)
    })
    expect(conn.session_state).toBe('PAUSED')
    expect(conn.status).toBe('banned')

    const mail = await waitFor(
      () => sys.workerMail.messages.slice(mailsBefore).find((m: Any) => [m.to].flat().includes(t.email)),
      30_000,
      'e-mail de alerta para o dono',
    )
    expect(String(mail.subject ?? '')).not.toBe('')

    const rejected = await t.c.post(`/api/chats/${chatId}/messages`, { type: 'text', text: `depois do ban ${tag()}` })
    expectApiError(rejected, 'SESSION_NOT_CONNECTED', 409)
    await sleep(1500)
    expect((await sent(sys, t.sessionId)).length, 'nada pode sair pela sessão banida').toBe(sentBefore)
  })

  it('AC-T102-05 contato manda "SAIR" → opt-out → envio seguinte rejeitado com CONTACT_NOT_ALLOWED', async () => {
    const t = await tenant(sys)
    const p = phone()
    await receive(sys, t.sessionId, p, 'oi')
    const chatId = await chatOf(sys, t.companyId, p)
    const hello = `primeira resposta ${tag()}`
    const ok = await t.c.post(`/api/chats/${chatId}/messages`, { type: 'text', text: hello })
    expect(ok.status, ok.text).toBe(201)
    await waitFor(async () => (await textsTo(t.sessionId, p)).includes(hello), 30_000, 'envio antes do opt-out')

    await receive(sys, t.sessionId, p, 'SAIR')
    const [{ contact_id: contactId }] = await sys.q(`SELECT contact_id FROM crm.chats WHERE id = $1`, [chatId])
    await waitFor(async () => (await t.c.get(`/api/contacts/${contactId}`)).body?.contact?.opt_out === true, 30_000, 'contato com opt_out')

    const blocked = `depois do SAIR ${tag()}`
    const rejected = await t.c.post(`/api/chats/${chatId}/messages`, { type: 'text', text: blocked })
    expectApiError(rejected, 'CONTACT_NOT_ALLOWED', 403)
    await sleep(1500)
    expect(await textsTo(t.sessionId, p), 'mensagem saiu para contato com opt-out').not.toContain(blocked)
  })

  it('AC-T102-05 jornada inteira na mesma empresa: ban de uma conexão não afeta o opt-out da outra', async () => {
    const t = await tenant(sys)
    const second = await connection(sys, t, 'Conexão reserva T102')
    // contato na conexão 2 faz opt-out; a conexão 1 é banida
    const p = phone()
    await receive(sys, second.sessionId, p, 'oi')
    const chat2 = await chatOf(sys, t.companyId, p)
    await receive(sys, second.sessionId, p, 'sair')
    const [{ contact_id: contactId }] = await sys.q(`SELECT contact_id FROM crm.chats WHERE id = $1`, [chat2])
    await waitFor(async () => (await t.c.get(`/api/contacts/${contactId}`)).body?.contact?.opt_out === true, 30_000, 'opt_out (minúsculas)')
    expect((await fake(sys.wa, sys.wenv, `sessions/${t.sessionId}/close`, { reason: 'forbidden', statusCode: 403 })).status).toBe(200)
    await waitFor(async () => (await t.c.get(`/api/connections/${t.connectionId}`)).body?.connection?.session_state === 'PAUSED', 30_000, 'conexão 1 PAUSED')
    expect((await t.c.get(`/api/connections/${second.connectionId}`)).body.connection.session_state).not.toBe('PAUSED')
    expectApiError(await t.c.post(`/api/chats/${chat2}/messages`, { type: 'text', text: 'x' }), 'CONTACT_NOT_ALLOWED', 403)
  })
})


