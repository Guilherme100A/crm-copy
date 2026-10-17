// Regras puras dos editores interativos da T56 (06 §3.6; T62): ids estáveis de opção/botão/cartão (viram os handles
// `option:<id>` e nunca derivam da posição) e a prévia do texto enviado — réplica de `menuText` e do envio do carrossel
// (`packages/core/src/flows/nodes/interactive/{menu,handlers}.ts`), que a web não importa.
import { handle } from '@crm/shared/flows'
import type { PreviewMessage } from '../messaging/kit'
import { previewUrl } from '../messaging/rules'

type Config = Record<string, unknown>

export const MENU_PRIMARY: Record<string, string> = { interactive_menu: 'send_interactive_menu', menu: 'send_option_list' }
export const OPTION_TYPES = ['REPLY', 'URL', 'COPY', 'CALL'] as const
export type OptionType = (typeof OPTION_TYPES)[number]

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** Id estável `option_<ts><4>` / `btn_…` / `card_…` (sem `:` nem espaço, aceito por `handleId`). Gerado uma vez. */
export function newHandleId(prefix: 'option' | 'btn' | 'card', now: number = Date.now(), random: () => number = Math.random): string {
  let s = ''
  for (let i = 0; i < 4; i++) s += ALPHABET[Math.floor(random() * ALPHABET.length)]
  return `${prefix}_${now.toString(36)}${s}`
}

export interface MenuOptionLike {
  id?: string
  title: string
  description?: string
  type?: string
}

export const list = (v: unknown): Config[] => (Array.isArray(v) ? v.filter((x): x is Config => !!x && typeof x === 'object') : [])
const text = (v: unknown) => (typeof v === 'string' ? v : '')

export const replyOptions = <T extends MenuOptionLike>(options: readonly T[]) => options.filter((o) => !o.type || o.type === 'REPLY')

/** Texto do menu como o motor envia: mensagem, opções numeradas, links ("Título: destino") e rodapé. */
export function menuText(message: string, options: readonly MenuOptionLike[], footer?: string | null): string {
  const blocks = [message.trim()]
  const numbered = replyOptions(options).map((o, i) => `${i + 1} - ${o.title.trim()}${o.description?.trim() ? ` — ${o.description.trim()}` : ''}`)
  if (numbered.length) blocks.push(numbered.join('\n'))
  const links = options.filter((o) => o.type && o.type !== 'REPLY').map((o) => `${o.title.trim()}: ${(o.description ?? '').trim()}`)
  if (links.length) blocks.push(links.join('\n'))
  if (footer?.trim()) blocks.push(footer.trim())
  return blocks.filter(Boolean).join('\n\n')
}

const optionsOf = (c: Config): MenuOptionLike[] =>
  list(c.options).map((o) => ({ id: text(o.id) || undefined, title: text(o.title), description: text(o.description) || undefined, type: text(o.type) || undefined }))

/** Prévia do menu: imagem do botão (se ativa) e o texto numerado. */
export function menuPreview(c: Config): PreviewMessage[] {
  const out: PreviewMessage[] = []
  if (c.imageButtonEnabled === true && text(c.imageButton).trim()) out.push({ kind: 'image', text: '', image: previewUrl(c.imageButton, c.imageButton_media_id) })
  out.push({ kind: 'text', text: menuText(text(c.message), optionsOf(c), text(c.footerText) || null) })
  return out
}

/** Prévia do carrossel: cada cartão com imagem vira imagem com legenda (texto + links não-REPLY) e, no fim, o menu. */
export function carouselPreview(c: Config): PreviewMessage[] {
  const out: PreviewMessage[] = []
  const options: MenuOptionLike[] = []
  for (const card of list(c.carousel)) {
    const buttons = list(card.buttons)
    for (const b of buttons) if (b.type === 'REPLY') options.push({ id: text(b.id), title: text(b.text) })
    const links = buttons.filter((b) => b.type !== 'REPLY').map((b) => `${text(b.text)}: ${text(b.payload)}`.trim())
    const caption = [text(card.text).trim(), ...links].filter(Boolean).join('\n')
    if (text(card.image).trim()) out.push({ kind: 'image', text: caption, image: previewUrl(card.image, card.media_id) })
  }
  out.push({ kind: 'text', text: menuText(text(c.text), options) })
  return out
}

/** Handles de saída das opções na ordem atual (`option:<id>`), só das que já têm id. */
export const optionHandles = (items: readonly { id?: unknown; type?: unknown }[], onlyReply = false) =>
  items.filter((o) => typeof o.id === 'string' && o.id && (!onlyReply || o.type === 'REPLY')).map((o) => handle.option(o.id as string))
