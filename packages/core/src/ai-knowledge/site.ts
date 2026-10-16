// Leitura de site para a base de conhecimento (T52): SSRF-safe pelo `safeHttpRequest` da T42 (IP validado no lookup
// do socket e a cada redirect). Lê a URL e até `maxPages - 1` links do mesmo host. Rede interna → `site_unreachable`
// com detalhe `ssrf_blocked`; fora do ar/HTTP de erro → `site_unreachable`; sem texto → `empty_site`.
import { HttpRequestError, safeHttpRequest, type SafeHttpOptions } from '../flows/nodes/external/http'
import { htmlTitle, htmlToText, KnowledgeIngestError, normalizeKnowledgeText, sameHostLinks } from './extract'

export const SITE_MAX_PAGES = 5
export const SITE_MAX_PAGE_BYTES = 2 * 1024 * 1024
export const SITE_TIMEOUT_MS = 15_000

export interface SitePage {
  url: string
  title: string | null
  text: string
}

async function fetchPage(url: string, http: SafeHttpOptions): Promise<{ url: string; html: string; isHtml: boolean }> {
  const res = await safeHttpRequest(
    { method: 'GET', url, headers: { 'user-agent': 'CRM-Knowledge/1.0', accept: 'text/html,text/plain;q=0.9,*/*;q=0.5' } },
    { timeoutMs: SITE_TIMEOUT_MS, maxResponseBytes: SITE_MAX_PAGE_BYTES, ...http },
  )
  if (res.status >= 400) throw new KnowledgeIngestError('site_unreachable', `HTTP ${res.status}`, `http_${res.status}`)
  const type = (res.headers['content-type'] ?? '').toLowerCase()
  return { url: res.url, html: res.body, isHtml: !type || type.includes('html') }
}

export async function readSite(url: string, opts: { http?: SafeHttpOptions; maxPages?: number } = {}): Promise<SitePage[]> {
  const http = opts.http ?? {}
  let first: Awaited<ReturnType<typeof fetchPage>>
  try {
    first = await fetchPage(url, http)
  } catch (err) {
    if (err instanceof KnowledgeIngestError) throw err
    if (err instanceof HttpRequestError) throw new KnowledgeIngestError('site_unreachable', err.message, err.reason)
    throw new KnowledgeIngestError('site_unreachable', err instanceof Error ? err.message : String(err), 'network_error')
  }
  const toPage = (p: { url: string; html: string; isHtml: boolean }): SitePage => ({
    url: p.url,
    title: p.isHtml ? htmlTitle(p.html) : null,
    text: p.isHtml ? htmlToText(p.html) : normalizeKnowledgeText(p.html),
  })
  const pages = [toPage(first)]
  const links = first.isHtml ? sameHostLinks(first.html, new URL(first.url)) : []
  for (const link of links.slice(0, (opts.maxPages ?? SITE_MAX_PAGES) - 1)) {
    try {
      pages.push(toPage(await fetchPage(link, http)))
    } catch {
      // Página interna com erro não derruba a leitura do site.
    }
  }
  const read = pages.filter((p) => p.text)
  if (!read.length) throw new KnowledgeIngestError('empty_site', 'o site não tem texto legível')
  return read
}
