// AC-T68-01..06 — runtime do agente de IA com fakes: buffer, transferência, áudio, pausa por humano, saldo esgotado,
// envio pelo gateway como 'ai' e reenvio do providerData.
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chatRow, type Env, inbound, lastUserText, MODEL, newAgent, newChat, newOwner, rig, sentTo, skill, sleep, startEnv, state } from './setup'

let env: Env

beforeAll(async () => {
  env = await startEnv()
})
afterAll(async () => {
  await env?.close()
})

describe('T68 — buffer', () => {
  it('AC-T68-01 três mensagens em 3 s com buffer de 5 s geram um único turno com as três como entrada', async () => {
    const o = await newOwner(env)
    const agentId = await newAgent(o, { settings: { buffer_seconds: 5 } })
    const chat = await newChat(env, o, agentId)
    const r = rig(env, [env.ai.text('Claro! Te ajudo com isso.')])

    const texts = ['oi', 'queria saber do curso', 'de marketing']
    await r.runtime.onInbound(await inbound(env, o, chat, texts[0]!))
    await sleep(1500)
    await r.runtime.onInbound(await inbound(env, o, chat, texts[1]!))
    await sleep(1500)
    await r.runtime.onInbound(await inbound(env, o, chat, texts[2]!))
    const lastAt = Date.now()

    // antes do fim do buffer (reiniciado pela última mensagem) não há turno
    await sleep(3500)
    expect(r.llm.calls, 'turno antes do buffer acabar').toHaveLength(0)

    const deadline = Date.now() + 10_000
    while (r.turns.length === 0 && Date.now() < deadline) await sleep(100)
    await r.runtime.idle()
    expect(Date.now() - lastAt).toBeGreaterThanOrEqual(4_500)
    expect(r.llm.calls).toHaveLength(1)
    const user = lastUserText(r.llm.calls[0])
    const idx = texts.map((t) => user.indexOf(t))
    expect(idx.every((i) => i >= 0), `entrada do turno: ${user}`).toBe(true)
    expect([...idx].sort((a, b) => a - b)).toEqual(idx)
    expect(r.turns).toHaveLength(1)
    expect(r.turns[0].messageIds).toHaveLength(3)
  }, 30_000)
})

describe('T68 — transferir para humano', () => {
  it('AC-T68-02 transfer_human chamada pelo FakeLlm desliga o agente, atribui ao departamento configurado e publica chat.updated', async () => {
    const o = await newOwner(env)
    const dept = await o.c.post('/api/departments', { name: 'Comercial' })
    expect(dept.status, dept.text).toBe(201)
    const deptId = dept.body.department.id
    const agentId = await newAgent(o, { skills: [skill('transfer_human', { department_id: deptId })] })
    const chat = await newChat(env, o, agentId)
    const r = rig(env, [env.ai.toolCall('transfer_human', { reason: 'cliente pediu humano' }), env.ai.text('Vou te passar para um atendente.')])

    await r.runtime.onInbound(await inbound(env, o, chat, 'quero falar com uma pessoa'))
    await r.runtime.flush(chat.id)
    await r.runtime.idle()

    expect(r.llm.calls.length).toBeGreaterThanOrEqual(1)
    const toolNames = (r.llm.calls[0].tools ?? []).map((t: any) => t.name)
    expect(toolNames).toContain('transfer_human')
    const row = await chatRow(env, chat.id)
    expect(row.ai_agent_id).toBeNull()
    expect(row.department_id).toBe(deptId)
    const updated = r.published.filter((p) => p.type === 'chat.updated' && JSON.stringify(p.data).includes(chat.id))
    expect(updated.length, JSON.stringify(r.published.map((p) => p.type))).toBeGreaterThanOrEqual(1)
    expect((await state(env, chat.id))?.paused_reason).toBe('transfer_human')

    // depois da transferência o agente não responde mais nesse chat
    const before = r.llm.calls.length
    await r.runtime.onInbound(await inbound(env, o, chat, 'alô?'))
    await r.runtime.flush(chat.id)
    await r.runtime.idle()
    expect(r.llm.calls.length).toBe(before)
  })
})

describe('T68 — áudio', () => {
  async function audioInbound(o: any, chat: any) {
    const waId = `WAAUD-${randomBytes(5).toString('hex')}`
    const bytes = new Uint8Array([0x4f, 0x67, 0x67, 0x53, ...randomBytes(256)])
    env.gateway.setMedia(waId, bytes)
    const media = { session_id: o.sessionId, message_id: waId, mime: 'audio/ogg; codecs=opus', size: bytes.byteLength, sha256: null, key: null, status: 'pending' }
    return inbound(env, o, chat, '', { type: 'audio', media, waId })
  }

  it('AC-T68-03 áudio recebido é transcrito (FakeStt) antes do turno e a transcrição entra na entrada do LLM', async () => {
    const o = await newOwner(env)
    const agentId = await newAgent(o)
    const chat = await newChat(env, o, agentId)
    const stt = new env.ai.FakeStt({ text: 'quero saber os horários das aulas' })
    const r = rig(env, [env.ai.text('As aulas são à noite.')], { stt })
    await r.runtime.onInbound(await audioInbound(o, chat))
    await r.runtime.flush(chat.id)
    await r.runtime.idle()
    expect(stt.calls).toHaveLength(1)
    expect(r.llm.calls).toHaveLength(1)
    expect(lastUserText(r.llm.calls[0])).toContain('quero saber os horários das aulas')
  })

  it.each([
    ['link', 'Veja todos os detalhes em https://cursos.example.test/marketing'],
    ['preço', 'O curso custa R$ 297,00 à vista.'],
  ])('AC-T68-03 resposta com %s nunca vira áudio, mesmo com áudio ativo', async (_kind, reply) => {
    const o = await newOwner(env)
    const agentId = await newAgent(o, { settings: { audio_choice_enabled: true, audio_max_per_conversation: 10 } })
    const chat = await newChat(env, o, agentId)
    const r = rig(env, [env.ai.toolCall('send_audio', {}), env.ai.text(reply)])
    await r.runtime.onInbound(await inbound(env, o, chat, 'me manda um áudio explicando'))
    await r.runtime.flush(chat.id)
    await r.runtime.idle()
    expect(r.tts.calls, 'TTS não pode ser chamado').toHaveLength(0)
    const sends = sentTo(env, chat.phone)
    expect(sends.length).toBeGreaterThanOrEqual(1)
    expect(JSON.stringify(sends.map((s: any) => s.content))).toContain(reply.slice(0, 20))
    expect(sends.some((s: any) => s.content?.ptt || s.content?.audio)).toBe(false)
  })

  it('AC-T68-03 sanidade: resposta sem link/preço com send_audio vira nota de voz (TTS chamado)', async () => {
    const o = await newOwner(env)
    const agentId = await newAgent(o, { settings: { audio_choice_enabled: true, audio_max_per_conversation: 10 } })
    const chat = await newChat(env, o, agentId)
    const r = rig(env, [env.ai.toolCall('send_audio', {}), env.ai.text('Oi! Que bom falar com você, me conta o que procura')])
    await r.runtime.onInbound(await inbound(env, o, chat, 'me manda um áudio'))
    await r.runtime.flush(chat.id)
    await r.runtime.idle()
    expect(r.tts.calls).toHaveLength(1)
  })
})

describe('T68 — humano assume', () => {
  it('AC-T68-04 atendente envia mensagem pelo CRM com pause_on_human → agente pausa e não responde mais', async () => {
    const o = await newOwner(env)
    const agentId = await newAgent(o, { settings: { pause_on_human: true } })
    const chat = await newChat(env, o, agentId)
    const r = rig(env, [env.ai.text('Olá! Como posso ajudar?'), env.ai.text('não deveria sair')])
    await r.runtime.onInbound(await inbound(env, o, chat, 'oi'))
    await r.runtime.flush(chat.id)
    await r.runtime.idle()
    expect(r.llm.calls).toHaveLength(1)

    const human = await o.c.post(`/api/chats/${chat.id}/messages`, { type: 'text', text: 'Oi, aqui é a Ana, vou continuar com você.' })
    expect(human.status, human.text).toBe(201)

    const sentBefore = sentTo(env, chat.phone).length
    await r.runtime.onInbound(await inbound(env, o, chat, 'beleza'))
    await r.runtime.flush(chat.id)
    await r.runtime.idle()
    expect(r.llm.calls, 'LLM chamado depois do humano assumir').toHaveLength(1)
    expect(sentTo(env, chat.phone).length).toBe(sentBefore)
    const st = await state(env, chat.id)
    expect(st?.paused).toBe(true)
    expect(st?.paused_reason).toBe('human')
  })

  it('AC-T68-04 mensagem humana enviada pelo celular (gravada pelo ingest) também pausa', async () => {
    const o = await newOwner(env)
    const agentId = await newAgent(o, { settings: { pause_on_human: true } })
    const chat = await newChat(env, o, agentId)
    const r = rig(env, [env.ai.text('Olá!'), env.ai.text('não deveria sair')])
    await r.runtime.onInbound(await inbound(env, o, chat, 'oi'))
    await r.runtime.flush(chat.id)
    await r.runtime.idle()
    await env.q(
      `INSERT INTO crm.messages (company_id, chat_id, direction, sender_type, type, body, status, wa_message_id, created_at)
       VALUES ($1, $2, 'outbound', 'user', 'text', 'respondi pelo celular', 'sent', $3, now() + interval '1 second')`,
      [o.companyId, chat.id, `WAPHONE-${randomBytes(4).toString('hex')}`],
    )
    await r.runtime.onInbound(await inbound(env, o, chat, 'ok'))
    await r.runtime.flush(chat.id)
    await r.runtime.idle()
    expect(r.llm.calls).toHaveLength(1)
    expect((await state(env, chat.id))?.paused_reason).toBe('human')
  })
})

describe('T68 — saldo esgotado', () => {
  async function exhausted(action: 'none' | 'flow' | 'notify', extra: Record<string, unknown> = {}) {
    const o = await newOwner(env)
    await env.q(
      `INSERT INTO crm.llm_prices (provider, model, kind, effective_from, input_per_mtok_micros, output_per_mtok_micros) VALUES ($1, $2, 'llm', '2020-01-01T00:00:00Z', 1000000, 2000000)
       ON CONFLICT DO NOTHING`,
      [MODEL.provider, MODEL.model],
    )
    const agentId = await newAgent(o, { settings: { no_balance_action: action, ...extra } })
    const chat = await newChat(env, o, agentId)
    // carteira nova (saldo 0, overrun 0) → qualquer estimativa > 0 é barrada
    const guard = new env.core.UsageGuard({ db: env.db, redis: env.redis })
    const r = rig(env, [env.ai.text('não deveria ser chamado')], { guard })
    await r.runtime.onInbound(await inbound(env, o, chat, 'oi, tudo bem?'))
    await r.runtime.flush(chat.id)
    await r.runtime.idle()
    return { o, chat, r }
  }

  it("AC-T68-05 cota esgotada → nenhuma chamada ao LLM e o agente sai do chat (no_balance_action 'none')", async () => {
    const { chat, r } = await exhausted('none')
    expect(r.llm.calls).toHaveLength(0)
    expect((await chatRow(env, chat.id)).ai_agent_id).toBeNull()
    expect((await state(env, chat.id))?.paused_reason).toBe('no_balance')
    expect(sentTo(env, chat.phone)).toHaveLength(0)
  })

  it("AC-T68-05 cota esgotada com no_balance_action 'flow' dispara o fluxo configurado", async () => {
    const owner = await newOwner(env)
    const [flow] = await env.q(`INSERT INTO crm.flows (company_id, name) VALUES ($1, 'Sem saldo') RETURNING id`, [owner.companyId])
    // o fluxo precisa ser da mesma empresa do agente: reaproveita o owner criando o cenário manualmente
    await env.q(
      `INSERT INTO crm.llm_prices (provider, model, kind, effective_from, input_per_mtok_micros, output_per_mtok_micros) VALUES ($1, $2, 'llm', '2020-01-01T00:00:00Z', 1000000, 2000000)
       ON CONFLICT DO NOTHING`,
      [MODEL.provider, MODEL.model],
    )
    const agentId = await newAgent(owner, { settings: { no_balance_action: 'flow', no_balance_flow_id: flow.id } })
    const chat = await newChat(env, owner, agentId)
    const r = rig(env, [env.ai.text('não deveria ser chamado')], { guard: new env.core.UsageGuard({ db: env.db, redis: env.redis }) })
    await r.runtime.onInbound(await inbound(env, owner, chat, 'oi'))
    await r.runtime.flush(chat.id)
    await r.runtime.idle()
    expect(r.llm.calls).toHaveLength(0)
    expect(r.flowRuns).toHaveLength(1)
    expect(r.flowRuns[0].args).toMatchObject({ flowId: flow.id, chatId: chat.id, contactId: chat.contactId })
    expect((await chatRow(env, chat.id)).ai_agent_id).toBeNull()
  })

  it("AC-T68-05 cota esgotada com no_balance_action 'notify' avisa o número configurado pelo gateway", async () => {
    const { chat, r } = await exhausted('notify', {
      no_balance_notify_name: 'Gestor',
      no_balance_notify_country_code: '55',
      no_balance_notify_phone: '11988887777',
      no_balance_notify_message: 'Agente sem saldo de IA',
    })
    expect(r.llm.calls).toHaveLength(0)
    const notes = env.gateway.sent.filter((s: any) => String(s.phone).replace(/\D/g, '') === '5511988887777')
    expect(notes.length, JSON.stringify(env.gateway.sent.slice(-3))).toBeGreaterThanOrEqual(1)
    expect(JSON.stringify(notes.at(-1).content)).toContain('Agente sem saldo de IA')
    expect(sentTo(env, chat.phone)).toHaveLength(0)
    expect((await chatRow(env, chat.id)).ai_agent_id).toBeNull()
  })
})

describe('T68 — envio e providerData', () => {
  it("AC-T68-06 todo envio do agente passa pelo WaGateway.send com sender_type 'ai'", async () => {
    const o = await newOwner(env)
    const agentId = await newAgent(o, { settings: { split_messages: true } })
    const chat = await newChat(env, o, agentId)
    const r = rig(env, [env.ai.text('Olá! Tudo bem?\n\nTemos turmas à noite e aos sábados.\n\nQual prefere?')])
    const before = sentTo(env, chat.phone).length
    await r.runtime.onInbound(await inbound(env, o, chat, 'oi'))
    await r.runtime.flush(chat.id)
    await r.runtime.idle()
    const sends = sentTo(env, chat.phone).slice(before)
    expect(sends.length).toBeGreaterThanOrEqual(1)
    for (const s of sends) expect(s.actor).toBe(`crm:ai:${agentId}`)
    const outs = await env.q(`SELECT sender_type, sender_user_id FROM crm.messages WHERE chat_id = $1 AND direction = 'outbound'`, [chat.id])
    expect(outs.length).toBe(sends.length)
    for (const m of outs) {
      expect(m.sender_type).toBe('ai')
      expect(m.sender_user_id).toBeNull()
    }
  })

  it('AC-T68-06 o providerData do turno anterior é reenviado, idêntico, no turno seguinte', async () => {
    const o = await newOwner(env)
    const agentId = await newAgent(o)
    const chat = await newChat(env, o, agentId)
    const pd = { thoughtSignature: 'sig-t68-turno-1', nested: { items: [1, 2, 3] } }
    const r = rig(env, [env.ai.text('Olá! Em que posso ajudar?', { providerData: pd }), env.ai.text('Perfeito.')])
    await r.runtime.onInbound(await inbound(env, o, chat, 'oi'))
    await r.runtime.flush(chat.id)
    await r.runtime.idle()
    await r.runtime.onInbound(await inbound(env, o, chat, 'quero me matricular'))
    await r.runtime.flush(chat.id)
    await r.runtime.idle()
    expect(r.llm.calls).toHaveLength(2)
    const assistants = r.llm.calls[1].messages.filter((m: any) => m.role === 'assistant')
    // igualdade profunda: a ordem das chaves de um objeto JSON não tem significado (jsonb as ordena)
    expect(assistants.map((m: any) => m.providerData)).toContainEqual(pd)
    // o turno 1 não tinha histórico de assistant
    expect(r.llm.calls[0].messages.filter((m: any) => m.role === 'assistant')).toHaveLength(0)
  })

  it('AC-T68-06 o providerData sobrevive a um runtime novo (estado persistido no banco)', async () => {
    const o = await newOwner(env)
    const agentId = await newAgent(o)
    const chat = await newChat(env, o, agentId)
    const pd = { reasoning: 'cifrado-t68' }
    const r1 = rig(env, [env.ai.text('Oi!', { providerData: pd })])
    await r1.runtime.onInbound(await inbound(env, o, chat, 'oi'))
    await r1.runtime.flush(chat.id)
    await r1.runtime.idle()
    const r2 = rig(env, [env.ai.text('Certo.')])
    await r2.runtime.onInbound(await inbound(env, o, chat, 'e aí?'))
    await r2.runtime.flush(chat.id)
    await r2.runtime.idle()
    const assistants = r2.llm.calls[0].messages.filter((m: any) => m.role === 'assistant')
    expect(assistants.map((m: any) => m.providerData)).toContainEqual(pd)
  })
})
