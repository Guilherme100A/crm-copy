// Assistente de fluxo (T93) contra Postgres/Redis reais, UsageGuard real e FakeLlm (nunca LLM real):
// sessões, turno com deltas, edições validadas, graph_updated com source 'ai', paused_quota/resume e leitura sem flows.edit.
import { randomBytes } from 'node:crypto'
import { aiUsage, aiWallets, companies, createDb, ensureDefaultAiPrices, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { redisConnection } from '@crm/node-kit'
import { FakeLlm, fail, text, toolCall, toolCalls } from '@crm/ai/testing'
import { LlmUpstreamError } from '@crm/ai'
import { and, eq } from 'drizzle-orm'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { UsageGuard } from '../ai-metering/guard'
import { FlowStore } from '../flows/store'
import { FlowCopilotError, FlowCopilotService, type CopilotPublisher } from './service'

let tmp: TempDatabase
let db: Database
let redis: Redis
const rnd = () => randomBytes(4).toString('hex')

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true })
  db = createDb(tmp.url, { max: 4 })
  await ensureDefaultAiPrices(db)
  redis = redisConnection()
}, 120_000)

afterAll(async () => {
  await db?.$client.end()
  await redis?.quit()
  await tmp?.drop()
})

interface Published {
  companyId: string
  type: string
  data: Record<string, unknown>
  opts?: { userId?: string }
}

async function setup(balance = 1_000_000) {
  const tag = rnd()
  const [c] = await db
    .insert(companies)
    .values({ name: `F${tag}`, slug: `f-t93-${tag}` })
    .returning()
  const [u] = await db
    .insert(users)
    .values({ email: `u-${tag}@t93.test`, passwordHash: 'x', name: 'U' })
    .returning()
  if (balance) await db.insert(aiWallets).values({ companyId: c!.id, balanceCredits: balance, status: 'ok' })
  const ctx = { companyId: c!.id, userId: u!.id }
  const store = new FlowStore(db)
  const flow = await store.createFlow(ctx, { name: 'Boas-vindas' })
  const events: Published[] = []
  const publisher: CopilotPublisher = {
    publish: async (companyId, type, data, opts) => {
      events.push({ companyId, type, data, opts })
      return '1-0'
    },
  }
  let llm = new FakeLlm()
  const service = new FlowCopilotService({ db, llm: () => llm, guard: new UsageGuard({ db, redis }), publisher })
  return {
    ctx,
    store,
    flow,
    events,
    service,
    setLlm: (next: FakeLlm) => {
      llm = next
    },
    def: () => store.toDefinition(ctx, flow.id),
  }
}

describe('FlowCopilotService — sessões (AC-T93-01)', () => {
  it('cria, lista por fluxo, arquiva e reabre; outra empresa/usuário → not_found', async () => {
    const t = await setup()
    const s = await t.service.createSession(t.ctx, { flow_id: t.flow.id })
    expect(s).toMatchObject({ flow_id: t.flow.id, status: 'active', title: '' })
    expect((await t.service.listSessions(t.ctx, { flow_id: t.flow.id })).map((x) => x.id)).toEqual([s.id])

    const archived = await t.service.archive(t.ctx, s.id)
    expect(archived.status).toBe('archived')
    expect(await t.service.listSessions(t.ctx, { flow_id: t.flow.id })).toEqual([])
    expect(
      (await t.service.listSessions(t.ctx, { flow_id: t.flow.id, include_archived: true })).map((x) => x.id),
    ).toEqual([s.id])
    await expect(t.service.runTurn(t.ctx, s.id, { content: 'oi' }, { canEdit: true })).rejects.toMatchObject({
      code: 'invalid_state',
    })
    expect((await t.service.reopen(t.ctx, s.id)).status).toBe('active')

    const other = await setup()
    await expect(other.service.getSession(other.ctx, s.id)).rejects.toMatchObject({ code: 'not_found' })
    await expect(other.service.createSession(other.ctx, { flow_id: t.flow.id })).rejects.toMatchObject({
      code: 'not_found',
    })
    await expect(t.service.createSession(t.ctx, { flow_id: 'nope' })).rejects.toMatchObject({ code: 'validation' })
  })

  it('turno: grava as mensagens, emite copilot.delta (tool e texto) e copilot.completed para o dono, mede o uso', async () => {
    const t = await setup()
    const s = await t.service.createSession(t.ctx, { flow_id: t.flow.id })
    const reply = 'Seu fluxo tem só o Início. Posso criar uma mensagem de boas-vindas logo depois dele, se quiser.'
    t.setLlm(new FakeLlm([toolCall('get_flow', {}), text(reply)]))
    const out = await t.service.runTurn(
      t.ctx,
      s.id,
      { content: 'O que tem no fluxo?', client_message_id: 'c1' },
      { canEdit: true },
    )

    expect(out.reply).toMatchObject({ role: 'assistant', status: 'completed', content: reply })
    expect(out.reply!.tool_calls.map((c) => [c.name, c.ok])).toEqual([['get_flow', true]])
    expect(out.reply!.credits).toBeGreaterThan(0)
    expect(out.session.title).toBe('O que tem no fluxo?')
    expect(out.graph_changed).toBe(false)

    const deltas = t.events.filter((e) => e.type === 'copilot.delta')
    expect(deltas[0]!.data).toMatchObject({
      kind: 'tool',
      tool: 'get_flow',
      ok: true,
      session_id: s.id,
      message_id: out.reply!.id,
    })
    expect(
      deltas
        .filter((d) => d.data.kind === 'text')
        .map((d) => d.data.delta)
        .join(''),
    ).toBe(reply)
    const done = t.events.find((e) => e.type === 'copilot.completed')!
    expect(done.data).toMatchObject({ status: 'completed', message_id: out.reply!.id, graph_changed: false })
    expect(t.events.filter((e) => e.type.startsWith('copilot.')).every((e) => e.opts?.userId === t.ctx.userId)).toBe(
      true,
    )

    const msgs = await t.service.listMessages(t.ctx, s.id)
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
    const usage = await db
      .select()
      .from(aiUsage)
      .where(and(eq(aiUsage.companyId, t.ctx.companyId), eq(aiUsage.feature, 'flow_copilot')))
    expect(usage).toHaveLength(1)

    // mesmo client_message_id: devolve o turno já feito, sem chamar o LLM de novo
    const again = await t.service.runTurn(
      t.ctx,
      s.id,
      { content: 'O que tem no fluxo?', client_message_id: 'c1' },
      { canEdit: true },
    )
    expect(again.reply!.id).toBe(out.reply!.id)
    expect(await t.service.listMessages(t.ctx, s.id)).toHaveLength(2)
  })

  it('o LLM é lido a cada turno e o histórico vai junto', async () => {
    const t = await setup()
    const s = await t.service.createSession(t.ctx, { flow_id: t.flow.id })
    const first = new FakeLlm([text('Primeira')])
    t.setLlm(first)
    await t.service.runTurn(t.ctx, s.id, { content: 'um' }, { canEdit: true })
    const second = new FakeLlm([text('Segunda')])
    t.setLlm(second)
    const out = await t.service.runTurn(t.ctx, s.id, { content: 'dois' }, { canEdit: true })
    expect(out.reply!.content).toBe('Segunda')
    expect(first.callCount).toBe(1)
    expect(second.calls[0]!.messages.map((m) => (m as { role: string }).role)).toEqual(['user', 'assistant', 'user'])
  })

  it('falha do provedor: resposta failed e copilot.completed failed, sessão segue ativa', async () => {
    const t = await setup()
    const s = await t.service.createSession(t.ctx, { flow_id: t.flow.id })
    t.setLlm(new FakeLlm([fail(new LlmUpstreamError('caiu'))]))
    const out = await t.service.runTurn(t.ctx, s.id, { content: 'oi' }, { canEdit: true })
    expect(out.reply).toMatchObject({ status: 'failed', content: '' })
    expect(out.session.status).toBe('active')
    expect(t.events.find((e) => e.type === 'copilot.completed')!.data.status).toBe('failed')
  })
})

describe('FlowCopilotService — edições (AC-T93-02, AC-T93-03)', () => {
  it('AC-T93-02/03: cria nó, edita ação, liga handle e remove nó; cada edição grava e publica flow.graph_updated source ai', async () => {
    const t = await setup()
    const s = await t.service.createSession(t.ctx, { flow_id: t.flow.id })
    const start = (await t.def()).entry
    t.setLlm(
      new FakeLlm([
        toolCall('create_node', {
          type: 'message',
          name: 'Oi',
          actions: [{ type: 'send_message', config: { message_text: 'Olá!' } }],
          connect_from: { node_id: start, handle: 'source' },
        }),
        text('Criei.'),
      ]),
    )
    const out = await t.service.runTurn(t.ctx, s.id, { content: 'crie uma mensagem' }, { canEdit: true })
    expect(out.graph_changed).toBe(true)
    const created = out.reply!.tool_calls[0]!.output as { node_id: string; action_ids: string[] }
    let def = await t.def()
    const node = def.nodes.find((n) => n.id === created.node_id)!
    expect(node.actions[0]!.config).toEqual({ message_text: 'Olá!' })
    expect(def.edges).toEqual([expect.objectContaining({ from: start, handle: 'source', to: node.id })])

    const graph = t.events.filter((e) => e.type === 'flow.graph_updated')
    expect(graph).toHaveLength(1)
    expect(graph[0]!.data).toEqual({
      flow_id: t.flow.id,
      actor_id: null,
      mutation: 'add_node',
      source: 'ai',
      session_id: s.id,
    })
    expect(graph[0]!.opts).toBeUndefined()

    t.setLlm(
      new FakeLlm([
        toolCalls([
          {
            name: 'update_action',
            input: { node_id: node.id, action_id: created.action_ids[0], config: { message_text: 'Bem-vindo!' } },
          },
          {
            name: 'create_node',
            input: { type: 'message', actions: [{ type: 'send_message', config: { message_text: 'Tchau' } }] },
          },
        ]),
        text('ok'),
      ]),
    )
    const out2 = await t.service.runTurn(t.ctx, s.id, { content: 'ajuste' }, { canEdit: true })
    const second = (out2.reply!.tool_calls[1]!.output as { node_id: string }).node_id
    t.setLlm(
      new FakeLlm([
        toolCall('connect', { from: node.id, handle: 'source', to: second }),
        toolCall('delete_node', { node_id: second }),
        text('feito'),
      ]),
    )
    await t.service.runTurn(t.ctx, s.id, { content: 'liga e remove' }, { canEdit: true })
    def = await t.def()
    expect(def.nodes.find((n) => n.id === node.id)!.actions[0]!.config).toEqual({ message_text: 'Bem-vindo!' })
    expect(def.nodes.some((n) => n.id === second)).toBe(false)
    expect(def.edges.some((e) => e.to === second || e.from === second)).toBe(false)
    expect(t.events.filter((e) => e.type === 'flow.graph_updated').map((e) => e.data.mutation)).toEqual([
      'add_node',
      'update_action',
      'add_node',
      'add_connection',
      'delete_node',
    ])
  })

  it('AC-T93-02: alteração inválida volta como erro para o modelo e não grava nem publica', async () => {
    const t = await setup()
    const s = await t.service.createSession(t.ctx, { flow_id: t.flow.id })
    const start = (await t.def()).entry
    const before = await t.def()
    const llm = new FakeLlm([
      toolCall('create_node', {
        type: 'message',
        actions: [{ type: 'send_message', config: { message_text: '' } }],
        connect_from: { node_id: start, handle: 'source' },
      }),
      toolCall('connect', { from: start, handle: 'success', to: start }),
      toolCall('delete_node', { node_id: start }),
      text('Não consegui.'),
    ])
    t.setLlm(llm)
    const out = await t.service.runTurn(t.ctx, s.id, { content: 'crie' }, { canEdit: true })
    expect(out.graph_changed).toBe(false)
    expect(out.reply!.tool_calls.map((c) => c.ok)).toEqual([false, false, false])
    expect(String(out.reply!.tool_calls[0]!.output)).toMatch(/invalid_action_config/)
    // o loop seguiu depois dos erros (cada um voltou ao modelo como resultado com erro) até o texto final
    expect(llm.remaining).toBe(0)
    expect(out.reply!.content).toBe('Não consegui.')
    expect(await t.def()).toEqual(before)
    expect(t.events.some((e) => e.type === 'flow.graph_updated')).toBe(false)
    expect(t.events.filter((e) => e.type === 'copilot.delta' && e.data.kind === 'tool').map((e) => e.data.ok)).toEqual([
      false,
      false,
      false,
    ])
  })

  it('AC-T93-02: erro que o rascunho já tinha não bloqueia uma edição válida', async () => {
    const t = await setup()
    const s = await t.service.createSession(t.ctx, { flow_id: t.flow.id })
    const def = await t.def()
    // rascunho já quebrado: mensagem com config inválida ligada ao Início
    await t.store.fromDefinition(t.ctx, t.flow.id, {
      ...def,
      nodes: [
        ...def.nodes,
        {
          id: 'm1',
          type: 'message',
          name: 'M',
          position: { x: 1, y: 1 },
          actions: [{ id: 'a1', type: 'send_message', order: 0, config: {} }],
        },
      ],
      edges: [{ id: 'e1', from: def.entry, handle: 'source', to: 'm1' }],
    })
    t.setLlm(
      new FakeLlm([
        toolCall('create_node', {
          type: 'message',
          actions: [{ type: 'send_message', config: { message_text: 'ok' } }],
          connect_from: { node_id: 'm1', handle: 'source' },
        }),
        text('ok'),
      ]),
    )
    const out = await t.service.runTurn(t.ctx, s.id, { content: 'x' }, { canEdit: true })
    expect(out.reply!.tool_calls[0]!.ok).toBe(true)
    expect((await t.def()).nodes).toHaveLength(3)
  })
})

describe('FlowCopilotService — cota (AC-T93-04)', () => {
  it('AC-T93-04: sem saldo o turno pausa a sessão (paused_quota); resume só com saldo', async () => {
    const t = await setup(0)
    const s = await t.service.createSession(t.ctx, { flow_id: t.flow.id })
    const llm = new FakeLlm([text('nunca')])
    t.setLlm(llm)
    const err = await t.service.runTurn(t.ctx, s.id, { content: 'oi' }, { canEdit: true }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(FlowCopilotError)
    expect(err).toMatchObject({ code: 'paused_quota' })
    expect(llm.callCount).toBe(0)
    expect((await t.service.getSession(t.ctx, s.id)).status).toBe('paused_quota')
    expect(t.events.find((e) => e.type === 'copilot.completed')!.data.status).toBe('paused_quota')

    // pausada: nova mensagem é recusada e resume sem saldo também
    await expect(t.service.runTurn(t.ctx, s.id, { content: 'oi' }, { canEdit: true })).rejects.toMatchObject({
      code: 'paused_quota',
    })
    await expect(t.service.resume(t.ctx, s.id)).rejects.toMatchObject({ code: 'no_balance' })
    expect((await t.service.getSession(t.ctx, s.id)).status).toBe('paused_quota')

    // arquivar e reabrir preserva a pausa
    await t.service.archive(t.ctx, s.id)
    expect((await t.service.reopen(t.ctx, s.id)).status).toBe('paused_quota')

    await db.insert(aiWallets).values({ companyId: t.ctx.companyId, balanceCredits: 500, status: 'ok' })
    expect((await t.service.resume(t.ctx, s.id)).status).toBe('active')
    const out = await t.service.runTurn(t.ctx, s.id, { content: 'oi de novo' }, { canEdit: true })
    expect(out.reply!.content).toBe('nunca')
  })
})

describe('FlowCopilotService — permissão (AC-T93-05)', () => {
  it('AC-T93-05: sem flows.edit só as ferramentas de leitura vão ao modelo; pedido de escrita vira "ferramenta desconhecida"', async () => {
    const t = await setup()
    const s = await t.service.createSession(t.ctx, { flow_id: t.flow.id })
    const start = (await t.def()).entry
    const before = await t.def()
    const llm = new FakeLlm([
      toolCall('create_node', { type: 'message', connect_from: { node_id: start, handle: 'source' } }),
      text('Você não pode editar; veja como fazer…'),
    ])
    t.setLlm(llm)
    const out = await t.service.runTurn(t.ctx, s.id, { content: 'crie um nó' }, { canEdit: false })
    expect(llm.calls[0]!.tools!.map((x) => x.name)).toEqual(['get_flow', 'list_block_types'])
    expect(llm.calls[0]!.instructions).toMatch(/não tem permissão/)
    expect(out.reply!.status).toBe('completed')
    expect(out.graph_changed).toBe(false)
    expect(await t.def()).toEqual(before)
    expect(FlowCopilotService.toolNames(false)).toEqual(['get_flow', 'list_block_types'])
    expect(FlowCopilotService.toolNames(true)).toEqual(
      expect.arrayContaining(['create_node', 'update_action', 'connect', 'delete_node']),
    )
  })
})
