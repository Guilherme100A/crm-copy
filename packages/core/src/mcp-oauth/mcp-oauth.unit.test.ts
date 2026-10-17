// OAuth MCP (T115), partes puras: PKCE S256 (vetor do RFC 7636 apêndice B), formatos de token e URLs/metadados.
import type { Database } from '@crm/db'
import { describe, expect, it } from 'vitest'
import { McpOAuthError, McpOAuthService } from './service'
import { generateSecret, isValidVerifier, MCP_OAUTH_ACCESS_PREFIX, MCP_OAUTH_TTL, s256, verifyPkce } from './tokens'

const svc = (env: Record<string, string | undefined>) => new McpOAuthService({ db: {} as Database, env })

describe('PKCE S256', () => {
  it('confere o vetor do RFC 7636 e recusa verifier ausente, curto ou errado', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
    expect(s256(verifier)).toBe(challenge)
    expect(verifyPkce(verifier, challenge)).toBe(true)
    expect(verifyPkce(undefined, challenge)).toBe(false)
    expect(verifyPkce('curto', challenge)).toBe(false)
    expect(verifyPkce(`${verifier.slice(0, -1)}A`, challenge)).toBe(false)
    // `plain` (verifier === challenge) não passa.
    expect(verifyPkce(challenge, challenge)).toBe(false)
    expect(isValidVerifier('a'.repeat(129))).toBe(false)
  })

  it('tokens opacos com prefixo e TTLs curtos para código e access', () => {
    const t = generateSecret(MCP_OAUTH_ACCESS_PREFIX)
    expect(t).toMatch(/^crm_mcpat_[\w-]{43}$/)
    expect(generateSecret(MCP_OAUTH_ACCESS_PREFIX)).not.toBe(t)
    expect(MCP_OAUTH_TTL.code).toBeLessThanOrEqual(600)
    expect(MCP_OAUTH_TTL.access).toBeLessThan(MCP_OAUTH_TTL.refresh)
  })
})

describe('URLs e metadados', () => {
  it('conector, resource_metadata e issuer a partir do ambiente', () => {
    const s = svc({ API_PUBLIC_URL: 'https://api.x.test/', WEB_PUBLIC_URL: 'https://app.x.test' })
    expect(s.connectorUrl('c1')).toBe('https://api.x.test/api/mcp/c1')
    expect(s.resourceMetadataUrl('c1')).toBe('https://api.x.test/.well-known/oauth-protected-resource/api/mcp/c1')
    expect(s.resourceMetadataUrl(null)).toBe('https://api.x.test/.well-known/oauth-protected-resource/api/mcp')
    expect(s.issuer()).toBe('https://api.x.test')
    expect(svc({ API_PUBLIC_URL: 'https://api.x.test', MCP_OAUTH_ISSUER: 'https://auth.x.test/' }).issuer()).toBe(
      'https://auth.x.test',
    )
  })

  it('metadados RFC 8414 anunciam só S256, code e os endpoints da API', () => {
    const m = svc({ API_PUBLIC_URL: 'https://api.x.test' }).authorizationServerMetadata()
    expect(m).toMatchObject({
      issuer: 'https://api.x.test',
      authorization_endpoint: 'https://api.x.test/api/mcp-oauth/authorize',
      token_endpoint: 'https://api.x.test/api/mcp-oauth/token',
      registration_endpoint: 'https://api.x.test/api/mcp-oauth/register',
      revocation_endpoint: 'https://api.x.test/api/mcp-oauth/revoke',
      code_challenge_methods_supported: ['S256'],
      response_types_supported: ['code'],
    })
  })

  it('registro recusa redirect_uri http fora de loopback e método de autenticação desconhecido', async () => {
    const s = svc({})
    await expect(s.register({ redirect_uris: ['http://evil.test/cb'] })).rejects.toMatchObject({
      error: 'invalid_redirect_uri',
    })
    await expect(s.register({ redirect_uris: ['https://ok.test/cb#x'] })).rejects.toBeInstanceOf(McpOAuthError)
    await expect(
      s.register({ redirect_uris: ['https://ok.test/cb'], token_endpoint_auth_method: 'private_key_jwt' }),
    ).rejects.toMatchObject({ error: 'invalid_client_metadata' })
    await expect(s.register({})).rejects.toMatchObject({ error: 'invalid_client_metadata' })
  })
})
