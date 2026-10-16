import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FsBlobStore, sha256Hex } from '@crm/node-kit'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { isMediaExpiredError, MediaService } from './index'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
const store = () => {
  const dir = mkdtempSync(join(tmpdir(), 'crm-media-'))
  dirs.push(dir)
  return new FsBlobStore({ dir })
}
const image = (size: number | null = 3) => ({ kind: 'image' as const, mime: 'image/png', size, sha256: 'declarado' })
const expired = () => Object.assign(new Error('Request failed with status code 410'), { output: { statusCode: 410 } })

describe('MediaService', () => {
  it('eager: baixa, grava no BlobStore e devolve handle ready com sha256 dos bytes', async () => {
    const bytes = new Uint8Array([9, 8, 7])
    const blobs = store()
    const svc = new MediaService({ blobStore: blobs, download: async () => bytes })
    const h = await svc.describe('s1', { id: 'm1', media: { ...image(), file_name: 'a.png' } })
    expect(h).toMatchObject({ session_id: 's1', message_id: 'm1', mime: 'image/png', size: 3, sha256: sha256Hex(bytes), status: 'ready', file_name: 'a.png' })
    expect(await blobs.has(h!.key!)).toBe(true)
  })

  it('AC-03: 410 pede reupload UMA vez e tenta de novo', async () => {
    const download = vi.fn().mockRejectedValueOnce(expired()).mockResolvedValueOnce(new Uint8Array([1]))
    const reupload = vi.fn(async () => undefined)
    const svc = new MediaService({ blobStore: store(), download, reupload })
    const h = await svc.describe('s1', { id: 'm1', media: image(1) })
    expect(h?.status).toBe('ready')
    expect(reupload).toHaveBeenCalledTimes(1)
    expect(reupload).toHaveBeenCalledWith('s1', 'm1')
    expect(download).toHaveBeenCalledTimes(2)
  })

  it('AC-03: falha definitiva → status unavailable (não lança, um único reupload)', async () => {
    const download = vi.fn(async () => {
      throw expired()
    })
    const reupload = vi.fn(async () => undefined)
    const warn = vi.fn()
    const svc = new MediaService({ blobStore: store(), download, reupload, logger: { warn } })
    const h = await svc.describe('s1', { id: 'm1', media: image() })
    expect(h).toEqual({ session_id: 's1', message_id: 'm1', mime: 'image/png', size: 3, sha256: 'declarado', key: null, status: 'unavailable' })
    expect(reupload).toHaveBeenCalledTimes(1)
    expect(download).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalled()
  })

  it('erro que não é 410 não pede reupload', async () => {
    const reupload = vi.fn(async () => undefined)
    const svc = new MediaService({ blobStore: store(), download: async () => Promise.reject(new Error('timeout')), reupload })
    expect((await svc.describe('s1', { id: 'm1', media: image() }))?.status).toBe('unavailable')
    expect(reupload).not.toHaveBeenCalled()
  })

  it('lazy: vídeo, figurinha, acima do limite e histórico saem pending sem baixar', async () => {
    const download = vi.fn(async () => new Uint8Array([1]))
    const svc = new MediaService({ blobStore: store(), download, eagerMaxBytes: 10 })
    expect((await svc.describe('s1', { id: 'v', media: { kind: 'video', mime: 'video/mp4', size: 5, sha256: null } }))?.status).toBe('pending')
    expect((await svc.describe('s1', { id: 'st', media: { kind: 'sticker', mime: 'image/webp', size: 5, sha256: null } }))?.status).toBe('pending')
    expect((await svc.describe('s1', { id: 'big', media: image(11) }))?.status).toBe('pending')
    expect((await svc.describe('s1', { id: 'h', media: image(), historical: true }))?.status).toBe('pending')
    expect(download).not.toHaveBeenCalled()
    expect(await svc.describe('s1', { id: 'txt' })).toBeUndefined()
    // fetch baixa sob demanda.
    expect((await svc.fetch('s1', 'v', { mime: 'video/mp4' })).handle.status).toBe('ready')
  })

  it('sem download nem transporte → unavailable', async () => {
    const svc = new MediaService({ blobStore: store(), getTransport: () => undefined })
    expect((await svc.describe('s1', { id: 'm', media: image() }))?.status).toBe('unavailable')
  })

  it('isMediaExpiredError', () => {
    expect(isMediaExpiredError({ status: 410 })).toBe(true)
    expect(isMediaExpiredError({ statusCode: 410 })).toBe(true)
    expect(isMediaExpiredError(expired())).toBe(true)
    expect(isMediaExpiredError(new Error('Gone'))).toBe(true)
    expect(isMediaExpiredError(new Error('404'))).toBe(false)
    expect(isMediaExpiredError(null)).toBe(false)
  })
})
