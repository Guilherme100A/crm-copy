import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { fieldOfHeader, parseCsv, parseOptOut, scanCsv, splitLabels, type ParsedRow } from './csv'
import { ImportReport } from './report'
import { contactsImportTemplate } from './service'

const bytes = (s: string, enc: BufferEncoding = 'utf8') => Buffer.from(s, enc)
/** Fatia em pedaços pequenos para exercitar fronteiras de chunk (inclusive no meio de um caractere UTF-8). */
const chunked = (buf: Buffer, size = 3) => Readable.from(Array.from({ length: Math.ceil(buf.length / size) }, (_, i) => buf.subarray(i * size, (i + 1) * size)))

async function rows(buf: Buffer, size?: number): Promise<{ rows: ParsedRow[]; ignored: string[] }> {
  const { encoding } = await scanCsv(chunked(buf, size))
  const out: ParsedRow[] = []
  let ignored: string[] = []
  for await (const r of parseCsv(chunked(buf, size), encoding, (h) => (ignored = h.ignoredColumns))) out.push(r)
  return { rows: out, ignored }
}

describe('leitura do CSV', () => {
  it('Windows-1252 com ; e acentos', async () => {
    const buf = bytes('Nome;Telefone;Etiquetas\r\nJoão Ávila;11 98888-7777;Ação, Promoção\r\nConceição;11977776666;\r\n', 'latin1')
    expect((await scanCsv(chunked(buf))).encoding).toBe('windows-1252')
    const { rows: r } = await rows(buf)
    expect(r).toEqual([
      { line: 2, record: { name: 'João Ávila', phone: '11 98888-7777', labels: 'Ação, Promoção' } },
      { line: 3, record: { name: 'Conceição', phone: '11977776666', labels: '' } },
    ])
  })

  it('UTF-8 com BOM e vírgula, campos entre aspas, chunks no meio de caracteres', async () => {
    const buf = bytes('\uFEFFnome,telefone,e-mail,Observação\n"Silva, José",+5511912345678,jose@x.com,ok\n')
    expect(await scanCsv(chunked(buf, 2))).toEqual({ encoding: 'utf-8', lines: 2 })
    const { rows: r, ignored } = await rows(buf, 2)
    expect(r).toEqual([{ line: 2, record: { name: 'Silva, José', phone: '+5511912345678', email: 'jose@x.com' } }])
    expect(ignored).toEqual(['Observação'])
  })

  it('TAB como delimitador e linhas vazias puladas', async () => {
    const { rows: r } = await rows(bytes('telefone\tuf\n11912345678\tsp\n\n11912345679\trj\n'))
    expect(r.map((x) => x.record)).toEqual([
      { phone: '11912345678', state: 'sp' },
      { phone: '11912345679', state: 'rj' },
    ])
  })

  it('cabeçalhos, opt-out e etiquetas', () => {
    expect(fieldOfHeader(' Número ')).toBe('phone')
    expect(fieldOfHeader('E-mail')).toBe('email')
    expect(fieldOfHeader('Opt-Out')).toBe('opt_out')
    expect(fieldOfHeader('UF')).toBe('state')
    expect(fieldOfHeader('qualquer')).toBeUndefined()
    for (const v of ['true', 'SIM', '1', 'x', 'Yes']) expect(parseOptOut(v)).toBe(true)
    for (const v of ['', 'false', 'Não', '0', 'n']) expect(parseOptOut(v)).toBe(false)
    expect(parseOptOut('talvez')).toBeNull()
    expect(splitLabels(' VIP | cliente;vip , Novo ')).toEqual(['VIP', 'cliente', 'Novo'])
  })

  it('modelo: BOM, ; e cabeçalho fixo', async () => {
    const t = contactsImportTemplate()
    expect(t.startsWith('\uFEFFnome;telefone;email;etiquetas;estado;cidade;cep;opt_out\r\n')).toBe(true)
    const { rows: r } = await rows(bytes(t))
    expect(r[0]!.record.phone).toBe('+55 11 91234-5678')
  })
})

describe('relatório', () => {
  it('agrupa erros por mensagem com exemplos e avisos com contagem', () => {
    const r = new ImportReport()
    r.error(3, 'telefone inválido')
    r.error(5, 'telefone inválido')
    r.error(9, 'outro erro')
    r.warn('coluna ignorada: x')
    r.warn('coluna ignorada: x')
    const c = r.counters()
    expect(c.errors).toBe(3)
    expect(c.error_groups).toEqual([
      { message: 'telefone inválido', count: 2, lines: [3, 5] },
      { message: 'outro erro', count: 1, lines: [9] },
    ])
    expect(c.errors_report).toEqual(['Linha 3: telefone inválido', 'Linha 5: telefone inválido', 'Linha 9: outro erro'])
    expect(c.warnings_report).toEqual(['coluna ignorada: x (2x)'])
  })

  it('no máximo 8 grupos e 10 linhas de exemplo por grupo', () => {
    const r = new ImportReport()
    for (let i = 0; i < 12; i++) r.error(i + 2, `erro ${i}`)
    for (let i = 0; i < 15; i++) r.error(100 + i, 'erro 0')
    const c = r.counters()
    expect(c.error_groups).toHaveLength(8)
    expect(c.error_groups[0]).toMatchObject({ message: 'erro 0', count: 16 })
    expect(c.error_groups[0]!.lines).toHaveLength(10)
  })
})
