// Postgres real + blob store em diretório temporário: atalho único, variáveis, prévia, figurinhas e favoritas.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { companies, contacts, createDb, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { FsBlobStore } from '@crm/node-kit'
import { MediaService } from '../media/service'
import { ContentError } from './rules'
import { ContentService } from './service'

let tmp: TempDatabase
let db: Database
let dir: string
let svc: ContentService
let media: MediaService
let n = 0

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crm-content-'))
  tmp = await createTempDatabase({ migrate: true })
  db = createDb(tmp.url, { max: 4 })
  media = new MediaService({ blobStore: new FsBlobStore({ dir }), signingKey: Buffer.alloc(32, 7) })
  svc = new ContentService({ db, media })
}, 60_000)
afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
  rmSync(dir, { recursive: true, force: true })
}, 60_000)

async function company() {
  n += 1
  const [c] = await db.insert(companies).values({ name: `C${n}`, slug: `c-t35-${n}-${Date.now()}` }).returning()
  return c!.id
}
async function user() {
  n += 1
  const [u] = await db.insert(users).values({ email: `c${n}-${Date.now()}@x.test`, passwordHash: 'x', name: 'U' }).returning()
  return u!.id
}
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])

const rejects = async (p: Promise<unknown>, kind: ContentError['kind'], code?: string) => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(ContentError)
  expect((err as ContentError).kind).toBe(kind)
  if (code) expect((err as ContentError).errorCode).toBe(code)
}

describe('ContentService', () => {
  it('resposta rápida: atalho normalizado, único na empresa, ações validadas e ordenadas', async () => {
    const cid = await company()
    const qr = await svc.createQuickReply(cid, null, {
      shortcut: 'Boas Vindas!',
      actions: [
        { type: 'send_contact', order: 1, config: { contact_name: 'Suporte', contact_phone: '+5511999990000' } },
        { type: 'send_message', order: 0, config: { message_text: 'Olá {first_name}' } },
      ],
    })
    expect(qr.shortcut).toBe('boas vindas')
    expect(qr.actions.map((a) => [a.type, a.order])).toEqual([
      ['send_message', 0],
      ['send_contact', 1],
    ])
    expect(qr.preview).toBe('Olá {first_name} (+1 ações)')
    await rejects(svc.createQuickReply(cid, null, { shortcut: 'boas   VINDAS', actions: [{ type: 'send_message', config: { message_text: 'x' } }] }), 'conflict', 'shortcut_taken')
    await rejects(svc.createQuickReply(cid, null, { shortcut: '???', actions: [{ type: 'send_message', config: { message_text: 'x' } }] }), 'validation')
    await rejects(svc.createQuickReply(cid, null, { shortcut: 'vazio', actions: [] }), 'validation')
    await rejects(svc.createQuickReply(cid, null, { shortcut: 'midia', actions: [{ type: 'send_multi_media', config: { media_type: 'image', media_id: 'falso' } }] }), 'validation')
    // Outra empresa pode usar o mesmo atalho.
    expect((await svc.createQuickReply(await company(), null, { shortcut: 'boas vindas', actions: [{ type: 'send_message', config: { message_text: 'x' } }] })).shortcut).toBe('boas vindas')
    expect((await svc.listQuickReplies(cid, { search: 'olá' })).items).toHaveLength(1)
  })

  it('variável global: número inválido, nome imutável e mudança de tipo', async () => {
    const cid = await company()
    await rejects(svc.createGlobal(cid, { name: 'preco', type: 'number', value: 'abc' }), 'validation')
    const v = await svc.createGlobal(cid, { name: 'preco', type: 'number', value: '19.9' })
    expect(v).toMatchObject({ name: 'g_preco', type: 'number', value: '19.9' })
    await rejects(svc.createGlobal(cid, { name: 'g_PRECO' }), 'conflict', 'name_taken')
    await rejects(svc.updateGlobal(cid, v.id, { name: 'g_outro' }), 'validation', 'name_immutable')
    expect((await svc.updateGlobal(cid, v.id, { name: 'g_preco', value: 25 })).value).toBe('25')
    const t = await svc.createGlobal(cid, { name: 'nome', value: 'Loja' })
    await rejects(svc.updateGlobal(cid, t.id, { type: 'number' }), 'validation')
    expect(await svc.globalsMap(cid)).toEqual({ g_preco: 25, g_nome: 'Loja' })
  })

  it('prévia de modelo com variáveis do contato e globais; contato de outra empresa → não encontrado', async () => {
    const cid = await company()
    const [ct] = await db.insert(contacts).values({ companyId: cid, name: 'Maria Silva', phoneE164: '+5511988887777' }).returning()
    await svc.createGlobal(cid, { name: 'loja', value: 'Loja Centro' })
    const t = await svc.createTemplate(cid, null, {
      name: 'Promo',
      header: { type: 'text', text: 'Promoção' },
      body: 'Olá {first_name}, a {g_loja} chama!',
      footer: 'Responda com o número',
      buttons: [
        { type: 'reply', text: 'Quero' },
        { type: 'url', text: 'Site', url: 'https://ex.test/p' },
      ],
    })
    const out = await svc.preview(cid, { templateId: t.id, contactId: ct!.id })
    expect(out.text).toBe('Promoção\n\nOlá Maria, a Loja Centro chama!\n\n1 - Quero\n\nSite: https://ex.test/p\n\nResponda com o número')
    await rejects(svc.createTemplate(cid, null, { name: 'promo', body: 'x' }), 'conflict', 'name_taken')
    await rejects(svc.createTemplate(cid, null, { name: 'b', body: 'x', buttons: [{ type: 'url', text: 'x', url: 'ftp://x' }] }), 'validation')
    await rejects(svc.preview(await company(), { template: 'x', contactId: ct!.id }), 'not_found')
  })

  it('figurinha: só webp até 100 KB; favoritas por usuário', async () => {
    const cid = await company()
    const [u1, u2] = [await user(), await user()]
    await rejects(svc.uploadSticker(cid, u1, { data: new Uint8Array([1, 2, 3]), mime: 'image/png' }), 'unsupported_media', 'sticker_not_webp')
    await rejects(svc.uploadSticker(cid, u1, { data: new Uint8Array(100 * 1024 + 1), mime: 'image/webp' }), 'payload_too_large')
    const s = await svc.uploadSticker(cid, u1, { data: WEBP, mime: 'image/webp', fileName: 'oi.webp' })
    expect(s).toMatchObject({ name: 'oi', mime: 'image/webp', favorite: false })
    expect((await media.get(cid, s.media_id)).mime).toBe('image/webp')
    await svc.setFavorite(cid, u1, s.id, true)
    expect((await svc.listStickers(cid, u1, { favorites: true })).map((x) => x.id)).toEqual([s.id])
    expect(await svc.listStickers(cid, u2, { favorites: true })).toEqual([])
    expect((await svc.listStickers(cid, u2)).map((x) => x.favorite)).toEqual([false])
    await svc.setFavorite(cid, u1, s.id, false)
    expect(await svc.listStickers(cid, u1, { favorites: true })).toEqual([])
    await rejects(svc.setFavorite(await company(), u1, s.id, true), 'not_found')
  })
})
