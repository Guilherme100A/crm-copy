// Afiliação (SPEC T97; 13-afiliacao.md): o app só leva ao portal externo de parceiros. A URL vem de
// `AFFILIATE_PORTAL_URL`, lida a cada request; só http/https valem — vazia ou inválida → null (a web não mostra nada).

/** Configuração pública do app em tempo de execução (`GET /api/app-config`). Extensível: a T108 acrescenta campos. */
export interface AppConfigDto {
  affiliate_portal_url: string | null
}

/** URL absoluta http/https, sem espaços nas pontas; qualquer outra coisa → null. */
export function parsePortalUrl(raw: string | undefined | null): string | null {
  const value = raw?.trim()
  if (!value) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!url.hostname) return null
  return url.toString()
}

/** Campos de afiliação da config do app, a partir do ambiente (default `process.env`). */
export function affiliateConfig(
  env: Record<string, string | undefined> = process.env,
): Pick<AppConfigDto, 'affiliate_portal_url'> {
  return { affiliate_portal_url: parsePortalUrl(env.AFFILIATE_PORTAL_URL) }
}
