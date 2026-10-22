/* eslint-disable @typescript-eslint/no-explicit-any -- respostas JSON lidas como dados soltos */
// OAuth do servidor MCP (T115) com um cliente de teste LOCAL: os helpers `client/auth` do SDK falam com o app por
// `app.request()` (nunca rede nem o Claude real). Cobre descoberta pelo 401, registro dinâmico, consentimento,
// PKCE S256, refresh com rotação, reuso que revoga a família, revogação e isolamento por empresa.
import { randomBytes } from 'node:crypto'
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  extractWWWAuthenticateParams,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationFull, OAuthMetadata } from '@modelcontextprotocol/sdk/shared/auth.js'
import { companyMembers, contacts, createDb, mcpOauthClients, mcpOauthTokens, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createLogger, MemoryMailer, redisConnection } from '@crm/node-kit'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type RedisClient } from '../../app'

const API = 'https://api.crm.test'
const WEB = 'https://web.crm.test'
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>
const rnd = () => randomBytes(4).toString('hex')
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }
const fetchFn = async (url: string | URL, init?: RequestInit) => app.request(String(url), init)

interface Session {
  cookie: string
  companyId: string
  userId: string
}
async function signUp(): Promise<Session> {
  const email = `o-${rnd()}@x.com`
  const ip = { 'x-forwarded-for': `10.115.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
  const reg = await app.request('/api/auth/register', {
    method: 'POST',
    headers: { ...H, ...ip },
    body: JSON.stringify({ name: 'O', email, password: '12345678', password_confirmation: '12345678' }),
  })
  const { user } = (await reg.json()) as any
  const login = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { ...H, ...ip },
    body: JSON.stringify({ email, password: '12345678' }),
  })
  return {
    cookie: /crm_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')![0],
    companyId: user.last_company_id,
    userId: user.id,
  }
}
const call = async (s: Session, method: string, path: string, body?: unknown) => {
  const res = await app.request(path, {
    method,
    headers: { ...H, cookie: s.cookie },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  return { status: res.status, body: text ? (JSON.parse(text) as any) : {} }
}
let seq = 0
async function rpc(url: string, token: string | null, method: string, params: Record<string, unknown> = {}) {
  const res = await app.request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }),
  })
  const text = await res.text()
  return { status: res.status, res, body: text ? (JSON.parse(text) as any) : {} }
}
const form = async (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) => {
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields).toString(),
  })
  return { status: res.status, body: (await res.json()) as any }
}

async function createOAuthCredential(s: Session, name = 'Claude') {
  const r = await call(s, 'POST', '/api/mcp_credentials', { mcp_credential: { name, auth_type: 'oauth' } })
  expect(r.status).toBe(201)
  return r.body.mcp_credential as { id: string; connector_url: string; status: string }
}

interface Connected {
  metadata: OAuthMetadata
  client: OAuthClientInformationFull
  connector: string
  tokens: { access_token: string; refresh_token?: string }
}

/** Fluxo inteiro do cliente: 401 → metadados → registro → authorize → consentimento → código → token. */
async function connect(
  s: Session,
  connector: string,
  clientName = 'Claude',
  authMethod = 'client_secret_post',
): Promise<Connected> {
  const unauth = await rpc(connector, null, 'tools/list')
  expect(unauth.status).toBe(401)
  const { resourceMetadataUrl } = extractWWWAuthenticateParams(unauth.res)
  const prm = await discoverOAuthProtectedResourceMetadata(connector, { resourceMetadataUrl }, fetchFn)
  const issuer = prm.authorization_servers![0]!
  const metadata = (await discoverAuthorizationServerMetadata(issuer, { fetchFn })) as OAuthMetadata
  const client = await registerClient(issuer, {
    metadata,
    clientMetadata: { client_name: clientName, redirect_uris: [REDIRECT], token_endpoint_auth_method: authMethod },
    fetchFn,
  })
  const { authorizationUrl, codeVerifier } = await startAuthorization(issuer, {
    metadata,
    clientInformation: client,
    redirectUrl: REDIRECT,
    scope: 'mcp:read',
    state: 'st-1',
    resource: new URL(prm.resource),
  })
  const code = await approve(s, authorizationUrl.toString())
  const tokens = await exchangeAuthorization(issuer, {
    metadata,
    clientInformation: client,
    authorizationCode: code,
    codeVerifier,
    redirectUri: REDIRECT,
    resource: new URL(prm.resource),
    fetchFn,
  })
  return { metadata, client, connector, tokens }
}

/** Abre o `/authorize`, segue para a tela de consentimento e aprova; devolve o código. */
async function approve(s: Session, authorizationUrl: string): Promise<string> {
  const auth = await app.request(authorizationUrl)
  expect(auth.status).toBe(302)
  const consent = new URL(auth.headers.get('location')!)
  expect(`${consent.origin}${consent.pathname}`).toBe(`${WEB}/oauth/consent`)
  const request = consent.searchParams.get('request')!
  const info = await call(s, 'GET', `/api/mcp-oauth/consent?request=${request}`)
  expect(info.status).toBe(200)
  const decided = await call(s, 'POST', '/api/mcp-oauth/consent', {
    request,
    company_id: info.body.authorization_request.company.id,
    approve: true,
  })
  expect(decided.status).toBe(200)
  const back = new URL(decided.body.redirect_to)
  expect(`${back.origin}${back.pathname}`).toBe(REDIRECT)
  expect(back.searchParams.get('state')).toBe('st-1')
  expect(back.searchParams.get('iss')).toBe(API)
  return back.searchParams.get('code')!
}

/** Pedido de autorização feito à mão (para os casos de erro). */
async function manualAuthorize(
  client: OAuthClientInformationFull,
  resource: string,
  extra: Record<string, string> = {},
) {
  const verifier = randomBytes(40).toString('base64url')
  const { createHash } = await import('node:crypto')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st-1',
    resource,
    ...extra,
  })
  return { url: `/api/mcp-oauth/authorize?${q}`, verifier }
}

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  app = createApp({
    db,
    redis,
    mailer: new MemoryMailer(),
    trustProxy: true,
    logger: createLogger({ level: 'silent' }),
    mcpEnv: { API_PUBLIC_URL: API, WEB_PUBLIC_URL: WEB },
  })
}, 120_000)

afterAll(async () => {
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
})

describe('metadados e descoberta', () => {
  it('servidor de autorização (RFC 8414) e recurso protegido (RFC 9728) públicos, com CORS', async () => {
    const as = await app.request('/.well-known/oauth-authorization-server', {
      headers: { origin: 'https://claude.ai' },
    })
    expect(as.status).toBe(200)
    expect(as.headers.get('access-control-allow-origin')).toBe('*')
    expect(await as.json()).toMatchObject({
      issuer: API,
      authorization_endpoint: `${API}/api/mcp-oauth/authorize`,
      token_endpoint: `${API}/api/mcp-oauth/token`,
      registration_endpoint: `${API}/api/mcp-oauth/register`,
      revocation_endpoint: `${API}/api/mcp-oauth/revoke`,
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
    })
    expect(await (await app.request('/.well-known/oauth-protected-resource/api/mcp')).json()).toMatchObject({
      resource: `${API}/api/mcp`,
      authorization_servers: [API],
    })
    expect((await app.request(`/.well-known/oauth-protected-resource/api/mcp/${crypto.randomUUID()}`)).status).toBe(404)
    const pre = await app.request('/api/mcp-oauth/token', {
      method: 'OPTIONS',
      headers: { origin: 'https://claude.ai', 'access-control-request-method': 'POST' },
    })
    expect(pre.status).toBe(204)
  })

  it('401 do endpoint MCP aponta os metadados do recurso (genérico e do conector)', async () => {
    const s = await signUp()
    const cred = await createOAuthCredential(s)
    expect(cred).toMatchObject({ status: 'pending', connector_url: `${API}/api/mcp/${cred.id}` })
    const generic = await rpc('/api/mcp', null, 'tools/list')
    expect(generic.res.headers.get('www-authenticate')).toBe(
      `Bearer realm="mcp", resource_metadata="${API}/.well-known/oauth-protected-resource/api/mcp"`,
    )
    const conn = await rpc(`/api/mcp/${cred.id}`, null, 'tools/list')
    expect(conn.status).toBe(401)
    expect(extractWWWAuthenticateParams(conn.res).resourceMetadataUrl?.toString()).toBe(
      `${API}/.well-known/oauth-protected-resource/api/mcp/${cred.id}`,
    )
    expect(await (await app.request(`/.well-known/oauth-protected-resource/api/mcp/${cred.id}`)).json()).toMatchObject({
      resource: cred.connector_url,
      authorization_servers: [API],
    })
  })
})

describe('fluxo do cliente', () => {
  it('registro → authorize → consentimento → token com PKCE → token aceito no endpoint MCP; credencial pending → connected', async () => {
    const s = await signUp()
    const cred = await createOAuthCredential(s)
    const c = await connect(s, cred.connector_url)
    expect(c.tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'mcp:read' })
    expect(c.tokens.access_token).toMatch(/^crm_mcpat_/)
    expect(c.tokens.refresh_token).toMatch(/^crm_mcprt_/)
    // Hash no banco, nunca o token cru.
    const rows = await db.select().from(mcpOauthTokens)
    expect(JSON.stringify(rows)).not.toContain(c.tokens.access_token)
    expect(JSON.stringify(rows)).not.toContain(c.tokens.refresh_token)
    const [client] = await db.select().from(mcpOauthClients).where(eq(mcpOauthClients.clientId, c.client.client_id))
    expect(client!.clientSecretHash).not.toBe(c.client.client_secret)

    const tools = await rpc(`/api/mcp/${cred.id}`, c.tokens.access_token, 'tools/list')
    expect(tools.status).toBe(200)
    // Credencial `read` (padrão): as da T94 mais as de leitura via API, como quem autorizou; nenhuma grava.
    const listed = tools.body.result.tools as any[]
    expect(listed.map((t) => t.name)).toEqual(expect.arrayContaining(['get_contact', 'list_chats', 'list_connections', 'list_contacts', 'list_flows']))
    for (const t of listed) expect(t.annotations.readOnlyHint).toBe(true)
    expect((await rpc('/api/mcp', c.tokens.access_token, 'tools/list')).status).toBe(200)

    const list = (await call(s, 'GET', '/api/mcp_credentials')).body.mcp_credentials
    expect(list.find((x: any) => x.id === cred.id)).toMatchObject({
      status: 'connected',
      connected_client_hint: 'Claude',
      expires_at: null,
    })
    expect(list.find((x: any) => x.id === cred.id).last_used_at).not.toBeNull()
  })

  it('PKCE: plain ou sem challenge → invalid_request; verifier ausente ou errado → invalid_grant; código é de uso único', async () => {
    const s = await signUp()
    const cred = await createOAuthCredential(s)
    const client = (await (
      await app.request('/api/mcp-oauth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: 'Teste', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
      })
    ).json()) as any
    expect(client.client_secret).toBeUndefined()

    const plain = await app.request(
      (await manualAuthorize(client, cred.connector_url, { code_challenge_method: 'plain' })).url,
    )
    expect(new URL(plain.headers.get('location')!).searchParams.get('error')).toBe('invalid_request')
    const noChallenge = new URL((await manualAuthorize(client, cred.connector_url)).url, API)
    noChallenge.searchParams.delete('code_challenge')
    expect(
      new URL((await app.request(noChallenge.toString())).headers.get('location')!).searchParams.get('error'),
    ).toBe('invalid_request')
    const badResource = await app.request((await manualAuthorize(client, `${API}/api/mcp`)).url)
    expect(new URL(badResource.headers.get('location')!).searchParams.get('error')).toBe('invalid_target')
    const badRedirect = await app.request(
      (await manualAuthorize(client, cred.connector_url, { redirect_uri: 'https://evil.test/cb' })).url,
    )
    expect(badRedirect.status).toBe(400)
    expect(await badRedirect.json()).toMatchObject({ error: 'invalid_request' })

    const { url, verifier } = await manualAuthorize(client, cred.connector_url)
    const code = await approve(s, `${API}${url}`)
    const base = { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: client.client_id }
    expect(await form('/api/mcp-oauth/token', base)).toEqual({
      status: 400,
      body: { error: 'invalid_grant', error_description: expect.any(String) },
    })
    expect(
      (await form('/api/mcp-oauth/token', { ...base, code_verifier: randomBytes(40).toString('base64url') })).body
        .error,
    ).toBe('invalid_grant')
    expect(
      (
        await form('/api/mcp-oauth/token', {
          ...base,
          code_verifier: verifier,
          redirect_uri: 'https://claude.ai/outro',
        })
      ).body.error,
    ).toBe('invalid_grant')
    const ok = await form('/api/mcp-oauth/token', { ...base, code_verifier: verifier })
    expect(ok.status).toBe(200)
    // Reuso do código → invalid_grant e o que foi emitido com ele cai.
    expect((await form('/api/mcp-oauth/token', { ...base, code_verifier: verifier })).body.error).toBe('invalid_grant')
    expect((await rpc(cred.connector_url, ok.body.access_token, 'tools/list')).status).toBe(401)
  })

  it('cliente confidencial: segredo errado → invalid_client (401)', async () => {
    const s = await signUp()
    const cred = await createOAuthCredential(s)
    const c = await connect(s, cred.connector_url, 'Claude', 'client_secret_basic')
    const basic = (secret: string) =>
      `Basic ${Buffer.from(`${encodeURIComponent(c.client.client_id)}:${encodeURIComponent(secret)}`).toString('base64')}`
    const bad = await form(
      '/api/mcp-oauth/token',
      { grant_type: 'refresh_token', refresh_token: c.tokens.refresh_token! },
      { authorization: basic('errado') },
    )
    expect(bad).toMatchObject({ status: 401, body: { error: 'invalid_client' } })
    const good = await form(
      '/api/mcp-oauth/token',
      { grant_type: 'refresh_token', refresh_token: c.tokens.refresh_token! },
      { authorization: basic(c.client.client_secret!) },
    )
    expect(good.status).toBe(200)
    expect(
      (await form('/api/mcp-oauth/token', { grant_type: 'password', client_id: c.client.client_id })).body.error,
    ).toBe('unsupported_grant_type')
  })
})

describe('refresh, reuso e revogação', () => {
  it('AC-04: refresh rotaciona; o refresh antigo reapresentado revoga a família inteira', async () => {
    const s = await signUp()
    const cred = await createOAuthCredential(s)
    const c = await connect(s, cred.connector_url)
    const issuer = API
    const next = await refreshAuthorization(issuer, {
      metadata: c.metadata,
      clientInformation: c.client,
      refreshToken: c.tokens.refresh_token!,
      fetchFn,
    })
    expect(next.refresh_token).not.toBe(c.tokens.refresh_token)
    expect((await rpc(cred.connector_url, next.access_token, 'tools/list')).status).toBe(200)

    const reuse = await form('/api/mcp-oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: c.tokens.refresh_token!,
      client_id: c.client.client_id,
      client_secret: c.client.client_secret!,
    })
    expect(reuse.body.error).toBe('invalid_grant')
    expect((await rpc(cred.connector_url, next.access_token, 'tools/list')).status).toBe(401)
    expect(
      (
        await form('/api/mcp-oauth/token', {
          grant_type: 'refresh_token',
          refresh_token: next.refresh_token!,
          client_id: c.client.client_id,
          client_secret: c.client.client_secret!,
        })
      ).body.error,
    ).toBe('invalid_grant')
    expect((await call(s, 'GET', '/api/mcp_credentials')).body.mcp_credentials[0]).toMatchObject({
      status: 'pending',
      connected_client_hint: null,
    })
  })

  it('AC-02: revogar a credencial invalida access e refresh na hora; /revoke derruba a conexão', async () => {
    const s = await signUp()
    const cred = await createOAuthCredential(s)
    const c = await connect(s, cred.connector_url)
    expect((await call(s, 'DELETE', `/api/mcp_credentials/${cred.id}`)).status).toBe(200)
    expect((await rpc(cred.connector_url, c.tokens.access_token, 'tools/list')).status).toBe(401)
    expect(
      (
        await form('/api/mcp-oauth/token', {
          grant_type: 'refresh_token',
          refresh_token: c.tokens.refresh_token!,
          client_id: c.client.client_id,
          client_secret: c.client.client_secret!,
        })
      ).body.error,
    ).toBe('invalid_grant')
    expect((await app.request(`/.well-known/oauth-protected-resource/api/mcp/${cred.id}`)).status).toBe(404)

    const cred2 = await createOAuthCredential(s, 'Claude 2')
    const c2 = await connect(s, cred2.connector_url)
    const revoked = await form('/api/mcp-oauth/revoke', {
      token: c2.tokens.refresh_token!,
      token_type_hint: 'refresh_token',
      client_id: c2.client.client_id,
      client_secret: c2.client.client_secret!,
    })
    expect(revoked.status).toBe(200)
    expect((await rpc(cred2.connector_url, c2.tokens.access_token, 'tools/list')).status).toBe(401)
    expect(
      (
        await form('/api/mcp-oauth/revoke', {
          token: 'qualquer',
          client_id: c2.client.client_id,
          client_secret: c2.client.client_secret!,
        })
      ).status,
    ).toBe(200)
  })
})

describe('empresa e consentimento', () => {
  it('AC-03: o token só lê a empresa da credencial; não vale no conector de outra credencial', async () => {
    const a = await signUp()
    const b = await signUp()
    await db
      .insert(contacts)
      .values({
        companyId: a.companyId,
        name: 'Contato A',
        phoneE164: `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
      })
    await db
      .insert(contacts)
      .values({
        companyId: b.companyId,
        name: 'Contato B',
        phoneE164: `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
      })
    const credA = await createOAuthCredential(a)
    const credB = await createOAuthCredential(b)
    const c = await connect(a, credA.connector_url)
    const r = await rpc(credA.connector_url, c.tokens.access_token, 'tools/call', {
      name: 'list_contacts',
      arguments: {},
    })
    expect(JSON.parse(r.body.result.content[0].text).contacts.map((x: any) => x.name)).toEqual(['Contato A'])
    expect((await rpc(credB.connector_url, c.tokens.access_token, 'tools/list')).status).toBe(401)
    const write = await rpc(credA.connector_url, c.tokens.access_token, 'tools/call', {
      name: 'delete_contact',
      arguments: {},
    })
    expect(write.body.result?.isError ?? !!write.body.error).toBe(true)
  })

  it('consentimento: sem vínculo → 404; sem settings.mcp.edit → 403; empresa diferente → 422; negar → access_denied', async () => {
    const owner = await signUp()
    const cred = await createOAuthCredential(owner)
    const client = (await (
      await app.request('/api/mcp-oauth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
      })
    ).json()) as any
    const start = async () =>
      new URL(
        (await app.request((await manualAuthorize(client, cred.connector_url)).url)).headers.get('location')!,
      ).searchParams.get('request')!

    const stranger = await signUp()
    expect((await call(stranger, 'GET', `/api/mcp-oauth/consent?request=${await start()}`)).status).toBe(404)
    const viewer = await signUp()
    await db
      .insert(companyMembers)
      .values({
        companyId: owner.companyId,
        userId: viewer.userId,
        role: 'member',
        permissionKeys: ['settings.mcp.view'],
      })
    await db.update(users).set({ lastCompanyId: owner.companyId }).where(eq(users.id, viewer.userId))
    expect((await call(viewer, 'GET', `/api/mcp-oauth/consent?request=${await start()}`)).status).toBe(403)

    const req = await start()
    const info = await call(owner, 'GET', `/api/mcp-oauth/consent?request=${req}`)
    expect(info.body.authorization_request).toMatchObject({
      client: { name: 'Claude', redirect_uri: REDIRECT },
      credential: { id: cred.id, name: 'Claude' },
      company: { id: owner.companyId },
    })
    expect(
      (
        await call(owner, 'POST', '/api/mcp-oauth/consent', {
          request: req,
          company_id: stranger.companyId,
          approve: true,
        })
      ).status,
    ).toBe(422)
    const denied = await call(owner, 'POST', '/api/mcp-oauth/consent', { request: req, approve: false })
    expect(new URL(denied.body.redirect_to).searchParams.get('error')).toBe('access_denied')
    expect(
      (
        await call(owner, 'POST', '/api/mcp-oauth/consent', {
          request: req,
          company_id: owner.companyId,
          approve: true,
        })
      ).status,
    ).toBe(404)
    // Sem sessão a tela de consentimento não abre; sem X-Requested-With a aprovação é recusada (CSRF).
    expect((await app.request(`/api/mcp-oauth/consent?request=${req}`)).status).toBe(401)
    const noCsrf = await app.request('/api/mcp-oauth/consent', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: owner.cookie },
      body: JSON.stringify({ request: await start(), approve: false }),
    })
    expect(noCsrf.status).toBe(403)
  })
})
