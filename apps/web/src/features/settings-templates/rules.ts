// Regras puras do editor de modelos (replicam `renderTemplateContent` de `packages/core/src/content/rules.ts`): o
// modelo vira o texto que a prévia manda ao `POST /api/content/render`, e o corpo do POST/PATCH sai normalizado.
import type { TemplateContent, TemplateInput } from './api'

export const MAX_BUTTONS = 10
export const NAME_MAX = 120
export const FOOTER_MAX = 200
export const HEADER_TEXT_MAX = 200

/** Variáveis do contato que o servidor resolve (`templating/render.ts`). */
export const CONTACT_VARIABLES = ['full_name', 'first_name', 'phone_number', 'email'] as const

/** Cabeçalho de texto, corpo, menu numerado dos `reply`, "Texto: destino" dos `url`/`phone` e rodapé. */
export function templateText(t: TemplateContent): string {
  const blocks: string[] = []
  if (t.header.type === 'text' && t.header.text?.trim()) blocks.push(t.header.text.trim())
  blocks.push(t.body)
  const replies = t.buttons.filter((b) => b.type === 'reply')
  if (replies.length) blocks.push(replies.map((b, i) => `${i + 1} - ${b.text}`).join('\n'))
  const links = t.buttons.filter((b) => b.type !== 'reply')
  if (links.length)
    blocks.push(links.map((b) => `${b.text}: ${b.type === 'url' ? (b.url ?? '') : (b.phone ?? '')}`).join('\n'))
  if (t.footer?.trim()) blocks.push(t.footer.trim())
  return blocks.filter((b) => b.length > 0).join('\n\n')
}

/** Insere `token` na posição do cursor (`start`..`end`) e devolve o texto e o novo cursor. */
export function insertAt(text: string, token: string, start: number, end = start): { text: string; cursor: number } {
  const a = Math.max(0, Math.min(start, text.length))
  const b = Math.max(a, Math.min(end, text.length))
  return { text: text.slice(0, a) + token + text.slice(b), cursor: a + token.length }
}

export type TemplateIssue =
  'name' | 'body' | 'header_text' | 'header_media' | { button: number; field: 'text' | 'url' | 'phone' }

export function templateIssue(t: TemplateInput): TemplateIssue | null {
  if (!t.name.trim()) return 'name'
  if (t.header.type === 'text' && !t.header.text?.trim()) return 'header_text'
  if (t.header.type !== 'none' && t.header.type !== 'text' && !t.header.media_id) return 'header_media'
  if (!t.body.trim()) return 'body'
  for (const [i, b] of t.buttons.entries()) {
    if (!b.text.trim()) return { button: i, field: 'text' }
    if (b.type === 'url' && !b.url?.trim()) return { button: i, field: 'url' }
    if (b.type === 'phone' && !b.phone?.trim()) return { button: i, field: 'phone' }
  }
  return null
}

/** Só os campos de cada tipo de cabeçalho/botão. */
export function toTemplateInput(t: TemplateInput): TemplateInput {
  const h = t.header
  return {
    name: t.name.trim(),
    header:
      h.type === 'text'
        ? { type: 'text', text: h.text?.trim() ?? '' }
        : h.type === 'none'
          ? { type: 'none' }
          : { type: h.type, media_id: h.media_id ?? null },
    body: t.body,
    footer: t.footer?.trim() ? t.footer.trim() : null,
    buttons: t.buttons.map((b) =>
      b.type === 'url'
        ? { type: 'url', text: b.text.trim(), url: b.url?.trim() ?? '' }
        : b.type === 'phone'
          ? { type: 'phone', text: b.text.trim(), phone: b.phone?.trim() ?? '' }
          : { type: 'reply', text: b.text.trim() },
    ),
  }
}
