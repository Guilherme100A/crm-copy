// AC-T94-01..03: credenciais MCP (token mostrado uma vez, listagem enxuta), 401 no endpoint para token inválido,
// expirado ou revogado, e ferramentas só de leitura isoladas pela empresa do token.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { uuid } from '../helpers/factories'
import { toolData } from './mcp'
import { MCP_PATH, mcp, newCredential, newMember, newOwner, rawMcp, seedCompany, startEnv, TOKEN_RE, type Env, type User } from './setup'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

let env: Env
let owner: User
beforeAll(async () => {
  env = await startEnv()
  owner = await newOwner(env)
})
afterAll(async () => {
  await env?.close()
})

const DTO_KEYS = ['auth_type', 'created_at', 'expires_at', 'id', 'last_used_at', 'name', 'status']

async function list(u: User) {
  const res = await u.c.get('/api/mcp_credentials')
  expect(res.status, res.text).toBe(200)
  return res
}

// ---------------------------------------------------------------- AC-T94-01

describe('T94 credenciais', () => {
  it('AC-T94-01 criar devolve o token uma única vez (crm_mcp_…) e a URL do servidor MCP', async () => {
    const { credential, token, endpoint, body } = await newCredential(owner, { name: 'Cursor notebook' })
    expect(token).toMatch(TOKEN_RE)
    expect(endpoint).toMatch(/\/api\/mcp$/)
    expect(credential).toMatchObject({ name: 'Cursor notebook', auth_type: 'static', status: 'active', expires_at: null, last_used_at: null })
    // o DTO da criação não repete o token nem o hash
    expect(Object.keys(credential).sort()).toEqual(DTO_KEYS)
    expect(JSON.stringify(credential)).not.toContain(token)
    expect(Object.keys(body).sort()).toEqual(['mcp_credential', 'mcp_endpoint_url', 'token'])

    // nunca mais aparece: nem na listagem, nem guardado em claro no banco
    const res = await list(owner)
    expect(res.text).not.toContain(token)
    expect(res.text).not.toContain(token.slice('crm_mcp_'.length))
    const rows = await env.q(`SELECT * FROM crm.mcp_credentials WHERE id = $1`, [credential.id])
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows[0]), 'token guardado em claro').not.toContain(token.slice('crm_mcp_'.length))
    expect(rows[0].token_hash).toBeTruthy()
  })

  it('AC-T94-01 listagem traz só nome, status, expiração e último uso (sem token/hash), mais nova primeiro, e a URL do servidor', async () => {
    const u = await newOwner(env)
    const a = await newCredential(u, { name: 'Primeira' })
    const b = await newCredential(u, { name: 'Segunda', expires_in_days: 30 })
    const res = await list(u)
    expect(res.body.mcp_endpoint_url).toBe(a.endpoint)
    const items: Any[] = res.body.mcp_credentials
    expect(items.map((i) => i.id)).toEqual([b.credential.id, a.credential.id])
    for (const i of items) {
      expect(Object.keys(i).sort()).toEqual(DTO_KEYS)
      expect(i).not.toHaveProperty('token')
      expect(i).not.toHaveProperty('token_hash')
    }
    expect(res.text).not.toContain(a.token)
    expect(res.text).not.toContain(b.token)
    const second = items[0]
    expect(second).toMatchObject({ name: 'Segunda', status: 'active', last_used_at: null })
    const days = (new Date(second.expires_at).getTime() - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(29.9)
    expect(days).toBeLessThan(30.1)
    // outra empresa não vê as credenciais desta
    const other = await newOwner(env)
    expect((await list(other)).body.mcp_credentials).toEqual([])
  })

  it('AC-T94-01 último uso é preenchido depois de usar o token; expirada aparece como expired; revogada some da lista', async () => {
    const u = await newOwner(env)
    const used = await newCredential(u, { name: 'Usada' })
    const expired = await newCredential(u, { name: 'Vencida' })
    const revoked = await newCredential(u, { name: 'Revogada' })

    expect((await mcp(env, used.token).initialize()).status).toBe(200)
    await env.q(`UPDATE crm.mcp_credentials SET expires_at = now() - interval '1 minute' WHERE id = $1`, [expired.credential.id])
    const del = await u.c.delete(`/api/mcp_credentials/${revoked.credential.id}`)
    expect(del.status, del.text).toBe(200)

    const items: Any[] = (await list(u)).body.mcp_credentials
    expect(items.map((i) => i.id).sort()).toEqual([used.credential.id, expired.credential.id].sort())
    const usedDto = items.find((i) => i.id === used.credential.id)
    expect(usedDto.last_used_at).not.toBeNull()
    expect(Math.abs(new Date(usedDto.last_used_at).getTime() - Date.now())).toBeLessThan(60_000)
    expect(items.find((i) => i.id === expired.credential.id)).toMatchObject({ status: 'expired', last_used_at: null })
  })

  it('AC-T94-01 validação: nome vazio, auth_type oauth e expiração no passado → 422', async () => {
    for (const body of [{ name: '' }, { name: 'x'.repeat(101) }, { name: 'OAuth', auth_type: 'oauth' }, { name: 'Passado', expires_at: new Date(Date.now() - 3_600_000).toISOString() }]) {
      const res = await owner.c.post('/api/mcp_credentials', { mcp_credential: { auth_type: 'static', ...body } })
      expect(res.status, `${JSON.stringify(body)} → ${res.text}`).toBe(422)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
      expect(res.text).not.toMatch(/crm_mcp_/)
    }
  })

  it('AC-T94-01 permissões: só view lista mas não cria nem revoga; revogar credencial de outra empresa → 404', async () => {
    const u = await newOwner(env)
    const cred = await newCredential(u)
    const viewer = await newMember(env, u.companyId, ['settings.mcp.view'])
    expect((await viewer.c.get('/api/mcp_credentials')).status).toBe(200)
    expect((await viewer.c.post('/api/mcp_credentials', { mcp_credential: { name: 'X', auth_type: 'static' } })).status).toBe(403)
    expect((await viewer.c.delete(`/api/mcp_credentials/${cred.credential.id}`)).status).toBe(403)
    const stranger = await newOwner(env)
    expect((await stranger.c.delete(`/api/mcp_credentials/${cred.credential.id}`)).status).toBe(404)
    expect((await u.c.delete(`/api/mcp_credentials/${uuid()}`)).status).toBe(404)
    // continua ativa
    expect((await mcp(env, cred.token).initialize()).status).toBe(200)
  })
})

// ---------------------------------------------------------------- AC-T94-02

function expect401(r: { status: number; headers: Headers; body: Any; text: string }, label: string) {
  expect(r.status, `${label}: ${r.text}`).toBe(401)
  expect(r.body?.error?.code, label).toBe('UNAUTHORIZED')
  expect(r.headers.get('www-authenticate') ?? '', label).toMatch(/^Bearer/i)
  expect(r.text, `${label}: não deveria responder JSON-RPC`).not.toContain('"jsonrpc"')
}

describe('T94 autenticação do endpoint MCP', () => {
  it('AC-T94-02 sem token, token malformado ou desconhecido → 401', async () => {
    const valid = (await newCredential(owner)).token
    expect401(await rawMcp(env, {}), 'sem Authorization')
    expect401(await rawMcp(env, { authorization: 'Bearer' }), 'Bearer vazio')
    expect401(await rawMcp(env, { authorization: valid }), 'sem o prefixo Bearer')
    expect401(await rawMcp(env, { authorization: `Basic ${Buffer.from(`x:${valid}`).toString('base64')}` }), 'Basic')
    expect401(await rawMcp(env, { authorization: 'Bearer nao-e-um-token' }), 'malformado')
    expect401(await rawMcp(env, { authorization: `Bearer crm_mcp_${'A'.repeat(43)}` }), 'desconhecido')
    expect401(await rawMcp(env, { authorization: `Bearer ${valid.slice(0, -1)}${valid.endsWith('A') ? 'B' : 'A'}` }), 'último caractere trocado')
    // a sessão do CRM não substitui o Bearer
    const res: Response = await env.app.request(MCP_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', cookie: `crm_session=${owner.c.cookies.get('crm_session')}`, 'x-requested-with': 'crm', 'x-company-id': owner.companyId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    expect(res.status).toBe(401)
    // o token válido passa
    const ok = await mcp(env, valid).initialize()
    expect(ok.status, ok.text).toBe(200)
    expect(ok.message.result.serverInfo).toBeTruthy()
  })

  it('AC-T94-02 token expirado → 401 (antes válido)', async () => {
    const { credential, token } = await newCredential(owner, { expires_in_days: 1 })
    expect((await mcp(env, token).initialize()).status).toBe(200)
    await env.q(`UPDATE crm.mcp_credentials SET expires_at = now() - interval '1 minute' WHERE id = $1`, [credential.id])
    expect401(await rawMcp(env, { authorization: `Bearer ${token}` }), 'expirado')
    const r = await mcp(env, token).send('tools/list', {})
    expect(r.status).toBe(401)
  })

  it('AC-T94-02 token revogado → 401 na hora; as outras credenciais seguem valendo', async () => {
    const a = await newCredential(owner)
    const b = await newCredential(owner)
    const client = mcp(env, a.token)
    expect((await client.initialize()).status).toBe(200)
    expect((await client.listTools()).length).toBeGreaterThan(0)
    const del = await owner.c.delete(`/api/mcp_credentials/${a.credential.id}`)
    expect(del.status, del.text).toBe(200)
    expect((await client.send('tools/list', {})).status, 'revogado deveria valer na hora').toBe(401)
    expect401(await rawMcp(env, { authorization: `Bearer ${a.token}` }), 'revogado')
    expect((await owner.c.delete(`/api/mcp_credentials/${a.credential.id}`)).status, 'revogar de novo').toBe(404)
    expect((await mcp(env, b.token).initialize()).status).toBe(200)
  })
})

// ---------------------------------------------------------------- AC-T94-03

const TOOLS = ['get_contact', 'list_chats', 'list_connections', 'list_contacts', 'list_flows']

describe('T94 ferramentas', () => {
  let a: User
  let b: User
  let seedA: Awaited<ReturnType<typeof seedCompany>>
  let seedB: Awaited<ReturnType<typeof seedCompany>>
  let tokenA: string
  beforeAll(async () => {
    a = await newOwner(env)
    b = await newOwner(env)
    seedA = await seedCompany(env, a, 'Alfa')
    seedB = await seedCompany(env, b, 'Beta')
    tokenA = (await newCredential(a)).token
  })

  it('AC-T94-03 tools/list traz só as 5 ferramentas de leitura, todas com readOnlyHint e sem destructiveHint', async () => {
    const client = mcp(env, tokenA)
    expect((await client.initialize()).status).toBe(200)
    const tools = await client.listTools()
    expect(tools.map((t: Any) => t.name).sort()).toEqual(TOOLS)
    for (const t of tools) {
      expect(t.annotations, t.name).toMatchObject({ readOnlyHint: true, destructiveHint: false })
      expect(t.name, 'nome de ferramenta de escrita').not.toMatch(/^(create|update|delete|send|set|add|remove|archive|patch|post)_/)
      expect(t.inputSchema?.type, t.name).toBe('object')
    }
  })

  it('AC-T94-03 ferramenta de escrita inexistente é recusada e não altera dados', async () => {
    const client = mcp(env, tokenA)
    await client.initialize()
    const before = await env.q(`SELECT count(*)::int AS n FROM crm.contacts WHERE company_id = $1`, [a.companyId])
    for (const name of ['delete_contact', 'create_contact', 'update_contact']) {
      const r = await client.callTool(name, { id: seedA.contactId, name: 'Hackeado' })
      expect(r.isError, `${name} deveria ser recusada`).toBe(true)
    }
    const after = await env.q(`SELECT count(*)::int AS n FROM crm.contacts WHERE company_id = $1`, [a.companyId])
    expect(after).toEqual(before)
    const [ct] = await env.q(`SELECT name FROM crm.contacts WHERE id = $1`, [seedA.contactId])
    expect(ct.name).toBe('Contato Alfa')
  })

  it('AC-T94-03 list_contacts, list_connections, list_flows e list_chats devolvem só dados da empresa do token', async () => {
    const client = mcp(env, tokenA)
    await client.initialize()

    const contacts = toolData(await client.callTool('list_contacts', {})).contacts as Any[]
    expect(contacts.map((c) => c.id)).toContain(seedA.contactId)
    expect(contacts.map((c) => c.id)).not.toContain(seedB.contactId)
    expect(contacts.find((c) => c.id === seedA.contactId)).toMatchObject({ name: 'Contato Alfa', email: 'alfa@exemplo.test' })
    // busca pelo nome da outra empresa não vaza
    const search = toolData(await client.callTool('list_contacts', { search: 'Beta' })).contacts as Any[]
    expect(search).toEqual([])

    const connections = toolData(await client.callTool('list_connections', {})).connections as Any[]
    expect(connections.map((c) => c.id)).toEqual([seedA.connectionId])

    const flows = toolData(await client.callTool('list_flows', {})).flows as Any[]
    expect(flows.map((f) => f.id)).toContain(seedA.flowId)
    expect(flows.map((f) => f.id)).not.toContain(seedB.flowId)
    expect(toolData(await client.callTool('list_flows', { search: 'Beta' })).flows).toEqual([])

    const chats = toolData(await client.callTool('list_chats', {})).chats as Any[]
    expect(chats.map((c) => c.id)).toEqual([seedA.chatId])
    expect(chats[0]).toMatchObject({ connection_id: seedA.connectionId, contact: { id: seedA.contactId, name: 'Contato Alfa' } })

    // texto bruto das respostas não contém nada da empresa B
    const raw = JSON.stringify([contacts, connections, flows, chats])
    for (const id of [seedB.contactId, seedB.connectionId, seedB.flowId, seedB.chatId]) expect(raw).not.toContain(id)
    expect(raw).not.toContain('Beta')
  })

  it('AC-T94-03 get_contact de contato de outra empresa → isError not_found; da própria → dados', async () => {
    const client = mcp(env, tokenA)
    await client.initialize()
    const own = await client.callTool('get_contact', { id: seedA.contactId })
    expect(own.isError ?? false).toBe(false)
    expect(toolData(own).contact).toMatchObject({ id: seedA.contactId, name: 'Contato Alfa' })
    const foreign = await client.callTool('get_contact', { id: seedB.contactId })
    expect(foreign.isError).toBe(true)
    expect(JSON.stringify(foreign)).not.toContain('Contato Beta')
    expect(toolData(foreign)).toMatchObject({ error: 'not_found' })
  })

  it('AC-T94-03 o token da empresa B vê só os dados de B', async () => {
    const client = mcp(env, (await newCredential(b)).token)
    await client.initialize()
    const contacts = toolData(await client.callTool('list_contacts', {})).contacts as Any[]
    expect(contacts.map((c) => c.id)).toEqual([seedB.contactId])
    expect((toolData(await client.callTool('list_chats', {})).chats as Any[]).map((c) => c.id)).toEqual([seedB.chatId])
  })
})
