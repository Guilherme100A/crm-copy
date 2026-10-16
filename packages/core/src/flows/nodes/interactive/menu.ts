// Menus como TEXTO (T62; SPEC 3.8/8.3): botões, listas e carrossel saem como menu numerado ("1 - Vendas"), e a
// resposta é reconhecida pelo número, pelo título exato ou pelo título sem caixa/acentos.

export interface MenuOption {
  id?: string
  title: string
  description?: string
  type?: 'REPLY' | 'URL' | 'COPY' | 'CALL' | string
}

/** Opções numeradas (respondíveis): as de resposta, na ordem da config. */
export const replyOptions = (options: readonly MenuOption[]) => options.filter((o) => !o.type || o.type === 'REPLY')

/** Sem acentos, minúsculo, espaços colapsados e pontuação final removida. */
export function normalizeAnswer(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?]+$/, '')
    .trim()
}

/**
 * Texto do menu: mensagem, as opções numeradas ("1 - Título", com "— descrição" se houver), os links (URL/ligar/
 * copiar como "Título: destino") e o rodapé, em blocos separados por linha em branco.
 */
export function menuText(message: string, options: readonly MenuOption[], footer?: string | null): string {
  const blocks = [message.trim()]
  const numbered = replyOptions(options).map((o, i) => `${i + 1} - ${o.title.trim()}${o.description?.trim() ? ` — ${o.description.trim()}` : ''}`)
  if (numbered.length) blocks.push(numbered.join('\n'))
  const links = options.filter((o) => o.type && o.type !== 'REPLY').map((o) => `${o.title.trim()}: ${(o.description ?? '').trim()}`)
  if (links.length) blocks.push(links.join('\n'))
  if (footer?.trim()) blocks.push(footer.trim())
  return blocks.filter(Boolean).join('\n\n')
}

/** Opção escolhida pela resposta (número da lista, título exato ou normalizado); `null` = não reconhecida. */
export function matchOption<T extends MenuOption>(answer: string, options: readonly T[]): T | null {
  const replies = replyOptions(options) as T[]
  const text = answer.trim()
  if (!text) return null
  const num = /^(\d{1,3})[.)]?$/.exec(text)
  if (num) return replies[Number(num[1]) - 1] ?? null
  const exact = replies.find((o) => o.title.trim() === text)
  if (exact) return exact
  const norm = normalizeAnswer(text)
  return replies.find((o) => normalizeAnswer(o.title) === norm) ?? null
}
