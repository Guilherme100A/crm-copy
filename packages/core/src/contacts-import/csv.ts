// Leitura do CSV de contatos (T67) em streaming: detecção de encoding (UTF-8 válido, senão Windows-1252, como os
// CSVs do Excel BR), delimitador automático (`,` `;` TAB) pelo papaparse (`NODE_STREAM_INPUT`) e mapeamento das
// colunas pelo cabeçalho (sem diferença de maiúsculas/acentos).
import { Transform, type Readable } from 'node:stream'
import Papa from 'papaparse'

export type CsvEncoding = 'utf-8' | 'windows-1252'

/** Lê o arquivo uma vez: UTF-8 é válido? e quantas linhas (≈ registros) há. Não guarda o conteúdo. */
export async function scanCsv(stream: Readable): Promise<{ encoding: CsvEncoding; lines: number }> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let utf8 = true
  let newlines = 0
  let lastByte = -1
  let bytes = 0
  for await (const chunk of stream) {
    const buf = chunk as Buffer
    bytes += buf.length
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) newlines++
    if (buf.length) lastByte = buf[buf.length - 1]!
    if (utf8) {
      try {
        decoder.decode(buf, { stream: true })
      } catch {
        utf8 = false
      }
    }
  }
  if (utf8) {
    try {
      decoder.decode()
    } catch {
      utf8 = false
    }
  }
  const lines = bytes === 0 ? 0 : newlines + (lastByte === 0x0a ? 0 : 1)
  return { encoding: utf8 ? 'utf-8' : 'windows-1252', lines }
}

/** Texto mínimo do 1º pedaço entregue ao parser: o papaparse adivinha o delimitador só por ele. */
const HEAD_LINES = 5
const HEAD_MAX_CHARS = 64 * 1024

/**
 * Bytes → texto no encoding escolhido, sem o BOM inicial (multibyte entre chunks tratado pelo decoder). O começo
 * é retido até ter `HEAD_LINES` linhas (ou 64 KB), para o palpite do delimitador ver o cabeçalho e algumas linhas.
 */
export function decodeStream(encoding: CsvEncoding): Transform {
  const decoder = new TextDecoder(encoding)
  let head: string | null = ''
  const take = (text: string, flush: boolean): string => {
    if (head === null) return text
    head += text
    const lines = head.split('\n').length - 1
    if (!flush && lines < HEAD_LINES && head.length < HEAD_MAX_CHARS) return ''
    const out = head.charCodeAt(0) === 0xfeff ? head.slice(1) : head
    head = null
    return out
  }
  return new Transform({
    readableObjectMode: false,
    decodeStrings: true,
    transform(chunk: Buffer, _enc, cb) {
      const out = take(decoder.decode(chunk, { stream: true }), false)
      cb(null, out.length ? out : undefined)
    },
    flush(cb) {
      const out = take(decoder.decode(), true)
      cb(null, out.length ? out : undefined)
    },
  })
}

/** Cabeçalho → chave canônica: minúsculas, sem acento, `-`/espaço → `_`. */
export function headerKey(raw: string): string {
  return raw
    .replace(/^\uFEFF/, '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
}

export const IMPORT_FIELDS = ['name', 'phone', 'email', 'labels', 'state', 'city', 'zip', 'opt_out'] as const
export type ImportField = (typeof IMPORT_FIELDS)[number]

const ALIASES: Record<string, ImportField> = {
  nome: 'name',
  name: 'name',
  full_name: 'name',
  nome_completo: 'name',
  telefone: 'phone',
  phone: 'phone',
  phone_number: 'phone',
  celular: 'phone',
  whatsapp: 'phone',
  numero: 'phone',
  email: 'email',
  e_mail: 'email',
  etiquetas: 'labels',
  etiqueta: 'labels',
  labels: 'labels',
  tags: 'labels',
  estado: 'state',
  uf: 'state',
  state: 'state',
  cidade: 'city',
  city: 'city',
  cep: 'zip',
  zip: 'zip',
  opt_out: 'opt_out',
  optout: 'opt_out',
}

export const fieldOfHeader = (raw: string): ImportField | undefined => ALIASES[headerKey(raw)]

const TRUE = new Set(['true', '1', 'sim', 's', 'yes', 'y', 'x', 'verdadeiro'])
const FALSE = new Set(['', 'false', '0', 'nao', 'no', 'n', 'falso'])

/** `true`/`false`, ou `null` se o valor não for reconhecido. */
export function parseOptOut(raw: string | undefined): boolean | null {
  const v = headerKey(raw ?? '')
  if (TRUE.has(v)) return true
  if (FALSE.has(v)) return false
  return null
}

/** Etiquetas da célula: separadas por `|`, `,` ou `;`; sem vazias nem repetidas (sem diferença de maiúsculas). */
export function splitLabels(raw: string | undefined): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of (raw ?? '').split(/[|,;]/)) {
    const name = part.trim()
    if (!name || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    out.push(name)
  }
  return out
}

export type CsvRecord = Partial<Record<ImportField, string>>

export interface ParsedRow {
  /** Linha do registro no arquivo (cabeçalho = linha 1). */
  line: number
  record: CsvRecord
}

export interface CsvParseResult {
  /** Colunas do cabeçalho sem correspondência (ignoradas). */
  ignoredColumns: string[]
  hasPhoneColumn: boolean
}

/**
 * Registros do CSV sob demanda. `onHeader` recebe o mapeamento antes da 1ª linha. Linhas totalmente vazias são
 * puladas (sem contar como erro).
 */
export async function* parseCsv(source: Readable, encoding: CsvEncoding, onHeader?: (r: CsvParseResult) => void): AsyncGenerator<ParsedRow> {
  let headerSeen = false
  let mapping: Map<string, ImportField> = new Map()
  const parser = Papa.parse(Papa.NODE_STREAM_INPUT, {
    header: true,
    skipEmptyLines: 'greedy',
    delimitersToGuess: [',', ';', '\t'],
    transformHeader: (h: string) => h.trim(),
  })
  const rows = source.pipe(decodeStream(encoding)).pipe(parser)
  source.on('error', (err) => rows.destroy(err))
  let line = 1
  for await (const raw of rows as AsyncIterable<Record<string, string | undefined>>) {
    if (!headerSeen) {
      headerSeen = true
      mapping = new Map()
      const ignored: string[] = []
      for (const h of Object.keys(raw)) {
        if (h === '__parsed_extra') continue
        const f = fieldOfHeader(h)
        if (f && ![...mapping.values()].includes(f)) mapping.set(h, f)
        else if (!f && h.trim()) ignored.push(h)
      }
      onHeader?.({ ignoredColumns: ignored, hasPhoneColumn: [...mapping.values()].includes('phone') })
    }
    line++
    const record: CsvRecord = {}
    for (const [h, f] of mapping) {
      const v = raw[h]
      if (typeof v === 'string') record[f] = v.trim()
    }
    yield { line, record }
  }
}
