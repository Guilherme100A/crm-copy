// Writer CSV em streaming (T27): UTF-8 com BOM, RFC 4180 (aspas quando preciso, `""` para aspas, `\r\n`),
// delimitador `,` (padrão) ou `;` (Excel pt-BR). Escreve num `Writable` respeitando o backpressure.
import { once } from 'node:events'
import type { Writable } from 'node:stream'

export const CSV_BOM = '﻿'
export const CSV_DELIMITERS = [',', ';'] as const
export type CsvDelimiter = (typeof CSV_DELIMITERS)[number]

export const isCsvDelimiter = (v: unknown): v is CsvDelimiter => v === ',' || v === ';'

/** Valor → texto da célula: `null`/`undefined` vazio, datas ISO, objetos em JSON. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString()
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

/** Escapa uma célula: entre aspas se tiver delimitador, aspas, `\r` ou `\n` (ou espaço nas pontas). */
export function csvCell(value: unknown, delimiter: CsvDelimiter = ','): string {
  const s = cellText(value)
  if (s === '') return ''
  if (s.includes(delimiter) || /["\r\n]/.test(s) || s.trim() !== s) return `"${s.replace(/"/g, '""')}"`
  return s
}

export function csvLine(values: readonly unknown[], delimiter: CsvDelimiter = ','): string {
  return `${values.map((v) => csvCell(v, delimiter)).join(delimiter)}\r\n`
}

/** Escreve linhas num `Writable`; aguarda `drain` quando o buffer enche (nunca acumula o arquivo em memória). */
export class CsvWriter {
  private bytes = 0
  private rows = 0

  constructor(
    private readonly out: Writable,
    readonly delimiter: CsvDelimiter = ',',
  ) {}

  get bytesWritten(): number {
    return this.bytes
  }

  /** Linhas de dados escritas (sem o cabeçalho). */
  get rowCount(): number {
    return this.rows
  }

  /** BOM + cabeçalho. */
  async header(headers: readonly string[]): Promise<void> {
    await this.write(CSV_BOM + csvLine(headers, this.delimiter))
  }

  async row(values: readonly unknown[]): Promise<void> {
    await this.write(csvLine(values, this.delimiter))
    this.rows++
  }

  private async write(chunk: string): Promise<void> {
    const buf = Buffer.from(chunk, 'utf8')
    this.bytes += buf.length
    if (!this.out.write(buf)) await once(this.out, 'drain')
  }
}
