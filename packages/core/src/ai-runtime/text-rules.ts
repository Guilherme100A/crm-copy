// Regras de texto do agente (07 §3.2): o que nunca vira áudio e como dividir a resposta em mensagens curtas.

const LINK_RE = /\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]+\.(com|com\.br|net|org|io|br|app|me|link)\b/i
const PRICE_RE = /R\$\s?\d|US\$\s?\d|\$\s?\d|€\s?\d|\b\d+[.,]\d{2}\s?(reais|r\$|brl|usd|dólares|dolares)\b|\b\d+\s?(reais|dólares|dolares)\b/i
const PIX_RE = /\bpix\b|copia\s*e\s*cola|\b000201\d/i
// Códigos: cupom/voucher/rastreio/protocolo, sequências longas de dígitos ou tokens alfanuméricos com dígitos.
const CODE_RE = /\b(c[óo]digo|cupom|voucher|rastreio|protocolo|senha)\b|\b\d{6,}\b|\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{6,}\b/
const ADDRESS_RE = /\b(rua|r\.|avenida|av\.|alameda|travessa|rodovia|estrada|pra[çc]a)\s+\S|\bcep\b|\b\d{5}-?\d{3}\b|\bn[ºo°]\s?\d/i
const LIST_RE = /(^|\n)\s*([-*•]|\d+[.)])\s+\S/

/** Motivo pelo qual o texto não pode ir como áudio, ou `null` se pode (regra fixa da plataforma). */
export function audioBlockReason(text: string): 'link' | 'price' | 'pix' | 'code' | 'address' | 'list' | null {
  if (LINK_RE.test(text)) return 'link'
  if (PRICE_RE.test(text)) return 'price'
  if (PIX_RE.test(text)) return 'pix'
  if (ADDRESS_RE.test(text)) return 'address'
  if (LIST_RE.test(text)) return 'list'
  if (CODE_RE.test(text)) return 'code'
  return null
}

export const canSpeak = (text: string) => audioBlockReason(text) === null

export const MAX_SPLIT_PARTS = 4

/** Divide a resposta em mensagens curtas: por parágrafo; um parágrafo longo vira frases agrupadas. */
export function splitReply(text: string, maxParts = MAX_SPLIT_PARTS): string[] {
  const clean = text.trim()
  if (!clean) return []
  let parts = clean.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  if (parts.length === 1 && clean.length > 280) {
    const sentences = clean.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [clean]
    parts = []
    let cur = ''
    for (const s of sentences) {
      if (cur && (cur + ' ' + s).length > 220) {
        parts.push(cur)
        cur = s
      } else cur = cur ? `${cur} ${s}` : s
    }
    if (cur) parts.push(cur)
  }
  if (parts.length <= maxParts) return parts
  // Sobra vai junto na última mensagem.
  return [...parts.slice(0, maxParts - 1), parts.slice(maxParts - 1).join('\n\n')]
}
