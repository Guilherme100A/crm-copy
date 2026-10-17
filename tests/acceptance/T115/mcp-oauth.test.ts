// AC-T115-01..04: servidor de autorização OAuth 2.1 do endpoint MCP (conector do Claude) com cliente de teste local:
// descoberta (401 + resource_metadata → metadados), registro dinâmico, /authorize com login e consentimento, PKCE S256,
// /token, status pending → connected, revogação, isolamento por empresa e reuso de refresh token.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { toolData } from '../T94/mcp'
import { newCredential, newMember, newOwner, seedCompany, type Env, type User } from '../T94/setup'
import { createClient } from '../helpers/http'
import {
  ACCESS_RE,
  API,
  authorize,
  consentGet,
  consentPost,
  dtoOf,
  exchange,
  mcpAt,
  mcpStatus,
  newClient,
  newOAuthCredential,
  pathOf,
  pkce,
  postForm,
  raw,
  REDIRECT,
  refresh,
  REFRESH_RE,
  register,
  runFlow,
  startEnv,
  TOOLS,
  WEB,
} from './oauth'

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

function expectOAuthError(r: { status: number; body: Any; text: string }, error: string, label = error) {
  expect(r.status, `${label}: ${r.text}`).toBeGreaterThanOrEqual(400)
  expect(r.body?.error, `${label}: ${r.text}`).toBe(error)
  expect(typeof r.body?.error_description, label).toBe('string')
}

// ---------------------------------------------------------------- AC-T115-01

describe('T115 fluxo OAuth completo', () => {
  it('AC-T115-01 descoberta: 401 na URL do conector aponta os metadados do recurso, que apontam o servidor de autorização (S256, registro, token, revogação)', async () => {
    const { credential, connectorUrl } = await newOAuthCredential(owner)
    expect(connectorUrl).toBe(`${API}/api/mcp/${credential.id}`)

    const unauth = await raw(env, connectorUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    expect(unauth.status).toBe(401)
    const www = unauth.headers.get('www-authenticate') ?? ''
    expect(www).toMatch(/^Bearer /)
    const rm = www.match(/resource_metadata="([^"]+)"/)?.[1]
    expect(rm, www).toBe(`${API}/.well-known/oauth-protected-resource/api/mcp/${credential.id}`)

    const prm = await raw(env, rm!)
    expect(prm.status, prm.text).toBe(200)
    expect(prm.body.resource).toBe(connectorUrl)
    expect(prm.body.authorization_servers).toEqual([expect.stringMatching(/^https:\/\/api\.crm\.test/)])

    const asm = await raw(env, '/.well-known/oauth-authorization-server')
    expect(asm.status, asm.text).toBe(200)
    expect(asm.body).toMatchObject({
      issuer: prm.body.authorization_servers[0],
      authorization_endpoint: `${API}/api/mcp-oauth/authorize`,
      token_endpoint: `${API}/api/mcp-oauth/token`,
      registration_endpoint: `${API}/api/mcp-oauth/register`,
      revocation_endpoint: `${API}/api/mcp-oauth/revoke`,
      code_challenge_methods_supported: ['S256'],
    })
    expect(asm.body.response_types_supported).toEqual(['code'])
    expect(asm.body.grant_types_supported).toEqual(expect.arrayContaining(['authorization_code', 'refresh_token']))
    // metadados de credencial inexistente ou static → 404
    const st = await newCredential(owner)
    expect((await raw(env, `/.well-known/oauth-protected-resource/api/mcp/${st.credential.id}`)).status).toBe(404)
  })

  it('AC-T115-01 registro dinâmico → authorize → login + consentimento → código → /token com PKCE → token aceito no endpoint MCP', async () => {
    const { credential, connectorUrl } = await newOAuthCredential(owner, 'Claude do time')

    // registro dinâmico (RFC 7591)
    const reg = await register(env)
    expect(reg.status, reg.text).toBe(201)
    expect(reg.body).toMatchObject({ client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' })
    expect(typeof reg.body.client_id).toBe('string')
    const client = reg.body

    // /authorize → tela de consentimento da web
    const { verifier, challenge } = pkce()
    const az = await authorize(env, {
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz-123',
      resource: connectorUrl,
    })
    expect(az.status, az.text).toBe(302)
    expect(`${az.url!.origin}${az.url!.pathname}`).toBe(`${WEB}/oauth/consent`)
    const request = az.url!.searchParams.get('request')!
    expect(request).toBeTruthy()
    expect(az.location, 'segredos no Location').not.toMatch(/code=|crm_mcp/)

    // a tela de consentimento exige login: sem sessão → 401
    const anon = createClient({ fetcher: (p, init) => env.app.request(p, init) })
    expect((await anon.get(`/api/mcp-oauth/consent?request=${request}`)).status).toBe(401)
    expect((await anon.post('/api/mcp-oauth/consent', { request, company_id: owner.companyId, approve: true })).status).toBe(401)

    // com sessão: mostra cliente, credencial e empresa
    const info = await consentGet(owner, request)
    expect(info.status, info.text).toBe(200)
    expect(info.body.authorization_request).toMatchObject({
      request_id: request,
      client: { client_id: client.client_id, name: 'Claude', redirect_uri: REDIRECT },
      credential: { id: credential.id, name: 'Claude do time' },
      company: { id: owner.companyId },
    })

    const dec = await consentPost(owner, { request, company_id: owner.companyId, approve: true })
    expect(dec.status, dec.text).toBe(200)
    const back = new URL(dec.body.redirect_to)
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT)
    expect(back.searchParams.get('state')).toBe('xyz-123')
    const code = back.searchParams.get('code')!
    expect(code).toBeTruthy()

    // /token com PKCE válido
    const tok = await exchange(env, client, code, verifier)
    expect(tok.status, tok.text).toBe(200)
    expect(tok.body).toMatchObject({ token_type: 'Bearer' })
    expect(tok.body.access_token).toMatch(ACCESS_RE)
    expect(tok.body.refresh_token).toMatch(REFRESH_RE)
    expect(tok.body.expires_in).toBeGreaterThan(0)
    expect(tok.body.expires_in, 'access token deveria ser curto').toBeLessThanOrEqual(3600)
    expect(tok.headers.get('cache-control') ?? '').toMatch(/no-store/)

    // aceito no endpoint MCP (URL do conector)
    const mcp = mcpAt(env, pathOf(connectorUrl), tok.body.access_token)
    const init = await mcp.initialize()
    expect(init.status, init.text).toBe(200)
    expect((await mcp.listTools()).map((t: Any) => t.name).sort()).toEqual(TOOLS)

    // banco guarda só hash: nem access, nem refresh, nem código em claro
    const dump = JSON.stringify([
      await env.q(`SELECT * FROM crm.mcp_oauth_tokens WHERE company_id = $1`, [owner.companyId]),
      await env.q(`SELECT * FROM crm.mcp_oauth_authorizations WHERE company_id = $1`, [owner.companyId]),
      await env.q(`SELECT * FROM crm.mcp_oauth_grants WHERE company_id = $1`, [owner.companyId]),
    ])
    for (const secret of [tok.body.access_token, tok.body.refresh_token, code]) expect(dump).not.toContain(secret.slice(10))
  })

  it('AC-T115-01 PKCE no /token: code_verifier ausente ou errado → invalid_grant (e nenhum token emitido)', async () => {
    const { connectorUrl } = await newOAuthCredential(owner)
    const f = await runFlow(env, owner, connectorUrl, { stopAt: 'code' })

    const missing = await exchange(env, f.client, f.code, undefined)
    expectOAuthError(missing, 'invalid_grant', 'verifier ausente')
    expect(missing.status).toBe(400)
    expect(missing.text).not.toMatch(/crm_mcpat_/)

    const wrong = await exchange(env, f.client, f.code, pkce().verifier)
    expectOAuthError(wrong, 'invalid_grant', 'verifier errado')
    expect(wrong.text).not.toMatch(/crm_mcpat_/)

    // verifier = o próprio challenge (estilo plain) também não vale
    const g = await runFlow(env, owner, connectorUrl, { stopAt: 'code' })
    const { challenge } = pkce()
    expectOAuthError(await exchange(env, g.client, g.code, challenge), 'invalid_grant', 'challenge como verifier')
  })

  it('AC-T115-01 PKCE obrigatório e só S256 no /authorize: sem code_challenge ou com plain → erro de volta ao cliente, sem pedido de consentimento', async () => {
    const { connectorUrl } = await newOAuthCredential(owner)
    const client = await newClient(env)
    const { challenge } = pkce()
    const base = { response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, state: 's1', resource: connectorUrl }
    for (const [label, extra] of [
      ['sem PKCE', {}],
      ['plain', { code_challenge: challenge, code_challenge_method: 'plain' }],
      ['sem método', { code_challenge: challenge }],
    ] as const) {
      const r = await authorize(env, { ...base, ...extra })
      expect(r.status, `${label}: ${r.text}`).toBe(302)
      expect(`${r.url!.origin}${r.url!.pathname}`, label).toBe(REDIRECT)
      expect(r.url!.searchParams.get('error'), label).toBe('invalid_request')
      expect(r.url!.searchParams.get('state'), label).toBe('s1')
      expect(r.url!.searchParams.get('code'), label).toBeNull()
    }
  })

  it('AC-T115-01 código de uso único e preso ao redirect_uri/cliente; redirect_uri não registrado não redireciona', async () => {
    const { connectorUrl } = await newOAuthCredential(owner)
    const f = await runFlow(env, owner, connectorUrl, { stopAt: 'code' })

    // redirect_uri diferente / outro cliente → invalid_grant
    expectOAuthError(await exchange(env, f.client, f.code, f.verifier, { redirect_uri: 'http://127.0.0.1:9/outro' }), 'invalid_grant', 'redirect_uri')
    const other = await newClient(env)
    expectOAuthError(await exchange(env, other, f.code, f.verifier), 'invalid_grant', 'outro cliente')

    const ok = await exchange(env, f.client, f.code, f.verifier)
    expect(ok.status, ok.text).toBe(200)
    expect(await mcpStatus(env, pathOf(connectorUrl), ok.body.access_token)).toBe(200)
    // reuso do código → invalid_grant e derruba o que foi emitido com ele
    expectOAuthError(await exchange(env, f.client, f.code, f.verifier), 'invalid_grant', 'código reusado')
    expect(await mcpStatus(env, pathOf(connectorUrl), ok.body.access_token)).toBe(401)

    // redirect_uri não registrado: erro direto (sem 302 para o atacante)
    const bad = await authorize(env, {
      response_type: 'code',
      client_id: f.client.client_id,
      redirect_uri: 'https://evil.test/cb',
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
      resource: connectorUrl,
    })
    expect(bad.status, bad.text).toBe(400)
    expect(bad.location).toBeNull()
    // cliente desconhecido também não redireciona
    const unknown = await authorize(env, { response_type: 'code', client_id: 'nao-existe', redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: 'S256', resource: connectorUrl })
    expect(unknown.status).toBeGreaterThanOrEqual(400)
    expect(unknown.location).toBeNull()
  })

  it('AC-T115-01 registro dinâmico valida metadados; cliente confidencial autentica no /token (segredo errado → invalid_client)', async () => {
    const empty = await register(env, { redirect_uris: [] })
    expect(empty.status, empty.text).toBe(400)
    expect(['invalid_redirect_uri', 'invalid_client_metadata']).toContain(empty.body.error)
    expectOAuthError(await register(env, { token_endpoint_auth_method: 'private_key_jwt' }), 'invalid_client_metadata', 'método não suportado')
    const http = await register(env, { redirect_uris: ['http://evil.test/cb'] })
    expect(http.status, http.text).toBe(400)
    expect(['invalid_redirect_uri', 'invalid_client_metadata']).toContain(http.body.error)

    const conf = await newClient(env, { token_endpoint_auth_method: 'client_secret_post' })
    expect(typeof conf.client_secret).toBe('string')
    const { connectorUrl } = await newOAuthCredential(owner)
    const f = await runFlow(env, owner, connectorUrl, { client: conf, stopAt: 'code' })
    const bad = await exchange(env, conf, f.code, f.verifier, { client_secret: 'errado' })
    expectOAuthError(bad, 'invalid_client', 'segredo errado')
    expect(bad.status).toBe(401)
    const ok = await exchange(env, conf, f.code, f.verifier, { client_secret: conf.client_secret })
    expect(ok.status, ok.text).toBe(200)
    // segredo do cliente não fica em claro
    const rows = await env.q(`SELECT * FROM crm.mcp_oauth_clients WHERE client_id = $1`, [conf.client_id])
    expect(JSON.stringify(rows)).not.toContain(conf.client_secret)
  })

  it('AC-T115-01 negar no consentimento devolve access_denied ao cliente e não emite código', async () => {
    const { connectorUrl } = await newOAuthCredential(owner)
    const client = await newClient(env)
    const az = await authorize(env, { response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: 'S256', state: 'n1', resource: connectorUrl })
    const request = az.url!.searchParams.get('request')!
    const dec = await consentPost(owner, { request, company_id: owner.companyId, approve: false })
    expect(dec.status, dec.text).toBe(200)
    const back = new URL(dec.body.redirect_to)
    expect(back.searchParams.get('error')).toBe('access_denied')
    expect(back.searchParams.get('state')).toBe('n1')
    expect(back.searchParams.get('code')).toBeNull()
    // pedido já decidido não pode ser aprovado depois
    expect((await consentPost(owner, { request, company_id: owner.companyId, approve: true })).status).toBe(404)
  })
})

// ---------------------------------------------------------------- AC-T115-02

describe('T115 status e revogação', () => {
  it('AC-T115-02 credencial OAuth nasce pending (sem token, sem expiração) e passa a connected com o nome do cliente', async () => {
    const u = await newOwner(env)
    const { credential, body, connectorUrl } = await newOAuthCredential(u, 'Conector Claude')
    expect(body.token ?? null, 'OAuth não tem token para copiar').toBeNull()
    expect(credential).toMatchObject({ auth_type: 'oauth', status: 'pending', connected_client_hint: null, expires_at: null })
    expect(connectorUrl).toMatch(new RegExp(`/api/mcp/${credential.id}$`))
    expect(await dtoOf(u, credential.id)).toMatchObject({ status: 'pending', connected_client_hint: null, connector_url: connectorUrl })

    // aprovar sem trocar o código ainda não conecta
    const f = await runFlow(env, u, connectorUrl, { clientName: 'Claude', stopAt: 'code' })
    expect((await dtoOf(u, credential.id)).status).toBe('pending')
    const tok = await exchange(env, f.client, f.code, f.verifier)
    expect(tok.status, tok.text).toBe(200)
    expect(await dtoOf(u, credential.id)).toMatchObject({ status: 'connected', connected_client_hint: 'Claude' })

    // o uso aparece como último uso
    expect(await mcpStatus(env, pathOf(connectorUrl), tok.body.access_token)).toBe(200)
    expect((await dtoOf(u, credential.id)).last_used_at).not.toBeNull()
  })

  it('AC-T115-02 revogar a credencial invalida access e refresh na hora (401 no endpoint MCP, invalid_grant no refresh)', async () => {
    const u = await newOwner(env)
    const { credential, connectorUrl } = await newOAuthCredential(u)
    const f = await runFlow(env, u, connectorUrl)
    const path = pathOf(connectorUrl)
    const client = mcpAt(env, path, f.tokens.access_token)
    expect((await client.initialize()).status).toBe(200)
    expect(await mcpStatus(env, '/api/mcp', f.tokens.access_token)).toBe(200)

    const del = await u.c.delete(`/api/mcp_credentials/${credential.id}`)
    expect(del.status, del.text).toBe(200)

    expect((await client.send('tools/list', {})).status, 'access deveria cair na hora').toBe(401)
    expect(await mcpStatus(env, path, f.tokens.access_token)).toBe(401)
    expect(await mcpStatus(env, '/api/mcp', f.tokens.access_token)).toBe(401)
    expectOAuthError(await refresh(env, f.client, f.tokens.refresh_token), 'invalid_grant', 'refresh após revogar')
    // a URL do conector deixa de anunciar metadados
    expect((await raw(env, `/.well-known/oauth-protected-resource/api/mcp/${credential.id}`)).status).toBe(404)
    // e não aceita novo authorize
    const az = await authorize(env, { response_type: 'code', client_id: f.client.client_id, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: 'S256', resource: connectorUrl })
    expect(az.url?.searchParams.get('error')).toBe('invalid_target')
  })

  it('AC-T115-02 revogação pelo cliente (RFC 7009) derruba access e refresh e a credencial volta a pending', async () => {
    const u = await newOwner(env)
    const { credential, connectorUrl } = await newOAuthCredential(u)
    const f = await runFlow(env, u, connectorUrl)
    expect((await dtoOf(u, credential.id)).status).toBe('connected')

    const rv = await postForm(env, '/api/mcp-oauth/revoke', { token: f.tokens.refresh_token, client_id: f.client.client_id })
    expect(rv.status, rv.text).toBe(200)
    expect(await mcpStatus(env, pathOf(connectorUrl), f.tokens.access_token)).toBe(401)
    expectOAuthError(await refresh(env, f.client, f.tokens.refresh_token), 'invalid_grant', 'refresh revogado')
    expect(await dtoOf(u, credential.id)).toMatchObject({ status: 'pending', connected_client_hint: null })
    // token desconhecido também responde 200 (RFC 7009 §2.2)
    expect((await postForm(env, '/api/mcp-oauth/revoke', { token: 'crm_mcpat_nao-existe', client_id: f.client.client_id })).status).toBe(200)
  })
})

// ---------------------------------------------------------------- AC-T115-03

describe('T115 isolamento por empresa', () => {
  let a: User
  let b: User
  let seedA: Awaited<ReturnType<typeof seedCompany>>
  let seedB: Awaited<ReturnType<typeof seedCompany>>
  beforeAll(async () => {
    a = await newOwner(env)
    b = await newOwner(env)
    seedA = await seedCompany(env, a, 'Alfa')
    seedB = await seedCompany(env, b, 'Beta')
  })

  it('AC-T115-03 token OAuth vê só a empresa da credencial, com as mesmas 5 ferramentas somente leitura do T94', async () => {
    const { connectorUrl } = await newOAuthCredential(a)
    const f = await runFlow(env, a, connectorUrl)
    for (const path of [pathOf(connectorUrl), '/api/mcp']) {
      const client = mcpAt(env, path, f.tokens.access_token)
      expect((await client.initialize()).status, path).toBe(200)
      const tools = await client.listTools()
      expect(tools.map((t: Any) => t.name).sort(), path).toEqual(TOOLS)
      for (const t of tools) expect(t.annotations, t.name).toMatchObject({ readOnlyHint: true, destructiveHint: false })

      const contacts = toolData(await client.callTool('list_contacts', {})).contacts as Any[]
      expect(contacts.map((c) => c.id), path).toEqual([seedA.contactId])
      expect((toolData(await client.callTool('list_chats', {})).chats as Any[]).map((c) => c.id)).toEqual([seedA.chatId])
      expect((toolData(await client.callTool('list_connections', {})).connections as Any[]).map((c) => c.id)).toEqual([seedA.connectionId])
      const flows = (toolData(await client.callTool('list_flows', {})).flows as Any[]).map((x) => x.id)
      expect(flows).toContain(seedA.flowId)
      expect(flows).not.toContain(seedB.flowId)
      const foreign = await client.callTool('get_contact', { id: seedB.contactId })
      expect(foreign.isError).toBe(true)
      expect(JSON.stringify(foreign)).not.toContain('Contato Beta')
      // escrita inexistente
      expect((await client.callTool('delete_contact', { id: seedA.contactId })).isError).toBe(true)
    }
    const [ct] = await env.q(`SELECT name FROM crm.contacts WHERE id = $1`, [seedA.contactId])
    expect(ct).toMatchObject({ name: 'Contato Alfa' })
  })

  it('AC-T115-03 token de uma credencial não vale na URL de outra credencial (nem de outra empresa)', async () => {
    const credA = await newOAuthCredential(a)
    const credA2 = await newOAuthCredential(a)
    const credB = await newOAuthCredential(b)
    const f = await runFlow(env, a, credA.connectorUrl)
    expect(await mcpStatus(env, pathOf(credA.connectorUrl), f.tokens.access_token)).toBe(200)
    expect(await mcpStatus(env, pathOf(credA2.connectorUrl), f.tokens.access_token)).toBe(401)
    expect(await mcpStatus(env, pathOf(credB.connectorUrl), f.tokens.access_token)).toBe(401)
    // token estático também não entra pela URL de um conector OAuth
    const st = await newCredential(a)
    expect(await mcpStatus(env, pathOf(credA.connectorUrl), st.token)).toBe(401)
  })

  it('AC-T115-03 consentimento: sem vínculo com a empresa → 404; sem settings.mcp.edit → 403; empresa confirmada diferente → 422', async () => {
    const { connectorUrl } = await newOAuthCredential(a)
    const client = await newClient(env)
    const az = await authorize(env, { response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: 'S256', resource: connectorUrl })
    const request = az.url!.searchParams.get('request')!

    // dono de outra empresa: não vê o pedido nem aprova
    expect((await consentGet(b, request)).status).toBe(404)
    expect((await consentPost(b, { request, company_id: a.companyId, approve: true })).status).toBe(404)
    expect((await consentPost(b, { request, company_id: b.companyId, approve: true })).status).toBe(404)

    // membro de A só com view
    const viewer = await newMember(env, a.companyId, ['settings.mcp.view'])
    expect((await consentGet(viewer, request)).status).toBe(403)
    expect((await consentPost(viewer, { request, company_id: a.companyId, approve: true })).status).toBe(403)

    // usuário com vínculo em A e B (dono de B, editor em A) tenta apontar a empresa B
    const both = await newMember(env, a.companyId, ['settings.mcp.view', 'settings.mcp.edit'])
    await env.q(`INSERT INTO crm.company_members (company_id, user_id, role) VALUES ($1, $2, 'owner')`, [b.companyId, both.userId]).catch(() => {})
    const info = await consentGet(both, request)
    expect(info.status, info.text).toBe(200)
    expect(info.body.authorization_request.company.id).toBe(a.companyId)
    const wrong = await consentPost(both, { request, company_id: b.companyId, approve: true })
    expect(wrong.status, wrong.text).toBe(422)
    // o pedido segue válido: aprovar com a empresa certa gera código e o token só vê A
    const ok = await consentPost(both, { request, company_id: a.companyId, approve: true })
    expect(ok.status, ok.text).toBe(200)
    const [rec] = await env.q(`SELECT action, company_id FROM crm.audit_logs WHERE action = 'mcp_oauth.approve' AND company_id = $1 ORDER BY created_at DESC LIMIT 1`, [a.companyId])
    expect(rec).toBeTruthy()
  })

  it('AC-T115-03 resource fora das credenciais OAuth (genérico, static, outra URL) → invalid_target', async () => {
    const client = await newClient(env)
    const st = await newCredential(a)
    for (const resource of [undefined, `${API}/api/mcp`, `${API}/api/mcp/${st.credential.id}`, `https://outro.test/api/mcp/${st.credential.id}`]) {
      const r = await authorize(env, { response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: 'S256', resource })
      expect(r.status, `${resource}: ${r.text}`).toBe(302)
      expect(r.url!.searchParams.get('error'), String(resource)).toBe('invalid_target')
    }
  })
})

// ---------------------------------------------------------------- AC-T115-04

describe('T115 refresh token', () => {
  it('AC-T115-04 refresh rotaciona (novo par; o anterior não vale de novo)', async () => {
    const u = await newOwner(env)
    const { connectorUrl } = await newOAuthCredential(u)
    const f = await runFlow(env, u, connectorUrl)
    const r1 = await refresh(env, f.client, f.tokens.refresh_token)
    expect(r1.status, r1.text).toBe(200)
    expect(r1.body.access_token).toMatch(ACCESS_RE)
    expect(r1.body.refresh_token).toMatch(REFRESH_RE)
    expect(r1.body.access_token).not.toBe(f.tokens.access_token)
    expect(r1.body.refresh_token).not.toBe(f.tokens.refresh_token)
    expect(await mcpStatus(env, pathOf(connectorUrl), r1.body.access_token)).toBe(200)
    // refresh de outro cliente não vale
    const other = await newClient(env)
    expectOAuthError(await refresh(env, other, r1.body.refresh_token), 'invalid_grant', 'outro cliente')
    expect(await mcpStatus(env, pathOf(connectorUrl), r1.body.access_token)).toBe(200)
  })

  it('AC-T115-04 refresh usado duas vezes revoga a cadeia inteira (access e refresh novos caem); outra conexão segue valendo', async () => {
    const u = await newOwner(env)
    const { credential, connectorUrl } = await newOAuthCredential(u)
    const path = pathOf(connectorUrl)
    const f = await runFlow(env, u, connectorUrl, { clientName: 'Claude' })
    const other = await runFlow(env, u, connectorUrl, { clientName: 'Outro cliente' })

    const r1 = await refresh(env, f.client, f.tokens.refresh_token)
    expect(r1.status, r1.text).toBe(200)
    const r2 = await refresh(env, f.client, r1.body.refresh_token)
    expect(r2.status, r2.text).toBe(200)
    expect(await mcpStatus(env, path, r2.body.access_token)).toBe(200)

    // reuso do primeiro refresh (já rotacionado)
    expectOAuthError(await refresh(env, f.client, f.tokens.refresh_token), 'invalid_grant', 'reuso')
    for (const t of [f.tokens.access_token, r1.body.access_token, r2.body.access_token]) expect(await mcpStatus(env, path, t)).toBe(401)
    expectOAuthError(await refresh(env, f.client, r2.body.refresh_token), 'invalid_grant', 'refresh mais novo após reuso')
    expectOAuthError(await refresh(env, f.client, r1.body.refresh_token), 'invalid_grant', 'refresh do meio')

    // a outra conexão (outro grant da mesma credencial) não é afetada
    expect(await mcpStatus(env, path, other.tokens.access_token)).toBe(200)
    expect((await refresh(env, other.client, other.tokens.refresh_token)).status).toBe(200)
    expect((await dtoOf(u, credential.id)).status).toBe('connected')
  })

  it('AC-T115-04 reuso em corrida (dois refresh simultâneos com o mesmo token) também derruba a família', async () => {
    const u = await newOwner(env)
    const { connectorUrl } = await newOAuthCredential(u)
    const f = await runFlow(env, u, connectorUrl)
    const [x, y] = await Promise.all([refresh(env, f.client, f.tokens.refresh_token), refresh(env, f.client, f.tokens.refresh_token)])
    const winners = [x, y].filter((r) => r.status === 200)
    expect(winners.length, `${x.status} ${x.text} / ${y.status} ${y.text}`).toBeLessThanOrEqual(1)
    for (const w of winners) {
      expect(await mcpStatus(env, pathOf(connectorUrl), w.body.access_token)).toBe(401)
      expectOAuthError(await refresh(env, f.client, w.body.refresh_token), 'invalid_grant', 'refresh do vencedor')
    }
  })
})
