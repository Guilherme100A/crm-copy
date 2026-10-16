// Pix "copia e cola" (BR Code / EMV MPM do Banco Central) para o nó Pix (T51). No clone o Pix sai como texto com a
// chave e o código EMV (SPEC 3.8, 8.3): o código é o payload estático com CRC16-CCITT no campo 63.

/** CRC16-CCITT-FALSE (poly 0x1021, init 0xFFFF, sem reflexão, sem XOR final), em 4 hex maiúsculos. */
export function crc16ccitt(payload: string): string {
  let crc = 0xffff
  for (const byte of Buffer.from(payload, 'utf8')) {
    crc ^= byte << 8
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
  }
  return crc.toString(16).toUpperCase().padStart(4, '0')
}

export const PIX_KEY_TYPES = ['EVP', 'CPF', 'CNPJ', 'PHONE', 'EMAIL'] as const
export type PixKeyType = (typeof PIX_KEY_TYPES)[number]

export interface PixEmvInput {
  /** Chave Pix (EVP, CPF, CNPJ, telefone ou e-mail). */
  key: string
  /** Tipo da chave (`pix_type`); sem ele o formato é deduzido (11 dígitos = CPF, 14 = CNPJ, `+` = telefone). */
  type?: PixKeyType | null
  /** Nome do recebedor (até 25 caracteres, sem acentos). Padrão `Pix`. */
  merchantName?: string | null
  /** Cidade do recebedor (até 15 caracteres, sem acentos). Padrão `BRASIL`. */
  city?: string | null
  /** Valor em reais; vazio/0 = valor livre (campo 54 omitido). */
  amount?: number | string | null
  /** Identificador da transação (campo 62-05, até 25 alfanuméricos). Padrão `***`. */
  txid?: string | null
}

const field = (id: string, value: string) => {
  const len = Buffer.byteLength(value, 'utf8')
  if (len > 99) throw new Error(`campo EMV ${id} com mais de 99 bytes`)
  return `${id}${String(len).padStart(2, '0')}${value}`
}

/** Remove acentos e caracteres fora do conjunto aceito pelos apps bancários. */
function ascii(value: string, max: number): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 .,\-@/&]/g, '')
    .trim()
    .slice(0, max)
}

/** `"10,50"`, `"1.234,56"`, `10.5` → `"10.50"`/`"1234.56"`; vazio, inválido ou ≤ 0 → `null` (valor livre). */
export function pixAmount(amount: PixEmvInput['amount']): string | null {
  if (amount === null || amount === undefined) return null
  let raw: number
  if (typeof amount === 'number') raw = amount
  else {
    let s = String(amount).trim().replace(/\s|R\$/g, '')
    // Com vírgula, o ponto é separador de milhar ("1.234,56"); sem vírgula, o ponto é decimal ("10.50").
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.')
    raw = s ? Number(s) : Number.NaN
  }
  if (!Number.isFinite(raw) || raw <= 0) return null
  return raw.toFixed(2)
}

/** Chave no formato do DICT: telefone `+55…`, CPF/CNPJ só dígitos, e-mail e EVP em minúsculas. */
export function normalizePixKey(key: string, type?: PixKeyType | null): string {
  const k = key.trim()
  const digits = k.replace(/\D/g, '')
  const kind: PixKeyType =
    type ??
    (k.includes('@')
      ? 'EMAIL'
      : k.startsWith('+')
        ? 'PHONE'
        : /^[\d./-]+$/.test(k) && digits.length === 11
          ? 'CPF'
          : /^[\d./-]+$/.test(k) && digits.length === 14
            ? 'CNPJ'
            : 'EVP')
  switch (kind) {
    case 'CPF':
    case 'CNPJ':
      return digits
    case 'PHONE':
      return digits.length <= 11 ? `+55${digits}` : `+${digits}`
    default:
      return k.toLowerCase()
  }
}

/** Payload "copia e cola" estático (BR Code) com CRC16 válido. */
export function pixEmv(input: PixEmvInput): string {
  const key = normalizePixKey(input.key, input.type)
  if (!key) throw new Error('chave Pix obrigatória')
  const amount = pixAmount(input.amount)
  const txid = (input.txid ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***'
  const payload =
    field('00', '01') +
    field('26', field('00', 'br.gov.bcb.pix') + field('01', key)) +
    field('52', '0000') +
    field('53', '986') +
    (amount ? field('54', amount) : '') +
    field('58', 'BR') +
    field('59', ascii(input.merchantName?.trim() || 'Pix', 25) || 'Pix') +
    field('60', ascii(input.city?.trim() || 'BRASIL', 15) || 'BRASIL') +
    field('62', field('05', txid)) +
    '6304'
  return payload + crc16ccitt(payload)
}

/** Texto da mensagem do nó Pix: chave, recebedor e valor (se houver) e o código copia e cola. */
export function pixMessage(input: PixEmvInput): string {
  const amount = pixAmount(input.amount)
  const lines = [`Chave Pix: ${input.key.trim()}`]
  if (input.merchantName?.trim()) lines.push(`Recebedor: ${input.merchantName.trim()}`)
  if (amount) lines.push(`Valor: R$ ${amount.replace('.', ',')}`)
  return `${lines.join('\n')}\n\nPix copia e cola:\n${pixEmv(input)}`
}
