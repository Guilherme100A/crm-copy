// GraphClient contra o FakeMetaGraph (AC-T99-01): paginação por `paging.next`, `appsecret_proof` e versão em toda
// requisição, erros da Graph mapeados e `paging.next` de outra origem recusado.
import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeMetaGraph } from './testing'
import { appsecretProof, GraphClient, META_GRAPH_VERSION, MetaGraphError, parseGraphUrl } from './graph'

const fake = new FakeMetaGraph({ appSecret: 'segredo-app', pageSize: 2 })
let url: string

beforeAll(async () => {
  url = (await fake.start()).url
})
afterAll(async () => {
  await fake.close()
})

describe('parseGraphUrl / appsecretProof', () => {
  it('separa a versão do META_GRAPH_URL e usa v26.0 por padrão', () => {
    expect(parseGraphUrl('https://graph.facebook.com/v26.0')).toEqual({ graphUrl: 'https://graph.facebook.com', version: 'v26.0' })
    expect(parseGraphUrl('http://127.0.0.1:9/')).toEqual({ graphUrl: 'http://127.0.0.1:9', version: META_GRAPH_VERSION })
    expect(parseGraphUrl(undefined)).toEqual({ graphUrl: 'https://graph.facebook.com', version: 'v26.0' })
  })

  it('appsecret_proof = HMAC-SHA256(token, secret) em hex', () => {
    expect(appsecretProof('tok', 'sec')).toBe(createHmac('sha256', 'sec').update('tok').digest('hex'))
  })
})

describe('GraphClient × FakeMetaGraph', () => {
  it('AC-T99-01: getAll segue paging.next e junta 3 páginas; toda requisição leva appsecret_proof e a versão', async () => {
    fake.addUser({
      id: 'u1',
      name: 'Ana',
      adAccounts: [1, 2, 3, 4, 5].map((n) => ({ id: `act_${n}`, name: `Conta ${n}`, currency: 'BRL', account_status: 1 })),
    })
    const token = fake.issueToken('u1')
    const graph = new GraphClient({ graphUrl: url, appSecret: 'segredo-app', accessToken: token })
    fake.requests.length = 0
    const accounts = await graph.getAll<{ id: string }>('me/adaccounts', { fields: 'id,name' })
    expect(accounts.map((a) => a.id)).toEqual(['act_1', 'act_2', 'act_3', 'act_4', 'act_5'])
    expect(fake.requests).toHaveLength(3)
    for (const r of fake.requests) {
      expect(r.version).toBe('v26.0')
      expect(r.path.startsWith('/v26.0/')).toBe(true)
      expect(r.query.access_token).toBe(token)
      expect(r.query.appsecret_proof).toBe(appsecretProof(token, 'segredo-app'))
    }
  })

  it('versão configurável e get simples', async () => {
    fake.addUser({ id: 'u2', name: 'Bia', pictureUrl: 'https://x/p.jpg', adAccounts: [] })
    const graph = new GraphClient({ graphUrl: `${url}/v25.0`, appSecret: 'segredo-app' })
    const me = await graph.get<{ id: string; picture: { data: { url: string } } }>('me', { fields: 'id,name,picture{url}' }, { accessToken: fake.issueToken('u2') })
    expect(me).toMatchObject({ id: 'u2', picture: { data: { url: 'https://x/p.jpg' } } })
    expect(fake.requests.at(-1)!.version).toBe('v25.0')
  })

  it('erros da Graph viram MetaGraphError com code, status e fbtrace_id; token inválido é isTokenError', async () => {
    const graph = new GraphClient({ graphUrl: url, appSecret: 'segredo-app', accessToken: 'nao-existe' })
    const err = await graph.get('me').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MetaGraphError)
    expect(err).toMatchObject({ status: 400, code: 190, type: 'OAuthException', fbtraceId: expect.stringMatching(/^trace-/) })
    expect((err as MetaGraphError).isTokenError).toBe(true)

    const wrongSecret = new GraphClient({ graphUrl: url, appSecret: 'outro', accessToken: fake.issueToken('u1') })
    await expect(wrongSecret.get('me')).rejects.toMatchObject({ code: 100 })

    fake.failNext(400, { message: 'User request limit reached', type: 'OAuthException', code: 17, error_subcode: 2446079, fbtrace_id: 'abc' })
    const limited = await new GraphClient({ graphUrl: url, appSecret: 'segredo-app', accessToken: fake.issueToken('u1') }).get('me').catch((e: unknown) => e)
    expect(limited).toMatchObject({ code: 17, subcode: 2446079, fbtraceId: 'abc' })
    expect((limited as MetaGraphError).isRateLimit).toBe(true)
  })

  it('rede fora do ar → MetaGraphError network; paging.next de outra origem é recusado', async () => {
    const down = new GraphClient({ graphUrl: 'http://127.0.0.1:1', appSecret: 's', accessToken: 't', timeoutMs: 2000 })
    await expect(down.get('me')).rejects.toMatchObject({ name: 'MetaGraphError', code: 'network' })

    const evil: typeof fetch = async () => new Response(JSON.stringify({ data: [{ id: 1 }], paging: { next: 'https://evil.example/v26.0/me/adaccounts?after=2' } }), { status: 200 })
    const graph = new GraphClient({ graphUrl: 'https://graph.facebook.com', appSecret: 's', accessToken: 't', fetch: evil })
    await expect(graph.getAll('me/adaccounts')).rejects.toMatchObject({ code: 'foreign_next' })
  })
})
