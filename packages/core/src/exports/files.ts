// Arquivos gerados pelos jobs (T27). O `BlobStore` do node-kit só aceita o conteúdo inteiro em memória; aqui a
// escrita é em streaming num temporário, e só o `commit` (rename atômico) publica o arquivo: arquivo parcial
// nunca fica acessível pela chave.
import { randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { finished } from 'node:stream/promises'
import type { Readable, Writable } from 'node:stream'

export interface ExportFileWriter {
  stream: Writable
  /** Fecha o stream e publica o arquivo na chave. */
  commit(): Promise<{ size: number }>
  /** Descarta o temporário (falha do job). */
  abort(): Promise<void>
}

export interface ExportFileStore {
  create(key: string): Promise<ExportFileWriter>
  /** Stream do arquivo publicado, ou `null` se não existir. */
  open(key: string): Promise<Readable | null>
  size(key: string): Promise<number | null>
  delete(key: string): Promise<void>
}

export class InvalidExportKeyError extends Error {
  constructor(key: string) {
    super(`chave de arquivo inválida: ${JSON.stringify(String(key).slice(0, 80))}`)
    this.name = 'InvalidExportKeyError'
  }
}

/** `<segmento>/<arquivo>` com letras, números, `-`, `_` e `.` (sem `..`). */
const KEY_RE = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/

export function assertExportKey(key: string): string {
  if (typeof key !== 'string' || !KEY_RE.test(key) || key.includes('..')) throw new InvalidExportKeyError(key)
  return key
}

export interface FsExportFileStoreOptions {
  /** Raiz. Default `<STORAGE_DIR|./storage>/exports`. */
  dir?: string
}

export class FsExportFileStore implements ExportFileStore {
  readonly dir: string

  constructor(opts: FsExportFileStoreOptions | string = {}) {
    const dir = typeof opts === 'string' ? opts : opts.dir
    this.dir = resolve(dir || join(process.env.STORAGE_DIR || './storage', 'exports'))
  }

  private pathOf(key: string): string {
    const p = join(this.dir, assertExportKey(key))
    if (!p.startsWith(this.dir + sep)) throw new InvalidExportKeyError(key)
    return p
  }

  async create(key: string): Promise<ExportFileWriter> {
    const file = this.pathOf(key)
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
    const stream = createWriteStream(tmp)
    let done = false
    return {
      stream,
      commit: async () => {
        if (done) throw new Error('arquivo já finalizado')
        done = true
        stream.end()
        await finished(stream)
        await rename(tmp, file)
        return { size: (await stat(file)).size }
      },
      abort: async () => {
        if (done) return
        done = true
        stream.destroy()
        await finished(stream).catch(() => undefined)
        await rm(tmp, { force: true })
      },
    }
  }

  async open(key: string): Promise<Readable | null> {
    const file = this.pathOf(key)
    try {
      await stat(file)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
    return createReadStream(file)
  }

  async size(key: string): Promise<number | null> {
    try {
      return (await stat(this.pathOf(key))).size
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true })
  }
}
