// AC-T61-01..05 pela porta FlowTriggers.handleInbound (consumidor de crm.inbound), com configs gravadas pela API.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HOUR, activeAgent, inbound, newChat, newFlow, putConfig, startEnv, tenant, triggers, type Env, type Tenant } from './setup'

let env: Env

beforeAll(async () => {
  env = await startEnv()
}, 120_000)

afterAll(async () => {
  await env?.close()
})

const T0 = new Date('2026-10-14T15:00:00.000Z') // quarta-feira, 12:00 em São Paulo

async function scenario(cfg: (t: Tenant, f: Record<string, string>) => Record<string, unknown>) {
  const t = await tenant(env)
  const f = {
    kw: await newFlow(env, t.companyId, 'Palavra-chave'),
    kw2: await newFlow(env, t.companyId, 'Palavra-chave 2'),
    welcome: await newFlow(env, t.companyId, 'Boas-vindas'),
    def: await newFlow(env, t.companyId, 'Resposta padrão'),
    fin: await newFlow(env, t.companyId, 'Conversa finalizada'),
  }
  await putConfig(t, cfg(t, f))
  return { t, f }
}

describe('T61 — palavra-chave (AC-T61-01)', () => {
  const CASES: Array<[string, string, string, boolean]> = [
    ['equals', 'preço', 'Preço', true],
    ['equals', 'preço', 'qual o preço?', false],
    ['contains', 'preço', 'qual o preço do plano?', true],
    ['contains', 'preço', 'quero comprar', false],
    ['starts_with', 'oi', 'oi, tudo bem?', true],
    ['starts_with', 'oi', 'tudo bem? oi', false],
    ['ends_with', 'obrigado', 'muito obrigado', true],
    ['ends_with', 'obrigado', 'obrigado pela ajuda', false],
    ['different', 'sair', 'quero saber mais', true],
    ['different', 'sair', 'sair', false],
    ['excludes', 'cancelar', 'quero assinar', true],
    ['excludes', 'cancelar', 'quero cancelar agora', false],
  ]

  for (const [match, keyword, text, hit] of CASES) {
    it(`AC-T61-01 ${match} "${keyword}" × "${text}" → ${hit ? 'dispara a palavra-chave mesmo com boas-vindas' : 'não casa (cai nas boas-vindas)'}`, async () => {
      const { t, f } = await scenario((_t, f) => ({
        welcome_flow_id: f.welcome,
        keyword_triggers: [{ flow_id: f.kw, rule_type: 'any', conditions: [{ keyword, match_type: match }] }],
      }))
      const chat = await newChat(env, t)
      const tr = triggers(env, { now: T0 })
      const r = await tr.handle(await inbound(env, t, chat, text, T0, { created: true }))
      if (hit) {
        expect(r.outcome).toBe('keyword')
        expect(tr.flows()).toEqual([f.kw])
      } else {
        expect(r.outcome).toBe('welcome')
        expect(tr.flows()).toEqual([f.welcome])
      }
    })
  }

  it('AC-T61-01 regra any: basta uma condição; regra all: precisa de todas', async () => {
    const { t, f } = await scenario((_t, f) => ({
      welcome_flow_id: f.welcome,
      keyword_triggers: [
        { flow_id: f.kw, rule_type: 'all', conditions: [{ keyword: 'plano', match_type: 'contains' }, { keyword: 'anual', match_type: 'contains' }], position: 0 },
        { flow_id: f.kw2, rule_type: 'any', conditions: [{ keyword: 'boleto', match_type: 'contains' }, { keyword: 'pix', match_type: 'contains' }], position: 1 },
      ],
    }))
    const all = triggers(env, { now: T0 })
    expect((await all.handle(await inbound(env, t, await newChat(env, t), 'quero o plano anual', T0, { created: true }))).outcome).toBe('keyword')
    expect(all.flows()).toEqual([f.kw])

    const partial = triggers(env, { now: T0 })
    expect((await partial.handle(await inbound(env, t, await newChat(env, t), 'quero o plano mensal', T0, { created: true }))).outcome).toBe('welcome')

    const any = triggers(env, { now: T0 })
    expect((await any.handle(await inbound(env, t, await newChat(env, t), 'pode ser no pix?', T0, { created: true }))).outcome).toBe('keyword')
    expect(any.flows()).toEqual([f.kw2])
  })

  it('AC-T61-01 gatilho inativo não dispara', async () => {
    const { t, f } = await scenario((_t, f) => ({
      welcome_flow_id: f.welcome,
      keyword_triggers: [{ flow_id: f.kw, conditions: [{ keyword: 'promo', match_type: 'contains' }], active: false }],
    }))
    const tr = triggers(env, { now: T0 })
    expect((await tr.handle(await inbound(env, t, await newChat(env, t), 'tem promo?', T0, { created: true }))).outcome).toBe('welcome')
  })
})

describe('T61 — boas-vindas e resposta padrão (AC-T61-02)', () => {
  it('AC-T61-02 boas-vindas só no primeiro contato (chat recém-criado)', async () => {
    const { t, f } = await scenario((_t, f) => ({ welcome_flow_id: f.welcome }))
    const chat = await newChat(env, t)
    const tr = triggers(env, { now: T0 })
    expect((await tr.handle(await inbound(env, t, chat, 'olá', T0, { created: true }))).outcome).toBe('welcome')
    const later = new Date(T0.getTime() + 60_000)
    const tr2 = triggers(env, { now: later })
    expect((await tr2.handle(await inbound(env, t, chat, 'olá de novo', later))).outcome).not.toBe('welcome')
    expect(tr2.flows()).not.toContain(f.welcome)
  })

  it('AC-T61-02 resposta padrão só depois de delay_hours sem mensagem do contato', async () => {
    const { t, f } = await scenario((_t, f) => ({ default_response_flow_id: f.def, default_response_delay_hours: 2 }))
    const chat = await newChat(env, t)
    await inbound(env, t, chat, 'primeira', new Date(T0.getTime() - 1 * HOUR))
    const soon = triggers(env, { now: T0 })
    const r1 = await soon.handle(await inbound(env, t, chat, 'cedo demais', T0))
    expect(r1.outcome).toBe('none')
    expect(soon.flows()).toEqual([])

    const chat2 = await newChat(env, t)
    await inbound(env, t, chat2, 'antiga', new Date(T0.getTime() - 3 * HOUR))
    const late = triggers(env, { now: T0 })
    const r2 = await late.handle(await inbound(env, t, chat2, 'voltei', T0))
    expect(r2.outcome).toBe('default_response')
    expect(late.flows()).toEqual([f.def])
  })

  it('AC-T61-02 delay_hours fora de 1–168 → 422', async () => {
    const t = await tenant(env)
    const def = await newFlow(env, t.companyId)
    for (const h of [0, 169, -1]) {
      const r = await t.c.put(`/api/connection-flow-configs/${t.connectionId}`, { default_response_flow_id: def, default_response_delay_hours: h })
      expect(r.status, `delay ${h}`).toBe(422)
    }
  })
})

describe('T61 — run em espera e dedupe (AC-T61-03)', () => {
  it('AC-T61-03 mensagem que responde a um run em espera vai para o run e nenhum gatilho dispara (nem palavra-chave)', async () => {
    const { t, f } = await scenario((_t, f) => ({
      welcome_flow_id: f.welcome,
      default_response_flow_id: f.def,
      default_response_delay_hours: 1,
      keyword_triggers: [{ flow_id: f.kw, conditions: [{ keyword: 'sim', match_type: 'contains' }] }],
    }))
    const chat = await newChat(env, t)
    await env.q(
      `INSERT INTO crm.flow_runs (company_id, flow_id, contact_id, chat_id, status, wait) VALUES ($1, $2, $3, $4, 'waiting', $5)`,
      [t.companyId, f.fin, chat.contactId, chat.chatId, JSON.stringify({ kind: 'reply', handles: { reply: 'source' } })],
    )
    const tr = triggers(env, { now: T0 })
    const r = await tr.handle(await inbound(env, t, chat, 'sim, quero', T0, { created: true }))
    expect(r.outcome).toBe('run_reply')
    expect(tr.started).toEqual([])
  })

  it('AC-T61-03 o mesmo evento entregue duas vezes não cria dois runs', async () => {
    const { t, f } = await scenario((_t, f) => ({ welcome_flow_id: f.welcome }))
    const chat = await newChat(env, t)
    const ev = await inbound(env, t, chat, 'olá', T0, { created: true })
    const tr = triggers(env, { now: T0 })
    expect((await tr.handle(ev)).outcome).toBe('welcome')
    expect((await tr.handle({ ...ev })).outcome).toBe('duplicate')
    const tr2 = triggers(env, { now: T0 }) // outra instância (reentrega após restart)
    expect((await tr2.handle({ ...ev })).outcome).toBe('duplicate')
    expect(tr.flows()).toEqual([f.welcome])
    expect(tr2.started).toEqual([])
    const rows = await env.q(`SELECT count(*)::int AS n FROM crm.flow_trigger_events WHERE message_id = $1`, [ev.message_id])
    expect(rows[0].n).toBe(1)
  })
})

describe('T61 — supressão (AC-T61-04)', () => {
  it('AC-T61-04 chat em atendimento humano não recebe boas-vindas nem resposta padrão', async () => {
    const { t } = await scenario((_t, f) => ({ welcome_flow_id: f.welcome, default_response_flow_id: f.def, default_response_delay_hours: 1 }))
    const chat = await newChat(env, t, { status: 'attending', assignedUserId: t.userId })
    const tr = triggers(env, { now: T0 })
    expect((await tr.handle(await inbound(env, t, chat, 'olá', T0, { created: true }))).outcome).toBe('suppressed')
    const later = new Date(T0.getTime() + 5 * HOUR)
    const tr2 = triggers(env, { now: later })
    expect((await tr2.handle(await inbound(env, t, chat, 'ainda aqui', later))).outcome).toBe('suppressed')
    expect([...tr.started, ...tr2.started]).toEqual([])
  })

  it('AC-T61-04 chat com agente de IA ativo não recebe boas-vindas nem resposta padrão', async () => {
    const { t } = await scenario((_t, f) => ({ welcome_flow_id: f.welcome, default_response_flow_id: f.def, default_response_delay_hours: 1 }))
    const agent = await activeAgent(env, t.companyId)
    const chat = await newChat(env, t, { aiAgentId: agent })
    const tr = triggers(env, { now: T0 })
    expect((await tr.handle(await inbound(env, t, chat, 'olá', T0, { created: true }))).outcome).toBe('suppressed')
    expect(tr.started).toEqual([])
  })

  it('AC-T61-04 palavra-chave ainda dispara em atendimento humano (exceção)', async () => {
    const { t, f } = await scenario((_t, f) => ({
      welcome_flow_id: f.welcome,
      keyword_triggers: [{ flow_id: f.kw, conditions: [{ keyword: 'menu', match_type: 'equals' }] }],
    }))
    const chat = await newChat(env, t, { status: 'attending', assignedUserId: t.userId })
    const tr = triggers(env, { now: T0 })
    expect((await tr.handle(await inbound(env, t, chat, 'menu', T0))).outcome).toBe('keyword')
    expect(tr.flows()).toEqual([f.kw])
  })
})

describe('T61 — ação fora do horário (AC-T61-05)', () => {
  // Horário: só segunda 09:00–18:00 (America/Sao_Paulo, UTC−3). Sábado e domingo: fechado o dia todo.
  const SAT_10 = new Date('2026-10-17T13:00:00.000Z') // sábado 10:00 local → fechado
  const MON_12 = new Date('2026-10-19T15:00:00.000Z') // segunda 12:00 local → aberto

  async function withHours(action: Record<string, unknown>) {
    const t = await tenant(env)
    const r = await t.c.put(`/api/business-hours/${t.connectionId}`, {
      active: true,
      ...action,
      business_hours: [{ day_of_week: 1, start_time: '09:00', end_time: '18:00' }],
    })
    if (r.status !== 200) throw new Error(`business-hours: ${r.status} ${r.text}`)
    return t
  }

  const sentTexts = (text: string) => env.gateway.sent.filter((s: any) => JSON.stringify(s).includes(text))

  it('AC-T61-05 fora do horário a mensagem configurada sai uma vez por janela de 12 h por chat', async () => {
    const msg = `Estamos fechados ${Math.random().toString(36).slice(2, 7)}`
    const t = await withHours({ action_type: 'message', message_text: msg })
    const chat = await newChat(env, t)
    const r1 = await triggers(env, { now: SAT_10 }).handle(await inbound(env, t, chat, 'oi', SAT_10, { created: true }))
    expect(r1.out_of_hours).toBe('message')
    expect(sentTexts(msg)).toHaveLength(1)
    expect(JSON.stringify(sentTexts(msg)[0])).toContain(chat.phone)

    const plus1h = new Date(SAT_10.getTime() + 1 * HOUR)
    const r2 = await triggers(env, { now: plus1h }).handle(await inbound(env, t, chat, 'alô?', plus1h))
    expect(r2.out_of_hours ?? null).not.toBe('message')
    expect(sentTexts(msg)).toHaveLength(1)

    const plus13h = new Date(SAT_10.getTime() + 13 * HOUR) // sábado 23:00 local, ainda fechado
    const r3 = await triggers(env, { now: plus13h }).handle(await inbound(env, t, chat, 'e agora?', plus13h))
    expect(r3.out_of_hours).toBe('message')
    expect(sentTexts(msg)).toHaveLength(2)
  })

  it('AC-T61-05 a janela é por chat: outro chat fora do horário também recebe', async () => {
    const msg = `Fechado por chat ${Math.random().toString(36).slice(2, 7)}`
    const t = await withHours({ action_type: 'message', message_text: msg })
    await triggers(env, { now: SAT_10 }).handle(await inbound(env, t, await newChat(env, t), 'oi', SAT_10, { created: true }))
    await triggers(env, { now: SAT_10 }).handle(await inbound(env, t, await newChat(env, t), 'oi', SAT_10, { created: true }))
    expect(sentTexts(msg)).toHaveLength(2)
  })

  it('AC-T61-05 dentro do horário a ação não roda', async () => {
    const msg = `Nunca deveria sair ${Math.random().toString(36).slice(2, 7)}`
    const t = await withHours({ action_type: 'message', message_text: msg })
    const r = await triggers(env, { now: MON_12 }).handle(await inbound(env, t, await newChat(env, t), 'oi', MON_12, { created: true }))
    expect(r.out_of_hours ?? null).toBeNull()
    expect(sentTexts(msg)).toHaveLength(0)
  })

  it('AC-T61-05 ação do tipo fluxo inicia o fluxo configurado fora do horário', async () => {
    const t = await tenant(env)
    const flow = await newFlow(env, t.companyId, 'Fora do horário')
    const put = await t.c.put(`/api/business-hours/${t.connectionId}`, {
      active: true,
      action_type: 'flow',
      flow_id: flow,
      business_hours: [{ day_of_week: 1, start_time: '09:00', end_time: '18:00' }],
    })
    expect(put.status, put.text).toBe(200)
    const tr = triggers(env, { now: SAT_10 })
    const r = await tr.handle(await inbound(env, t, await newChat(env, t), 'oi', SAT_10, { created: true }))
    expect(r.out_of_hours).toBe('flow')
    expect(tr.flows()).toContain(flow)
  })
})
