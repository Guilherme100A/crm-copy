import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CsvWriter, csvCell, csvLine } from './csv'
import { FsExportFileStore, InvalidExportKeyError } from './files'
import { getExportKind, keysetPages, registerExportKind } from './registry'

describe('CSV', () => {
  it('escapa delimitador, aspas, quebras e espaços nas pontas', () => {
    expect(csvCell('simples')).toBe('simples')
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('a;b')).toBe('a;b')
    expect(csvCell('a;b', ';')).toBe('"a;b"')
    expect(csvCell('diz "oi"')).toBe('"diz ""oi"""')
    expect(csvCell('l1\nl2')).toBe('"l1\nl2"')
    expect(csvCell(' x')).toBe('" x"')
    expect(csvCell(null)).toBe('')
    expect(csvCell(new Date('2026-01-02T03:04:05Z'))).toBe('2026-01-02T03:04:05.000Z')
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"')
    expect(csvLine([1, 'x', null], ';')).toBe('1;x;\r\n')
  })

  it('writer põe BOM + cabeçalho e respeita o backpressure', async () => {
    const chunks: Buffer[] = []
    let drains = 0
    const out = new Writable({
      highWaterMark: 16,
      write(chunk: Buffer, _enc, cb) {
        chunks.push(chunk)
        setImmediate(cb)
      },
    })
    out.on('drain', () => drains++)
    const w = new CsvWriter(out, ';')
    await w.header(['ID', 'Nome'])
    for (let i = 0; i < 50; i++) await w.row([i, `Nome ${i}`])
    const text = Buffer.concat(chunks).toString('utf8')
    expect(text.startsWith('﻿ID;Nome\r\n0;Nome 0\r\n')).toBe(true)
    expect(w.rowCount).toBe(50)
    expect(w.bytesWritten).toBe(Buffer.concat(chunks).length)
    expect(drains).toBeGreaterThan(0)
  })
})

describe('FsExportFileStore', () => {
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 't27-files-'))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('só publica no commit; abort não deixa nada', async () => {
    const store = new FsExportFileStore({ dir })
    const w = await store.create('co/job-1.csv')
    w.stream.write('parcial')
    expect(await store.open('co/job-1.csv')).toBeNull()
    expect(await w.commit()).toEqual({ size: 7 })
    const stream = await store.open('co/job-1.csv')
    const got: Buffer[] = []
    for await (const c of stream!) got.push(c as Buffer)
    expect(Buffer.concat(got).toString()).toBe('parcial')
    expect(await store.size('co/job-1.csv')).toBe(7)

    const a = await store.create('co/job-2.csv')
    a.stream.write('lixo')
    await a.abort()
    expect(await store.open('co/job-2.csv')).toBeNull()
    expect((await readdir(join(dir, 'co'))).sort()).toEqual(['job-1.csv'])
    await store.delete('co/job-1.csv')
    expect(await store.size('co/job-1.csv')).toBeNull()
  })

  it('recusa chaves com .. ou absolutas', async () => {
    const store = new FsExportFileStore({ dir })
    await expect(store.create('../fora.csv')).rejects.toBeInstanceOf(InvalidExportKeyError)
    await expect(store.open('/etc/passwd')).rejects.toBeInstanceOf(InvalidExportKeyError)
    await expect(store.open('a/../../b')).rejects.toBeInstanceOf(InvalidExportKeyError)
  })

  it('arquivo grande escrito em streaming', async () => {
    const store = new FsExportFileStore({ dir })
    const w = await store.create('co/big.csv')
    const csv = new CsvWriter(w.stream)
    await csv.header(['n'])
    for (let i = 0; i < 20_000; i++) await csv.row([i])
    const { size } = await w.commit()
    expect(size).toBe(csv.bytesWritten)
    const text = await readFile(join(dir, 'co/big.csv'), 'utf8')
    expect(text.split('\r\n')).toHaveLength(20_002)
  })
})

describe('registro de kinds', () => {
  it('registra, recusa duplicado/nome inválido e desfaz', () => {
    const def = { permission: 'contacts.view' as const, columns: [{ key: 'id', header: 'ID' }], async *query() {} }
    const off = registerExportKind('t27_unit', def)
    expect(getExportKind('t27_unit')).toBeDefined()
    expect(() => registerExportKind('t27_unit', def)).toThrow(/já registrado/)
    expect(() => registerExportKind('Bad-Kind', def)).toThrow(/kind inválido/)
    expect(() => registerExportKind('t27_nocols', { ...def, columns: [] })).toThrow(/sem colunas/)
    off()
    expect(getExportKind('t27_unit')).toBeUndefined()
  })

  it('keysetPages pede páginas até vir uma incompleta', async () => {
    const calls: Array<number | null> = []
    const rows: number[] = []
    for await (const r of keysetPages<{ id: number }>(
      async (after, limit) => {
        calls.push(after?.id ?? null)
        const start = (after?.id ?? 0) + 1
        return Array.from({ length: Math.max(0, Math.min(limit, 25 - start + 1)) }, (_, i) => ({ id: start + i }))
      },
      { pageSize: 10 },
    ))
      rows.push(r.id)
    expect(rows).toEqual(Array.from({ length: 25 }, (_, i) => i + 1))
    expect(calls).toEqual([null, 10, 20])
  })
})

