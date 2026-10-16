// Armazenamento de arquivos (SPEC T05, AC-T05-04): porta `BlobStore` + `FsBlobStore` em disco (`STORAGE_DIR`).
// Endereçado por conteúdo: a chave é o sha256 (hex) dos bytes; o mesmo conteúdo vira a mesma chave (dedupe).
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

export interface BlobInfo {
  key: string
  size: number
  sha256: string
  mime: string
}

export interface BlobStore {
  /** Grava os bytes e devolve a chave (sha256) e os metadados. */
  put(data: Buffer | Uint8Array, mime: string): Promise<BlobInfo>
  /** Bytes do blob, ou `null` se não existir. Chave inválida (ex.: com `..`) lança `InvalidBlobKeyError`. */
  get(key: string): Promise<Buffer | null>
  /** Metadados do blob, ou `null` se não existir. */
  head(key: string): Promise<BlobInfo | null>
  has(key: string): Promise<boolean>
  delete(key: string): Promise<void>
}

export class InvalidBlobKeyError extends Error {
  constructor(key: string) {
    super(`chave de blob inválida: ${JSON.stringify(key.slice(0, 80))}`)
    this.name = 'InvalidBlobKeyError'
  }
}

const KEY_RE = /^[a-f0-9]{64}$/

/** Valida a chave (sha256 hex minúsculo). Rejeita `..`, separadores e qualquer outro caractere. */
export function assertBlobKey(key: string): string {
  if (typeof key !== 'string' || !KEY_RE.test(key)) throw new InvalidBlobKeyError(String(key))
  return key
}

export function sha256Hex(data: Buffer | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

const DEFAULT_MIME = 'application/octet-stream'

export interface FsBlobStoreOptions {
  /** Diretório raiz. Default: `STORAGE_DIR` ou `./storage`. */
  dir?: string
}

/** `BlobStore` em disco: `<dir>/<aa>/<bb>/<sha256>` + `<sha256>.json` com os metadados. Gravação atômica. */
export class FsBlobStore implements BlobStore {
  readonly dir: string

  /** `new FsBlobStore('/dados')` ou `new FsBlobStore({ dir })`. */
  constructor(opts: FsBlobStoreOptions | string = {}) {
    const dir = typeof opts === 'string' ? opts : opts.dir
    this.dir = resolve(dir || process.env.STORAGE_DIR || './storage')
  }

  private pathOf(key: string): string {
    assertBlobKey(key)
    const p = join(this.dir, key.slice(0, 2), key.slice(2, 4), key)
    // defesa em profundidade: o caminho final tem de ficar dentro da raiz
    if (!p.startsWith(this.dir + sep)) throw new InvalidBlobKeyError(key)
    return p
  }

  async put(data: Buffer | Uint8Array, mime: string): Promise<BlobInfo> {
    if (!(data instanceof Uint8Array)) throw new TypeError('put aceita Buffer ou Uint8Array')
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    const sha256 = sha256Hex(bytes)
    const info: BlobInfo = { key: sha256, size: bytes.length, sha256, mime: mime || DEFAULT_MIME }
    const file = this.pathOf(sha256)
    if (await exists(file)) return info
    await mkdir(join(file, '..'), { recursive: true })
    await atomicWrite(file, bytes)
    await atomicWrite(`${file}.json`, JSON.stringify({ size: info.size, mime: info.mime }))
    return info
  }

  async get(key: string): Promise<Buffer | null> {
    const file = this.pathOf(key)
    try {
      return await readFile(file)
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
  }

  async head(key: string): Promise<BlobInfo | null> {
    const file = this.pathOf(key)
    let size: number
    try {
      size = (await stat(file)).size
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
    let mime = DEFAULT_MIME
    try {
      const meta = JSON.parse(await readFile(`${file}.json`, 'utf8')) as { mime?: unknown }
      if (typeof meta.mime === 'string') mime = meta.mime
    } catch {
      // metadados ausentes: mantém o mime padrão
    }
    return { key, size, sha256: key, mime }
  }

  async has(key: string): Promise<boolean> {
    return exists(this.pathOf(key))
  }

  async delete(key: string): Promise<void> {
    const file = this.pathOf(key)
    await rm(file, { force: true })
    await rm(`${file}.json`, { force: true })
  }
}

async function atomicWrite(file: string, data: Buffer | string): Promise<void> {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(tmp, data)
  try {
    await rename(tmp, file)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch (err) {
    if (isNotFound(err)) return false
    throw err
  }
}

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT'
}
