// AC-T33-01..07 — ingest de WaEvents em contatos, chats e mensagens (porta ChatIngest e worker ponta a ponta).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type Env,
  historyEvent,
  inboundEvent,
  lidJid,
  lidMappingEvent,
  phone,
  rand,
  startChatsWorker,
  startEnv,
  statusEvent,
  tenant,
  type Tenant,
  waitFor,
} from './setup'

let env: Env

beforeAll(async () => {
  env = await startEnv()
})
afterAll(async () => {
  await env?.close()
})

const msgs = (t: Tenant, waId: string) => env.q(`SELECT * FROM crm.messages WHERE company_id = $1 AND wa_message_id = $2`, [t.companyId, waId])
const contactsByPhone = (t: Tenant, e164: string) => env.q(`SELECT * FROM crm.contacts WHERE company_id = $1 AND phone_e164 = $2`, [t.companyId, e164])
const chatsOf = (t: Tenant, contactId: string) => env.q(`SELECT * FROM crm.chats WHERE company_id = $1 AND contact_id = $2`, [t.companyId, contactId])
const chatById = async (id: string) => (await env.q(`SELECT * FROM crm.chats WHERE id = $1`, [id]))[0]

/** Recebe uma primeira mensagem e devolve contato, chat e evento. */
async function firstMessage(t: Tenant, extra: Record<string, unknown> = {}) {
  const p = phone()
  const ev = inboundEvent(t.sessionId, { from: p.jid, push_name: 'Maria', ...extra })
  await t.handle(ev)
  const [contact] = await contactsByPhone(t, p.e164)
  expect(contact, 'contato não criado').toBeDefined()
  const [chat] = await chatsOf(t, contact.id)
  expect(chat, 'chat não criado').toBeDefined()
  return { p, ev, contact, chat }
}

describe('T33 — idempotência', () => {
  it('AC-T33-01 o mesmo message.inbound entregue duas vezes gera uma única mensagem e um único incremento de não lidas (porta)', async () => {
    const t = await tenant(env)
    const { ev, chat } = await firstMessage(t)
    await t.handle(ev)
    await t.handle(structuredClone(ev))
    expect(await msgs(t, ev.message.id)).toHaveLength(1)
    expect((await chatById(chat.id)).unread_count).toBe(1)
    expect(t.types('message.created')).toHaveLength(1)
    expect(t.inbound).toHaveLength(1)
  })

  it('AC-T33-01 duplicado pelo stream wsm:events (worker) também gera uma única mensagem', async () => {
    const t = await tenant(env)
    const w = await startChatsWorker(env, t)
    try {
      const p = phone()
      const ev = inboundEvent(t.sessionId, { from: p.jid })
      await w.xadd(ev)
      await w.xadd(ev)
      await waitFor(async () => (await msgs(t, ev.message.id)).length > 0, 15_000, 'mensagem gravada pelo worker')
      // dá tempo para a segunda entrega ser processada
      const second = inboundEvent(t.sessionId, { from: p.jid })
      await w.xadd(second)
      await waitFor(async () => (await msgs(t, second.message.id)).length > 0, 15_000, 'mensagem seguinte')
      expect(await msgs(t, ev.message.id)).toHaveLength(1)
      const [contact] = await contactsByPhone(t, p.e164)
      const [chat] = await chatsOf(t, contact.id)
      expect(chat.unread_count).toBe(2)
    } finally {
      await w.stop()
    }
  })
})

describe('T33 — primeira mensagem', () => {
  it("AC-T33-02 número desconhecido cria contato (consentimento inbound no gateway), chat waiting e publica chat.created e message.created", async () => {
    const t = await tenant(env)
    const { p, ev, contact, chat } = await firstMessage(t)

    expect(contact.consent_source).toBe('inbound')
    expect(t.gateway.consents).toEqual(expect.arrayContaining([expect.objectContaining({ phone: p.e164, source: 'inbound' })]))
    expect(chat.status).toBe('waiting')
    expect(chat.connection_id).toBe(t.connectionId)
    expect(chat.unread_count).toBe(1)

    const [m] = await msgs(t, ev.message.id)
    expect(m.direction).toBe('inbound')
    expect(m.sender_type).toBe('contact')
    expect(m.body).toBe('olá')
    expect(m.chat_id).toBe(chat.id)

    const created = t.types('chat.created')
    expect(created).toHaveLength(1)
    expect(created[0]!.companyId).toBe(t.companyId)
    expect(t.types('message.created')).toHaveLength(1)
    expect(t.inbound).toEqual([expect.objectContaining({ company_id: t.companyId, chat_id: chat.id, contact_id: contact.id, wa_message_id: ev.message.id })])
  })

  it('AC-T33-02 a segunda mensagem do mesmo número usa o mesmo contato e chat (sem novo chat.created)', async () => {
    const t = await tenant(env)
    const { p, contact, chat } = await firstMessage(t)
    await t.handle(inboundEvent(t.sessionId, { from: p.jid, text: 'segunda' }))
    expect(await contactsByPhone(t, p.e164)).toHaveLength(1)
    expect(await chatsOf(t, contact.id)).toHaveLength(1)
    expect((await chatById(chat.id)).unread_count).toBe(2)
    expect(t.types('chat.created')).toHaveLength(1)
    expect(t.types('message.created')).toHaveLength(2)
  })

  it('AC-T33-02 sessão desconhecida é ignorada sem erro', async () => {
    const t = await tenant(env)
    const p = phone()
    await expect(t.handle(inboundEvent(`sess-desconhecida-${rand()}`, { from: p.jid }))).resolves.not.toThrow()
    expect(await contactsByPhone(t, p.e164)).toHaveLength(0)
    expect(t.published).toHaveLength(0)
  })
})

describe('T33 — reabertura e histórico', () => {
  it('AC-T33-03 mensagem nova num chat resolved reabre para waiting', async () => {
    const t = await tenant(env)
    const { p, chat } = await firstMessage(t)
    await env.q(`UPDATE crm.chats SET status = 'resolved', unread_count = 0, resolved_at = now() WHERE id = $1`, [chat.id])
    await t.handle(inboundEvent(t.sessionId, { from: p.jid, text: 'voltei' }))
    const after = await chatById(chat.id)
    expect(after.status).toBe('waiting')
    expect(after.unread_count).toBe(1)
    expect(t.types('chat.updated').length).toBeGreaterThan(0)
  })

  it('AC-T33-03 message.inbound com historical: true é gravada sem alterar status, não lidas nem disparar crm.inbound', async () => {
    const t = await tenant(env)
    const { p, chat } = await firstMessage(t)
    await env.q(`UPDATE crm.chats SET status = 'resolved', unread_count = 0 WHERE id = $1`, [chat.id])
    const inboundBefore = t.inbound.length
    const ev = inboundEvent(t.sessionId, { from: p.jid, text: 'antiga', historical: true, timestamp: Date.now() - 86_400_000 })
    await t.handle(ev)
    expect(await msgs(t, ev.message.id)).toHaveLength(1)
    const after = await chatById(chat.id)
    expect(after.status).toBe('resolved')
    expect(after.unread_count).toBe(0)
    expect(t.inbound.length).toBe(inboundBefore)
  })

  it('AC-T33-03 history.batch grava as mensagens como históricas sem alterar status, não lidas nem disparar crm.inbound (porta)', async () => {
    const t = await tenant(env)
    const { p, chat } = await firstMessage(t)
    await env.q(`UPDATE crm.chats SET status = 'resolved', unread_count = 0 WHERE id = $1`, [chat.id])
    const inboundBefore = t.inbound.length
    const ev = historyEvent(t.sessionId, [{ from: p.jid }, { from: p.jid, text: 'outra antiga' }])
    await t.handle(ev)
    for (const m of ev.messages) expect(await msgs(t, m.id as string), String(m.id)).toHaveLength(1)
    const after = await chatById(chat.id)
    expect(after.status).toBe('resolved')
    expect(after.unread_count).toBe(0)
    expect(t.inbound.length).toBe(inboundBefore)
  })

  it('AC-T33-03 history.batch pelo stream (worker) também não altera status nem não lidas', async () => {
    const t = await tenant(env)
    const { p, chat } = await firstMessage(t)
    await env.q(`UPDATE crm.chats SET status = 'resolved', unread_count = 0 WHERE id = $1`, [chat.id])
    const inboundBefore = t.inbound.length
    const w = await startChatsWorker(env, t)
    try {
      const ev = historyEvent(t.sessionId, [{ from: p.jid }])
      await w.xadd(ev)
      await waitFor(async () => (await msgs(t, ev.messages[0]!.id as string)).length > 0, 15_000, 'histórico gravado pelo worker')
      const after = await chatById(chat.id)
      expect(after.status).toBe('resolved')
      expect(after.unread_count).toBe(0)
      expect(t.inbound.length).toBe(inboundBefore)
    } finally {
      await w.stop()
    }
  })
})

describe('T33 — status e identidade', () => {
  async function outbound(t: Tenant, chat: any) {
    const pipelineId = `pipe-${rand()}`
    const waId = `WAOUT-${rand()}`
    await env.q(
      `INSERT INTO crm.messages (company_id, chat_id, direction, sender_type, type, body, status, pipeline_message_id, wa_message_id)
       VALUES ($1, $2, 'outbound', 'user', 'text', 'resposta', 'sent', $3, $4)`,
      [t.companyId, chat.id, pipelineId, waId],
    )
    const st = async () => (await env.q(`SELECT status FROM crm.messages WHERE pipeline_message_id = $1`, [pipelineId]))[0].status
    return { pipelineId, waId, st }
  }

  it('AC-T33-04 message.status nunca regride (read não volta a delivered)', async () => {
    const t = await tenant(env)
    const { chat } = await firstMessage(t)
    const o = await outbound(t, chat)
    await t.handle(statusEvent(t.sessionId, o.pipelineId, 'delivered', o.waId))
    expect(await o.st()).toBe('delivered')
    await t.handle(statusEvent(t.sessionId, o.pipelineId, 'read', o.waId))
    expect(await o.st()).toBe('read')
    for (const s of ['delivered', 'sent', 'queued', 'processing', 'failed']) {
      await t.handle(statusEvent(t.sessionId, o.pipelineId, s, o.waId))
      expect(await o.st(), `regrediu com ${s}`).toBe('read')
    }
    expect(t.types('message.status').length).toBeGreaterThan(0)
  })

  it('AC-T33-04 message.status casa por transport_message_id quando o id do pipeline não bate', async () => {
    const t = await tenant(env)
    const { chat } = await firstMessage(t)
    const o = await outbound(t, chat)
    await t.handle(statusEvent(t.sessionId, `outro-${rand()}`, 'delivered', o.waId))
    expect(await o.st()).toBe('delivered')
  })

  it('AC-T33-04 contact.lid_mapping funde contato e chats sem duplicar', async () => {
    const t = await tenant(env)
    const p = phone()
    const lid = lidJid()
    // chega primeiro pelo LID (sem PN), depois pelo PN: dois contatos e dois chats
    await t.handle(inboundEvent(t.sessionId, { from: lid, text: 'pelo lid' }))
    await t.handle(inboundEvent(t.sessionId, { from: p.jid, text: 'pelo pn' }))
    const before = await env.q(`SELECT id FROM crm.contacts WHERE company_id = $1 AND (phone_e164 = $2 OR wa_lid = $3)`, [t.companyId, p.e164, lid])
    expect(before.length).toBeGreaterThanOrEqual(1)

    await t.handle(lidMappingEvent(t.sessionId, lid, p.e164))
    await t.handle(lidMappingEvent(t.sessionId, lid, p.e164)) // idempotente

    const after = await env.q(`SELECT * FROM crm.contacts WHERE company_id = $1 AND (phone_e164 = $2 OR wa_lid = $3)`, [t.companyId, p.e164, lid])
    expect(after).toHaveLength(1)
    expect(after[0].phone_e164).toBe(p.e164)
    expect(after[0].wa_lid).toBe(lid)
    const chats = await chatsOf(t, after[0].id)
    expect(chats).toHaveLength(1)
    const allMsgs = await env.q(`SELECT body FROM crm.messages WHERE chat_id = $1 ORDER BY created_at`, [chats[0].id])
    expect(allMsgs.map((m: any) => m.body)).toEqual(expect.arrayContaining(['pelo lid', 'pelo pn']))
    const orphanChats = await env.q(
      `SELECT count(*)::int AS n FROM crm.chats c WHERE c.company_id = $1 AND NOT EXISTS (SELECT 1 FROM crm.contacts k WHERE k.id = c.contact_id)`,
      [t.companyId],
    )
    expect(orphanChats[0].n).toBe(0)

    // mensagem nova por qualquer identidade cai no mesmo chat
    await t.handle(inboundEvent(t.sessionId, { from: lid, alt_jid: p.jid, text: 'depois' }))
    expect(await chatsOf(t, after[0].id)).toHaveLength(1)
  })
})

describe('T33 — grupos e status', () => {
  it('AC-T33-05 mensagens de grupo (@g.us) e de status (status@broadcast) são ignoradas', async () => {
    const t = await tenant(env)
    const p = phone()
    const evs = [
      inboundEvent(t.sessionId, { from: `120363${rand(6)}@g.us`, participant: p.jid, text: 'no grupo' }),
      inboundEvent(t.sessionId, { from: 'status@broadcast', participant: p.jid, text: 'status' }),
    ]
    for (const ev of evs) await t.handle(ev)
    for (const ev of evs) expect(await msgs(t, ev.message.id)).toHaveLength(0)
    expect(await env.q(`SELECT id FROM crm.chats WHERE company_id = $1`, [t.companyId])).toHaveLength(0)
    expect(await contactsByPhone(t, p.e164)).toHaveLength(0)
    expect(t.published).toHaveLength(0)
    expect(t.inbound).toHaveLength(0)
    expect(t.gateway.consents).toHaveLength(0)
  })
})

describe('T33 — atribuição de anúncio', () => {
  it('AC-T33-06 o ad da primeira mensagem preenche a atribuição do contato; as seguintes não sobrescrevem', async () => {
    const t = await tenant(env)
    const ad1 = { ctwa_clid: `clid-${rand()}`, source_id: '120210000000000001', source_url: 'https://fb.me/primeiro', media_url: 'https://cdn.test/primeiro.jpg' }
    const { p, contact } = await firstMessage(t, { ad: ad1 })
    expect(contact).toMatchObject({ ctwa_clid: ad1.ctwa_clid, source_id: ad1.source_id, source_url: ad1.source_url, ad_media_url: ad1.media_url })

    const ad2 = { ctwa_clid: `clid-${rand()}`, source_id: '999', source_url: 'https://fb.me/segundo', media_url: 'https://cdn.test/segundo.jpg' }
    await t.handle(inboundEvent(t.sessionId, { from: p.jid, ad: ad2 }))
    await t.handle(inboundEvent(t.sessionId, { from: p.jid }))
    const [again] = await contactsByPhone(t, p.e164)
    expect(again).toMatchObject({ ctwa_clid: ad1.ctwa_clid, source_id: ad1.source_id, source_url: ad1.source_url, ad_media_url: ad1.media_url })
  })

  it('AC-T33-06 primeira mensagem sem ad não preenche atribuição', async () => {
    const t = await tenant(env)
    const { contact } = await firstMessage(t)
    expect(contact.ctwa_clid ?? null).toBeNull()
    expect(contact.source_id ?? null).toBeNull()
  })
})

describe('T33 — opt-out por palavra-chave', () => {
  const contactById = async (id: string) => (await env.q(`SELECT * FROM crm.contacts WHERE id = $1`, [id]))[0]

  it('AC-T33-07 palavras padrão (SAIR, PARAR, STOP, CANCELAR) normalizadas marcam opt_out, chamam optOut e gravam auditoria', async () => {
    const t = await tenant(env)
    for (const text of ['SAIR', ' parar! ', 'Stop', 'cancelar.']) {
      const { p, contact } = await firstMessage(t, { text })
      const after = await contactById(contact.id)
      expect(after.opt_out, text).toBe(true)
      expect(t.gateway.optOuts, text).toEqual(expect.arrayContaining([expect.objectContaining({ phone: p.e164 })]))
      expect(t.gateway.isOptedOut(p.e164), text).toBe(true)
      const audit = await env.q(`SELECT * FROM crm.audit_logs WHERE company_id = $1 AND target_id = $2 AND action = 'contacts.opt_out'`, [t.companyId, contact.id])
      expect(audit, `auditoria de ${text}`).toHaveLength(1)
      expect(JSON.stringify(audit[0].detail)).toContain('inbound_keyword')
    }
  })

  it('AC-T33-07 texto que só contém a palavra no meio não marca opt_out', async () => {
    const t = await tenant(env)
    const { contact, p } = await firstMessage(t, { text: 'não quero parar de receber' })
    expect((await contactById(contact.id)).opt_out).toBe(false)
    expect(t.gateway.isOptedOut(p.e164)).toBe(false)
  })

  it('AC-T33-07 a lista é configurável por empresa', async () => {
    const t = await tenant(env, { opt_out_keywords: ['DESCADASTRAR'] })
    const custom = await firstMessage(t, { text: 'descadastrar' })
    expect((await contactById(custom.contact.id)).opt_out).toBe(true)
    const std = await firstMessage(t, { text: 'SAIR' })
    expect((await contactById(std.contact.id)).opt_out).toBe(false)
  })

  it('AC-T33-07 nova mensagem não reverte o opt-out (só ação manual com novo consentimento)', async () => {
    const t = await tenant(env)
    const { p, contact } = await firstMessage(t, { text: 'SAIR' })
    await t.handle(inboundEvent(t.sessionId, { from: p.jid, text: 'oi, voltei' }))
    expect((await contactById(contact.id)).opt_out).toBe(true)
    expect(t.gateway.isOptedOut(p.e164)).toBe(true)
  })
})
