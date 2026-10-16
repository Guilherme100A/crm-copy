// AC-T61-06 (edição em massa com keep/clear) e regras da API de connection-flow-configs,
// mais o 409 ao excluir fluxo referenciado por config de conexão.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newFlow, putConfig, startEnv, tenant, type Env, type Tenant } from './setup'

let env: Env

beforeAll(async () => {
  env = await startEnv()
}, 120_000)

afterAll(async () => {
  await env?.close()
})

/** Duas conexões na mesma empresa, ambas com config completa. */
async function twoConfigured() {
  const t = await tenant(env)
  const second = await t.c.post('/api/connections', { name: 'Conexão 2' })
  expect(second.status).toBe(201)
  const t2: Tenant = { ...t, connectionId: second.body.connection.id, sessionId: second.body.connection.session_id }
  const f = {
    welcome: await newFlow(env, t.companyId, 'Boas-vindas'),
    def: await newFlow(env, t.companyId, 'Padrão'),
    fin: await newFlow(env, t.companyId, 'Finalizada'),
    att: await newFlow(env, t.companyId, 'Atendimento finalizado'),
    kw: await newFlow(env, t.companyId, 'Palavra'),
    other: await newFlow(env, t.companyId, 'Outro'),
  }
  const full = {
    welcome_flow_id: f.welcome,
    default_response_flow_id: f.def,
    default_response_delay_hours: 5,
    finished_conversation_flow_id: f.fin,
    finished_attendance_flow_id: f.att,
    keyword_triggers: [{ flow_id: f.kw, conditions: [{ keyword: 'oi', match_type: 'contains' }] }],
  }
  await putConfig(t, full)
  await putConfig(t2, full)
  return { t, t2, f }
}

const getCfg = async (t: Tenant, connectionId = t.connectionId) => {
  const r = await t.c.get(`/api/connection-flow-configs/${connectionId}`)
  expect(r.status, r.text).toBe(200)
  return r.body.connection_flow_config
}

describe('T61 — edição em massa (AC-T61-06)', () => {
  it('AC-T61-06 keep não altera o campo e clear o anula, em todas as conexões escolhidas', async () => {
    const { t, t2, f } = await twoConfigured()
    const r = await t.c.post('/api/connection-flow-configs/bulk-update', {
      connection_ids: [t.connectionId, t2.connectionId],
      connection_flow_config: {
        welcome_flow_id: 'keep',
        default_response_flow_id: 'clear',
        finished_conversation_flow_id: f.other,
        finished_attendance_flow_id: 'keep',
        keyword_triggers: 'keep',
      },
    })
    expect(r.status, r.text).toBe(200)
    for (const id of [t.connectionId, t2.connectionId]) {
      const cfg = await getCfg(t, id)
      expect(cfg.welcome_flow_id).toBe(f.welcome)
      expect(cfg.default_response_flow_id).toBeNull()
      expect(cfg.finished_conversation_flow_id).toBe(f.other)
      expect(cfg.finished_attendance_flow_id).toBe(f.att)
      expect(cfg.keyword_triggers).toHaveLength(1)
      expect(cfg.keyword_triggers[0].flow_id).toBe(f.kw)
    }
  })

  it('AC-T61-06 campo ausente equivale a keep; clear nas palavras-chave esvazia a lista; clear no atraso volta ao padrão 24', async () => {
    const { t, t2, f } = await twoConfigured()
    const r = await t.c.post('/api/connection-flow-configs/bulk-update', {
      connection_ids: [t.connectionId],
      connection_flow_config: { keyword_triggers: 'clear', default_response_delay_hours: 'clear' },
    })
    expect(r.status, r.text).toBe(200)
    const cfg = await getCfg(t)
    expect(cfg.keyword_triggers).toEqual([])
    expect(cfg.default_response_delay_hours).toBe(24)
    expect(cfg.welcome_flow_id).toBe(f.welcome)
    expect(cfg.default_response_flow_id).toBe(f.def)
    // a conexão fora da lista não muda
    const untouched = await getCfg(t, t2.connectionId)
    expect(untouched.keyword_triggers).toHaveLength(1)
    expect(untouched.default_response_delay_hours).toBe(5)
  })

  it('AC-T61-06 conexão de outra empresa na edição em massa é recusada como inexistente, sem alterar nada', async () => {
    const { t, f } = await twoConfigured()
    const stranger = await tenant(env)
    const body = (ids: string[]) => ({ connection_ids: ids, connection_flow_config: { welcome_flow_id: 'clear' } })
    const foreign = await stranger.c.post('/api/connection-flow-configs/bulk-update', body([t.connectionId]))
    const missing = await stranger.c.post('/api/connection-flow-configs/bulk-update', body(['00000000-0000-4000-8000-000000000000']))
    // referência no CORPO: 404 ou 422, mas a mesma resposta para "de outra empresa" e "inexistente" (não vaza existência)
    expect([404, 422]).toContain(foreign.status)
    expect(foreign.status).toBe(missing.status)
    expect(foreign.body.error.code).toBe(missing.body.error.code)
    expect((await getCfg(t)).welcome_flow_id).toBe(f.welcome)
  })
})

describe('T61 — integridade das referências', () => {
  it('T61 DELETE de fluxo referenciado por config de conexão → 409 com a referência', async () => {
    const { t, f } = await twoConfigured()
    const r = await t.c.delete(`/api/flows/${f.welcome}`)
    expect(r.status, r.text).toBe(409)
    expect(r.body.error.code).toBe('CONFLICT')
    const refs = r.body.error.details?.references ?? []
    expect(refs.some((x: any) => x.kind === 'connection_flow_config')).toBe(true)
    // fluxo sem referência pode ser excluído
    const free = await newFlow(env, t.companyId, 'Livre')
    expect((await t.c.delete(`/api/flows/${free}`)).status).toBeLessThan(300)
  })

  it('T61 fluxo de outra empresa na config → 422', async () => {
    const t = await tenant(env)
    const other = await tenant(env)
    const foreign = await newFlow(env, other.companyId)
    const r = await t.c.put(`/api/connection-flow-configs/${t.connectionId}`, { welcome_flow_id: foreign })
    expect(r.status).toBe(422)
  })
})
