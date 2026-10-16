// AC-T21-02 (imagem gravada no BlobStore com handle correto) e AC-T21-03 (410 → reuploadRequest uma vez; falha → 'unavailable').
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { JID, eventsMod, fakeManager, kit, mediaMod, newRedis, rand, readEvents, sha256hex, tempBlobDir, transportMod } from './support'

let redis: any
let attachEventOutbox: any
let MediaService: any
let FakeTransport: any
let FsBlobStore: any
const streams: string[] = []
const cleanups: Array<() => void> = []
const outboxes: any[] = []

beforeAll(async () => {
  redis = await newRedis()
  ;({ attachEventOutbox } = await eventsMod())
  ;({ MediaService } = await mediaMod())
  ;({ FakeTransport } = await transportMod())
  ;({ FsBlobStore } = await kit())
})

afterAll(async () => {
  for (const o of outboxes) o.detach?.()
  if (streams.length) await redis.del(...streams).catch(() => {})
  await redis?.quit().catch(() => {})
  for (const c of cleanups) c()
})

function setup(media: any) {
  const stream = `t21:${rand()}:wsm:events`
  streams.push(stream)
  const manager = fakeManager()
  const outbox = attachEventOutbox(manager, undefined, redis, { stream, retryMs: 20, media })
  outboxes.push(outbox)
  return { stream, manager, outbox }
}

function blobStore() {
  const { dir, cleanup } = tempBlobDir()
  cleanups.push(cleanup)
  return new FsBlobStore({ dir })
}

const imageBytes = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 2048 }, (_, i) => i % 251), 0xff, 0xd9])
const gone = () => Object.assign(new Error('Gone'), { status: 410, output: { statusCode: 410 } })
const imageMsg = (id: string) => ({
  id,
  from: JID('5511999998888'),
  type: 'imageMessage',
  text: 'legenda',
  media: { kind: 'image', mime: 'image/jpeg', size: null, sha256: null },
})

describe('T21 — mídia recebida (AC-T21-02)', () => {
  it('AC-T21-02 imagem é gravada no BlobStore e message.inbound traz media.key, mime, size e sha256 corretos', async () => {
    const store = blobStore()
    const t = new FakeTransport()
    const media = new MediaService({ blobStore: store, getTransport: () => t })
    const { stream, manager, outbox } = setup(media)
    t.open() // sessão conectada: o download padrão usa o transporte vivo
    manager.emit('connected', { sessionId: 'sM', transport: t, state: 'STABLE' })
    const bytes = imageBytes()
    t.receive({ ...imageMsg('IMG-1'), data: bytes } as any)
    await outbox.flush()

    const ev = (await readEvents(redis, stream)).find((e) => e.type === 'message.inbound')
    expect(ev, 'message.inbound não publicado').toBeDefined()
    const h = ev.message.media
    expect(h).toMatchObject({ session_id: 'sM', message_id: 'IMG-1', mime: 'image/jpeg', size: bytes.length, sha256: sha256hex(bytes), status: 'ready' })
    expect(typeof h.key).toBe('string')
    const stored = await store.get(h.key)
    expect(stored, 'blob não gravado').not.toBeNull()
    expect(Buffer.from(stored!)).toEqual(Buffer.from(bytes))
  })

  it('AC-T21-02 o evento com mídia mantém a ordem da sessão (espera o download)', async () => {
    const store = blobStore()
    const t = new FakeTransport()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const download = vi.fn(async (_s: string, id: string) => {
      await gate
      return t.media.get(id)!
    })
    const media = new MediaService({ blobStore: store, download })
    const { stream, manager, outbox } = setup(media)
    manager.emit('connected', { sessionId: 'sO', transport: t, state: 'STABLE' })
    t.receive({ ...imageMsg('IMG-A'), data: imageBytes() } as any)
    t.receive({ id: 'TXT-B', from: JID('5511999998888'), text: 'depois da foto' })
    setTimeout(release, 150)
    await outbox.flush()
    const ids = (await readEvents(redis, stream)).filter((e) => e.type === 'message.inbound').map((e) => e.message.id)
    expect(ids).toEqual(['IMG-A', 'TXT-B'])
  })
})

describe('T21 — mídia expirada (AC-T21-03)', () => {
  it('AC-T21-03 410 no download aciona reuploadRequest uma vez e o retry grava a mídia', async () => {
    const store = blobStore()
    const bytes = imageBytes()
    let calls = 0
    const download = vi.fn(async () => {
      if (++calls === 1) throw gone()
      return bytes
    })
    const reupload = vi.fn(async () => undefined)
    const media = new MediaService({ blobStore: store, download, reupload })
    const t = new FakeTransport()
    const { stream, manager, outbox } = setup(media)
    manager.emit('connected', { sessionId: 'sE', transport: t, state: 'STABLE' })
    t.receive(imageMsg('IMG-410') as any)
    await outbox.flush()
    expect(reupload).toHaveBeenCalledTimes(1)
    expect(reupload.mock.calls[0]).toEqual(['sE', 'IMG-410'])
    const ev = (await readEvents(redis, stream)).find((e) => e.type === 'message.inbound')
    expect(ev.message.media).toMatchObject({ status: 'ready', size: bytes.length, sha256: sha256hex(bytes) })
  })

  it("AC-T21-03 falha definitiva publica o evento com media.status = 'unavailable' sem bloquear os seguintes", async () => {
    const download = vi.fn(async () => {
      throw gone()
    })
    const reupload = vi.fn(async () => undefined)
    const media = new MediaService({ blobStore: blobStore(), download, reupload })
    const t = new FakeTransport()
    const { stream, manager, outbox } = setup(media)
    manager.emit('connected', { sessionId: 'sU', transport: t, state: 'STABLE' })
    t.receive(imageMsg('IMG-DEAD') as any)
    t.receive({ id: 'TXT-NEXT', from: JID('5511999998888'), text: 'segue a vida' })
    await outbox.flush()
    expect(reupload).toHaveBeenCalledTimes(1)
    const inbound = (await readEvents(redis, stream)).filter((e) => e.type === 'message.inbound')
    expect(inbound.map((e) => e.message.id)).toEqual(['IMG-DEAD', 'TXT-NEXT'])
    expect(inbound[0].message.media.status).toBe('unavailable')
    expect(inbound[0].message.media.message_id).toBe('IMG-DEAD')
  })
})
