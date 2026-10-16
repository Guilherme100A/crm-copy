// AC-T41-01..04: condição, distribuidor, conexão de fluxo e intervalo inteligente.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { action, at, decide, def, edge, extraContact, marker, node, publishedFlow, runFlow, startEnv, world, type Env } from './support'

let env: Env
beforeAll(async () => {
  env = await startEnv()
})
afterAll(async () => {
  await env?.close()
})

const MON_10_SP = at('2026-10-19T13:00:00Z') // segunda 10:00 em America/Sao_Paulo
const sys = (systemSubtype: string, extra: Record<string, unknown>) => ({ category: 'system', systemSubtype, ...extra })
const one = (c: Record<string, unknown>) => ({ ruleType: 'all', conditions: [c] })

describe('AC-T41-01 condição', () => {
  it('AC-T41-01 etiqueta no contato ou no chat (sem diferença de caixa); equal/different', async () => {
    const w = await world(env, { contactLabels: ['VIP'], chatLabels: ['Quente'] })
    expect(await decide(env, w, one(sys('tag', { tagName: 'vip', operator: 'equal' })))).toBe('success')
    expect(await decide(env, w, one(sys('tag', { tagName: 'Quente' })))).toBe('success') // padrão equal; etiqueta do chat
    expect(await decide(env, w, one(sys('tag', { tagName: 'VIP', operator: 'different' })))).toBe('failure')
    expect(await decide(env, w, one(sys('tag', { tagName: 'Frio', operator: 'equal' })))).toBe('failure')
    expect(await decide(env, w, one(sys('tag', { tagName: 'Frio', operator: 'different' })))).toBe('success')
    const [l] = await env.q(`SELECT id FROM crm.labels WHERE company_id = $1 AND name = 'VIP'`, [w.companyId])
    expect(await decide(env, w, one(sys('tag', { tagId: l.id })))).toBe('success')
  })

  it('AC-T41-01 dia da semana, hora e data no fuso da empresa', async () => {
    const w = await world(env)
    const opts = { now: MON_10_SP }
    expect(await decide(env, w, one(sys('weekday', { weekday: 'monday' })), opts)).toBe('success')
    expect(await decide(env, w, one(sys('weekday', { weekday: 'monday', operator: 'different' })), opts)).toBe('failure')
    // 02:00Z de segunda = domingo 23:00 em São Paulo
    expect(await decide(env, w, one(sys('weekday', { weekday: 'sunday' })), { now: at('2026-10-19T02:00:00Z') })).toBe('success')
    expect(await decide(env, w, one(sys('time', { time: 11, operator: 'before' })), opts)).toBe('success')
    expect(await decide(env, w, one(sys('time', { time: 10, timeMinute: 0, operator: 'before' })), opts)).toBe('failure')
    expect(await decide(env, w, one(sys('time', { time: 9, timeMinute: 30, operator: 'after' })), opts)).toBe('success')
    expect(await decide(env, w, one(sys('time', { time: 10, timeMinute: 45, operator: 'during' })), opts)).toBe('success')
    expect(await decide(env, w, one(sys('time', { time: 13, operator: 'during' })), opts)).toBe('failure') // 13h é UTC, não local
    expect(await decide(env, w, one(sys('date', { date: '2026-10-19', operator: 'during' })), opts)).toBe('success')
    expect(await decide(env, w, one(sys('date', { date: '2026-10-20', operator: 'before' })), opts)).toBe('success')
    expect(await decide(env, w, one(sys('date', { date: '2026-10-20', operator: 'after' })), opts)).toBe('failure')
    // outro fuso: a mesma hora UTC é segunda 22:00 em Tóquio
    const tokyo = await world(env, { timeZone: 'Asia/Tokyo' })
    expect(await decide(env, tokyo, one(sys('time', { time: 22, operator: 'during' })), opts)).toBe('success')
    expect(await decide(env, tokyo, one(sys('time', { time: 11, operator: 'before' })), opts)).toBe('failure')
  })

  it('AC-T41-01 message_window é sempre verdadeiro; status de atendimento e atendente do chat do run', async () => {
    const w = await world(env, { chat: { status: 'attending', assigned: true } })
    expect(await decide(env, w, one(sys('message_window', { operator: 'open' })))).toBe('success')
    expect(await decide(env, w, one(sys('message_window', { operator: 'closed' })))).toBe('success')
    expect(await decide(env, w, one({ category: 'attendance', attendanceStatus: 'in_progress' }))).toBe('success')
    expect(await decide(env, w, one({ category: 'attendance', attendanceStatus: 'waiting' }))).toBe('failure')
    expect(await decide(env, w, one({ category: 'attendant', user_ids: [w.userId] }))).toBe('success')
    expect(await decide(env, w, one({ category: 'attendant', user_ids: ['00000000-0000-0000-0000-000000000000'] }))).toBe('failure')
    // sem chat: atendimento/atendente não atendem
    const noChat = await world(env, { chat: null })
    expect(await decide(env, noChat, one({ category: 'attendance', attendanceStatus: 'waiting' }))).toBe('failure')
    expect(await decide(env, noChat, one(sys('message_window', { operator: 'open' })))).toBe('success')
  })

  it('AC-T41-01 campo, campo personalizado e variável global, com operadores de texto e numéricos (vírgula decimal)', async () => {
    const w = await world(env, {
      contactName: 'Maria Souza',
      email: null,
      phone: '+5511987654321',
      customFields: { valor: '1.234,5', plano: 'Premium', nota: 'abc' },
      globals: { g_meta: '10,5' },
    })
    const f = (fieldName: string, operator: string, value?: unknown) => one({ category: 'field', fieldName, operator, value })
    expect(await decide(env, w, f('name', 'contains', 'MARIA'))).toBe('success')
    expect(await decide(env, w, f('name', 'starts_with', 'souza'))).toBe('failure')
    expect(await decide(env, w, f('phone', 'starts_with', '+5511'))).toBe('success')
    expect(await decide(env, w, f('email', 'has_value'))).toBe('failure')
    expect(await decide(env, w, f('name', 'equal', '  maria souza '))).toBe('success')
    expect(await decide(env, w, f('name', 'not_contains', 'joão'))).toBe('success')

    const cf = (fieldName: string, operator: string, value?: unknown) => one({ category: 'custom_field', fieldName, operator, value })
    expect(await decide(env, w, cf('valor', 'greater_than', '1000'))).toBe('success')
    expect(await decide(env, w, cf('valor', 'numeric_equal', '1234,5'))).toBe('success')
    expect(await decide(env, w, cf('valor', 'less_or_equal', '1234.4'))).toBe('failure')
    expect(await decide(env, w, cf('nota', 'less_than', '2,5'))).toBe('failure') // não numérico → falso
    expect(await decide(env, w, cf('plano', 'different', 'basico'))).toBe('success')

    const gv = (fieldName: string, operator: string, value?: unknown) => one({ category: 'global_variable', fieldName, operator, value })
    expect(await decide(env, w, gv('g_meta', 'greater_or_equal', '10.5'))).toBe('success')
    expect(await decide(env, w, gv('meta', 'less_than', '10,4'))).toBe('failure')
    expect(await decide(env, w, gv('g_meta', 'equal', '10,5'))).toBe('success')
    // valor com variável do contato
    expect(await decide(env, w, f('name', 'contains', '{first_name}'))).toBe('success')

    expect(env.core.parseNumber('1,5')).toBe(1.5)
    expect(env.core.parseNumber('1.234,5')).toBe(1234.5)
    expect(env.core.parseNumber('10.5')).toBe(10.5)
  })

  it('AC-T41-01 ruleType all exige todas; any basta uma', async () => {
    const w = await world(env, { contactLabels: ['VIP'] })
    const yes = sys('tag', { tagName: 'VIP' })
    const no = sys('tag', { tagName: 'Nenhuma' })
    expect(await decide(env, w, { ruleType: 'all', conditions: [yes, no] })).toBe('failure')
    expect(await decide(env, w, { ruleType: 'any', conditions: [no, yes] })).toBe('success')
    expect(await decide(env, w, { ruleType: 'any', conditions: [no, no] })).toBe('failure')
    expect(await decide(env, w, { ruleType: 'all', conditions: [yes, sys('message_window', {})] })).toBe('success')
  })
})

describe('AC-T41-02 distribuidor', () => {
  const distDef = (config: Record<string, unknown>, outputs: string[]) =>
    def(
      [node('D', 'distributor', [action('D-a', 'distribute_contacts', config)]), ...outputs.map((o) => marker(`M_${o}`))],
      [edge('start', 'source', 'D'), ...outputs.map((o) => edge('D', `output:${o}`, `M_${o}`))],
    )
  const which = (visited: string[]) => visited.find((v) => v.startsWith('M_'))?.slice(2)

  it('AC-T41-02 respeita as quantidades (2:1), saída com 0 nunca recebe, e publica flow.distributor_updated', async () => {
    const w = await world(env)
    const flowId = await publishedFlow(env, w.companyId, distDef({ outputs: [{ id: 'A', name: 'Saída A', quantity: 2 }, { id: 'B', name: 'Saída B', quantity: 1 }, { id: 'Z', quantity: 0 }] }, ['A', 'B', 'Z']))
    const picks: string[] = []
    let lastPublished: any = null
    for (let i = 0; i < 6; i++) {
      const c = await extraContact(env, w)
      const r = await runFlow(env, w, { flowId }, { contactId: c.contactId, chatId: c.chatId })
      picks.push(which(r.visited)!)
      const ev = r.published.find((p) => p.type === 'flow.distributor_updated')
      expect(ev, `sem flow.distributor_updated no envio ${i}`).toBeTruthy()
      expect(ev!.companyId).toBe(w.companyId)
      lastPublished = ev!.data
      if (i === 2) expect([...picks].sort()).toEqual(['A', 'A', 'B'])
    }
    // round-robin ponderado suave: empate em (count+1)/quantity vai para a ordem das saídas
    expect(picks).toEqual(['A', 'A', 'B', 'A', 'A', 'B'])
    expect(picks.filter((p) => p === 'A')).toHaveLength(4)
    expect(picks.filter((p) => p === 'B')).toHaveLength(2)
    expect(picks).not.toContain('Z')
    expect(lastPublished).toMatchObject({ flow_id: flowId, node_id: 'D' })
    const counts = Object.fromEntries(lastPublished.outputs.map((o: any) => [o.id, o.count]))
    expect(counts).toMatchObject({ A: 4, B: 2, Z: 0 })
    expect(lastPublished.outputs.find((o: any) => o.id === 'A')).toMatchObject({ name: 'Saída A', quantity: 2 })
    const rows = await env.q(`SELECT output_key, count FROM crm.flow_distributor_counters WHERE flow_id = $1 ORDER BY output_key`, [flowId])
    expect(Object.fromEntries(rows.map((r: any) => [r.output_key.replace(/^output:/, ''), Number(r.count)]))).toMatchObject({ A: 4, B: 2 })
  })

  it('AC-T41-02 "distribuir sempre para o próximo" alterna ignorando as quantidades', async () => {
    const w = await world(env)
    const flowId = await publishedFlow(env, w.companyId, distDef({ outputs: [{ id: 'A', quantity: 5 }, { id: 'B', quantity: 1 }], distribute_always_next: true }, ['A', 'B']))
    const picks: string[] = []
    for (let i = 0; i < 4; i++) {
      const c = await extraContact(env, w)
      picks.push(which((await runFlow(env, w, { flowId }, { contactId: c.contactId, chatId: c.chatId })).visited)!)
    }
    expect(picks).toEqual(['A', 'B', 'A', 'B'])
  })

  it('AC-T41-02 "evitar repetição": o mesmo contato volta para a mesma saída e não incrementa o contador', async () => {
    const w = await world(env)
    const flowId = await publishedFlow(env, w.companyId, distDef({ outputs: [{ id: 'A', quantity: 1 }, { id: 'B', quantity: 1 }], prevent_repetition: true }, ['A', 'B']))
    const first = which((await runFlow(env, w, { flowId })).visited)
    const again = await runFlow(env, w, { flowId })
    expect(which(again.visited)).toBe(first)
    const rows = await env.q(`SELECT sum(count)::int AS n FROM crm.flow_distributor_counters WHERE flow_id = $1`, [flowId])
    expect(rows[0].n).toBe(1)
    // outro contato vai para a outra saída
    const c = await extraContact(env, w)
    const other = which((await runFlow(env, w, { flowId }, { contactId: c.contactId, chatId: c.chatId })).visited)
    expect(other).not.toBe(first)
  })
})

describe('AC-T41-03 conexão de fluxo', () => {
  const jumpDef = (target: string, failureEdge: boolean) =>
    def(
      [node('J', 'connection_flow', [action('J-a', 'execute_flow', { target_flow_id: target })]), marker('F')],
      [edge('start', 'source', 'J'), ...(failureEdge ? [edge('J', 'failure', 'F')] : [])],
    )

  it('AC-T41-03 encerra o run atual e cria um run no fluxo de destino ativo (mesmo contato e chat)', async () => {
    const w = await world(env)
    const target = await publishedFlow(env, w.companyId, def([marker('T')], [edge('start', 'source', 'T')]))
    const r = await runFlow(env, w, { def: jumpDef(target, true) })
    expect(r.error, String(r.error)).toBeNull()
    expect(r.status).toBe('completed')
    expect(r.visited).not.toContain('F')
    const [next] = await env.q(`SELECT * FROM crm.flow_runs WHERE flow_id = $1 AND contact_id = $2`, [target, w.contactId])
    expect(next, 'run do destino não foi criado').toBeTruthy()
    expect(next.chat_id).toBe(w.chatId)
    expect(next.trigger).toMatchObject({ kind: 'connection_flow', from_run_id: r.runId })
    expect(['running', 'waiting', 'completed']).toContain(next.status)
  })

  it('AC-T41-03 destino inativo segue por failure; sem aresta failure o run falha (target_flow_inactive)', async () => {
    const w = await world(env)
    const paused = await publishedFlow(env, w.companyId, def([marker('T')], [edge('start', 'source', 'T')]), 'paused')
    const r = await runFlow(env, w, { def: jumpDef(paused, true) })
    expect(r.visited).toEqual(['F'])
    expect(await env.q(`SELECT id FROM crm.flow_runs WHERE flow_id = $1`, [paused])).toHaveLength(0)

    const draft = await publishedFlow(env, w.companyId, def([marker('T')], [edge('start', 'source', 'T')]), 'draft')
    const r2 = await runFlow(env, w, { def: jumpDef(draft, false) })
    expect(r2.status).toBe('failed')
    expect(String(r2.row.error)).toContain('target_flow_inactive')
    expect(await env.q(`SELECT id FROM crm.flow_runs WHERE flow_id = $1`, [draft])).toHaveLength(0)

    // fluxo de outra empresa também é inválido
    const other = await world(env)
    const foreign = await publishedFlow(env, other.companyId, def([marker('T')], [edge('start', 'source', 'T')]))
    const r3 = await runFlow(env, w, { def: jumpDef(foreign, true) })
    expect(r3.visited).toEqual(['F'])
  })
})

describe('AC-T41-04 intervalo inteligente', () => {
  const siDef = (config: Record<string, unknown>) =>
    def([node('I', 'smart_interval', [action('I-a', 'smart_interval', config)]), marker('N')], [edge('start', 'source', 'I'), edge('I', 'source', 'N')])
  const week = (days: Record<string, [string, string]>) =>
    Object.fromEntries(Object.entries(days).map(([d, [s, e]]) => [d, { enabled: true, start_time: s, end_time: e }]))

  async function deadline(config: Record<string, unknown>, nowIso: string, timeZone = 'America/Sao_Paulo') {
    const w = await world(env, { timeZone })
    const r = await runFlow(env, w, { def: siDef(config) }, { now: at(nowIso) })
    return { r, deadline: r.row.wait?.deadline_at ? new Date(r.row.wait.deadline_at).toISOString() : null }
  }

  it('AC-T41-04 por intervalo: agora + intervalo, como espera de timer', async () => {
    const { r, deadline: d } = await deadline({ schedule_type: 'time', interval_value: 2, interval_unit: 'hours' }, '2026-10-19T13:00:00Z')
    expect(r.status).toBe('waiting')
    expect(r.row.wait.kind).toBe('timer')
    expect(d).toBe('2026-10-19T15:00:00.000Z')
    expect(r.visited).toEqual([])
    expect(r.timers.length).toBeGreaterThanOrEqual(1)
    expect(Math.abs(r.timers[0]!.delayMs - 2 * 3_600_000)).toBeLessThan(1000)
  })

  it('AC-T41-04 por data: hora local da empresa; data já passada segue direto', async () => {
    expect((await deadline({ schedule_type: 'date', scheduled_date: '2026-10-21T09:30' }, '2026-10-19T13:00:00Z')).deadline).toBe('2026-10-21T12:30:00.000Z')
    expect((await deadline({ schedule_type: 'date', scheduled_date: '2026-10-21T09:30' }, '2026-10-19T13:00:00Z', 'Asia/Tokyo')).deadline).toBe('2026-10-21T00:30:00.000Z')
    const past = await deadline({ schedule_type: 'date', scheduled_date: '2026-10-01T09:00' }, '2026-10-19T13:00:00Z')
    expect(past.r.visited).toEqual(['N'])
    expect(past.r.status).not.toBe('waiting')
  })

  it('AC-T41-04 semanal: dentro da faixa segue direto; fora espera o próximo início, na virada do dia e da semana', async () => {
    const weekdays = week({ monday: ['09:00', '18:00'], tuesday: ['09:00', '18:00'] })
    // segunda 10:00 SP: dentro
    const inside = await deadline({ schedule_type: 'weekly', weekly_schedule: weekdays }, '2026-10-19T13:00:00Z')
    expect(inside.r.visited).toEqual(['N'])
    // segunda 19:00 SP → terça 09:00 SP (virada do dia)
    expect((await deadline({ schedule_type: 'weekly', weekly_schedule: weekdays }, '2026-10-19T22:00:00Z')).deadline).toBe('2026-10-20T12:00:00.000Z')
    // segunda 07:00 SP → hoje 09:00
    expect((await deadline({ schedule_type: 'weekly', weekly_schedule: weekdays }, '2026-10-19T10:00:00Z')).deadline).toBe('2026-10-19T12:00:00.000Z')
    // sábado 12:00 SP só com segunda → segunda 09:00 (virada da semana)
    const mondayOnly = week({ monday: ['09:00', '18:00'] })
    expect((await deadline({ schedule_type: 'weekly', weekly_schedule: mondayOnly }, '2026-10-24T15:00:00Z')).deadline).toBe('2026-10-26T12:00:00.000Z')
    // domingo 23:30 SP (= segunda 02:30Z) → segunda 09:00 SP
    expect((await deadline({ schedule_type: 'weekly', weekly_schedule: mondayOnly }, '2026-10-26T02:30:00Z')).deadline).toBe('2026-10-26T12:00:00.000Z')
    // segunda 18:30 SP só com segunda → próxima segunda
    expect((await deadline({ schedule_type: 'weekly', weekly_schedule: mondayOnly }, '2026-10-19T21:30:00Z')).deadline).toBe('2026-10-26T12:00:00.000Z')
    // dia desabilitado é ignorado
    const withDisabled = { ...mondayOnly, tuesday: { enabled: false, start_time: '09:00', end_time: '18:00' } }
    expect((await deadline({ schedule_type: 'weekly', weekly_schedule: withDisabled }, '2026-10-19T22:00:00Z')).deadline).toBe('2026-10-26T12:00:00.000Z')
  })

  it('AC-T41-04 nextSmartInterval (função pura) bate com o run e respeita o fuso', () => {
    const nsi = env.core.nextSmartInterval
    const weekly = { schedule_type: 'weekly', weekly_schedule: week({ friday: ['20:00', '22:00'] }) }
    // sexta 21:00 em Tóquio = sexta 12:00Z; em São Paulo é sexta 09:00 (antes da faixa)
    const fri12z = new Date('2026-10-23T12:00:00Z')
    expect(nsi(weekly, fri12z, 'Asia/Tokyo')).toMatchObject({ delayMs: 0 })
    const sp = nsi(weekly, fri12z, 'America/Sao_Paulo')
    expect(new Date(sp.at).toISOString()).toBe('2026-10-23T23:00:00.000Z') // sexta 20:00 SP
    expect(sp.delayMs).toBe(11 * 3_600_000)
    const t = nsi({ schedule_type: 'time', interval_value: 90, interval_unit: 'minutes' }, fri12z, 'America/Sao_Paulo')
    expect(t.delayMs).toBe(90 * 60_000)
  })
})
