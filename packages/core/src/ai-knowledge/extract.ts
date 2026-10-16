// Extração de texto das fontes de conhecimento (T52): PDF (unpdf/pdf.js, STACK adendo T52), HTML de site e divisão
// em trechos para o índice textual. Erros viram os códigos de 07 §3.4 (`KnowledgeIngestError`).
import { extractText, getDocumentProxy } from 'unpdf'

/** Códigos de falha da ingestão (07 §3.4) gravados em `error_message`. */
export type KnowledgeFailureCode =
  | 'generic'
  | 'empty'
  | 'empty_pdf'
  | 'encrypted_pdf'
  | 'unreadable_pdf'
  | 'not_pdf'
  | 'site_unreachable'
  | 'empty_site'
  | 'flow_missing'
  | 'file_missing'

export class KnowledgeIngestError extends Error {
  constructor(
    readonly code: KnowledgeFailureCode,
    message: string,
    readonly detail: string | null = null,
  ) {
    super(message)
    this.name = 'KnowledgeIngestError'
  }
}

export const isPdfHeader = (data: Uint8Array) => Buffer.from(data.subarray(0, 1024)).toString('latin1').includes('%PDF-')

/** Texto por página. Senha → `encrypted_pdf`; estrutura inválida → `unreadable_pdf`; sem texto → `empty_pdf`. */
export async function extractPdfPages(data: Uint8Array): Promise<{ totalPages: number; pages: string[] }> {
  if (!isPdfHeader(data)) throw new KnowledgeIngestError('not_pdf', 'o arquivo não é um PDF')
  let result: { totalPages: number; text: string[] }
  try {
    // Cópia: o pdf.js transfere (desanexa) o buffer recebido.
    const pdf = await getDocumentProxy(new Uint8Array(data), { verbosity: 0 })
    try {
      result = await extractText(pdf, { mergePages: false })
    } finally {
      await pdf.loadingTask.destroy().catch(() => undefined)
    }
  } catch (err) {
    const name = (err as { name?: string } | null)?.name ?? ''
    if (name === 'PasswordException') throw new KnowledgeIngestError('encrypted_pdf', 'PDF protegido por senha', name)
    throw new KnowledgeIngestError('unreadable_pdf', 'não foi possível ler o PDF', name || (err instanceof Error ? err.message : null))
  }
  const pages = result.text.map(normalizeKnowledgeText)
  if (!pages.some(Boolean)) throw new KnowledgeIngestError('empty_pdf', 'o PDF não tem texto (imagem escaneada?)')
  return { totalPages: result.totalPages, pages }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** HTML → texto visível (sem script/style/head), com entidades básicas decodificadas. */
export function htmlToText(html: string): string {
  const body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' '
      }
      return ENTITIES[e.toLowerCase()] ?? m
    })
  return normalizeKnowledgeText(body)
}

/** Título da página (`<title>`), se houver. */
export function htmlTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const t = m ? htmlToText(m[1]!) : ''
  return t || null
}

/** Links `href` absolutos do mesmo host (sem âncora, sem arquivos estáticos). */
export function sameHostLinks(html: string, base: URL): string[] {
  const out = new Set<string>()
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const href = (m[1] ?? m[2] ?? m[3] ?? '').trim()
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript|data):/i.test(href)) continue
    let u: URL
    try {
      u = new URL(href, base)
    } catch {
      continue
    }
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.hostname !== base.hostname) continue
    if (/\.(png|jpe?g|gif|webp|svg|ico|css|js|pdf|zip|mp4|mp3|woff2?)$/i.test(u.pathname)) continue
    u.hash = ''
    if (u.toString() !== base.toString()) out.add(u.toString())
  }
  return [...out]
}

/** Espaços colapsados por linha, linhas vazias repetidas removidas. */
export function normalizeKnowledgeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t\f\v\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export const CHUNK_MAX_CHARS = 800

/** Divide em trechos de até `max` caracteres, por parágrafo/linha/frase (sem cortar palavra quando dá). */
export function chunkText(text: string, max = CHUNK_MAX_CHARS): string[] {
  const chunks: string[] = []
  let cur = ''
  const flush = () => {
    if (cur.trim()) chunks.push(cur.trim())
    cur = ''
  }
  const pieces = normalizeKnowledgeText(text)
    .split(/\n+/)
    .flatMap((line) => (line.length <= max ? [line] : line.split(/(?<=[.!?;])\s+/)))
  for (let piece of pieces) {
    while (piece.length > max) {
      const cut = piece.lastIndexOf(' ', max) > max / 2 ? piece.lastIndexOf(' ', max) : max
      flush()
      chunks.push(piece.slice(0, cut).trim())
      piece = piece.slice(cut).trim()
    }
    if (cur && cur.length + 1 + piece.length > max) flush()
    cur = cur ? `${cur}\n${piece}` : piece
  }
  flush()
  return chunks
}
