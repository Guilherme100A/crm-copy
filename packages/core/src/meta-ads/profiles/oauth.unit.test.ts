// `state` assinado do OAuth (T99): empresa + usuário + perfil, expira, não aceita adulteração nem outra chave.
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { metaConfigFromEnv, oauthDialogUrl, signOAuthState, verifyOAuthState } from './oauth'

const key = randomBytes(32)

describe('state do OAuth', () => {
  it('ida e volta com empresa, usuário e perfil', () => {
    const state = signOAuthState(key, { companyId: 'c1', userId: 'u1', profileId: 'p1' }, 1_000)
    expect(verifyOAuthState(key, state, 2_000)).toMatchObject({ companyId: 'c1', userId: 'u1', profileId: 'p1' })
  })

  it('adulterado, assinado com outra chave, expirado ou malformado → null', () => {
    const state = signOAuthState(key, { companyId: 'c1', userId: 'u1', profileId: null }, 1_000)
    const [body, mac] = state.split('.')
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), companyId: 'c2' })).toString('base64url')
    expect(verifyOAuthState(key, `${forged}.${mac}`, 2_000)).toBeNull()
    expect(verifyOAuthState(randomBytes(32), state, 2_000)).toBeNull()
    expect(verifyOAuthState(key, state, 1_000 + 16 * 60_000)).toBeNull()
    for (const bad of ['', 'x', 'a.b.c', null, undefined]) expect(verifyOAuthState(key, bad as string, 2_000)).toBeNull()
  })
})

describe('config e URL do diálogo', () => {
  it('lê o ambiente; redirect padrão no API_PUBLIC_URL; URL com versão, client_id, state e escopos', () => {
    const config = metaConfigFromEnv({ META_APP_ID: 'app', META_APP_SECRET: 's', META_GRAPH_URL: 'https://graph.facebook.com/v26.0', API_PUBLIC_URL: 'https://api.x/' })
    expect(config).toMatchObject({ appId: 'app', graphUrl: 'https://graph.facebook.com', version: 'v26.0', redirectUri: 'https://api.x/api/meta/oauth/callback' })
    const url = new URL(oauthDialogUrl(config, 'st'))
    expect(url.origin + url.pathname).toBe('https://www.facebook.com/v26.0/dialog/oauth')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: 'app', state: 'st', response_type: 'code', redirect_uri: 'https://api.x/api/meta/oauth/callback', scope: 'ads_read,ads_management,business_management' })
  })
})
