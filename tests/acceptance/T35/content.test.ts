// AC-T35-01..05: atalho normalizado/único, variáveis globais, modelo renderizado como texto, permissão das respostas
// rápidas e figurinhas (só webp, favoritas por usuário).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectApiError } from '../helpers/http'
import { uuid } from '../helpers/factories'
import { PNG, fieldPaths, newContact, newMember, newOwner, startEnv, upload, uploadMedia, webp, type Env, type User } from './setup'

let env: Env
let owner: User
beforeAll(async () => {
  env = await startEnv()
  owner = await newOwner(env)
})
afterAll(async () => {
  await env?.close()
})

const textAction = (message_text = 'Olá!') => ({ type: 'send_message', order: 0, config: { message_text } })
const rnd = () => Math.random().toString(36).slice(2, 8)

async function quickReply(u: User, shortcut: string, actions = [textAction()]) {
  return u.c.post('/api/quick-replies', { shortcut, actions })
}

describe('AC-T35-01 atalho normalizado e único', () => {
  it('AC-T35-01 "Boas Vindas!" vira "boas vindas"; duplicado na empresa (após normalizar) → 409', async () => {
    const res = await quickReply(owner, 'Boas Vindas!')
    expect(res.status, res.text).toBe(201)
    expect(res.body.quick_reply.shortcut).toBe('boas vindas')
    expect(res.body.quick_reply.actions).toMatchObject([{ type: 'send_message', order: 0, config: { message_text: 'Olá!' } }])
    const got = await owner.c.get(`/api/quick-replies/${res.body.quick_reply.id}`)
    expect(got.body.quick_reply.shortcut).toBe('boas vindas')

    for (const dup of ['boas vindas', 'BOAS VINDAS', '  Boas   Vindas?? ']) {
      const d = await quickReply(owner, dup)
      expectApiError(d, 'CONFLICT', 409)
      expect(d.body.error.details?.error_code).toBe('shortcut_taken')
    }
    // outra empresa pode usar o mesmo atalho
    const other = await newOwner(env)
    expect((await quickReply(other, 'Boas Vindas!')).status).toBe(201)
    // a lista da empresa tem um só
    const list = await owner.c.get('/api/quick-replies?search=boas')
    expect(list.status, list.text).toBe(200)
    expect(list.body.items.filter((q: any) => q.shortcut === 'boas vindas')).toHaveLength(1)
  })

  it('AC-T35-01 normalização mantém [a-z0-9_ -]; vazio após normalizar ou sem ações → 422; renomear para atalho existente → 409', async () => {
    const r = await quickReply(owner, `Pix_Rápido-2 ${rnd()}`)
    expect(r.status, r.text).toBe(201)
    expect(r.body.quick_reply.shortcut).toMatch(/^pix_rpido-2 [a-z0-9]+$/)

    const empty = await quickReply(owner, '!!! ???')
    expectApiError(empty, 'VALIDATION_ERROR', 422)
    expect(fieldPaths(empty).join(' ')).toContain('shortcut')
    expectApiError(await owner.c.post('/api/quick-replies', { shortcut: `sem acoes ${rnd()}`, actions: [] }), 'VALIDATION_ERROR', 422)

    const a = (await quickReply(owner, `alfa ${rnd()}`)).body.quick_reply
    const b = (await quickReply(owner, `beta ${rnd()}`)).body.quick_reply
    const clash = await owner.c.patch(`/api/quick-replies/${b.id}`, { shortcut: a.shortcut.toUpperCase() })
    expectApiError(clash, 'CONFLICT', 409)
    const ok = await owner.c.patch(`/api/quick-replies/${b.id}`, { shortcut: 'Gama Nova!', actions: [textAction('um'), { type: 'send_message', order: 1, config: { message_text: 'dois' } }] })
    expect(ok.status, ok.text).toBe(200)
    expect(ok.body.quick_reply.shortcut).toBe('gama nova')
    expect(ok.body.quick_reply.actions.map((x: any) => x.config.message_text)).toEqual(['um', 'dois'])
  })
})

describe('AC-T35-02 variáveis globais', () => {
  it('AC-T35-02 tipo number com valor "abc" → 422 (criar e editar); valores numéricos válidos aceitos', async () => {
    const bad = await owner.c.post('/api/global-variables', { name: `preco_${rnd()}`, type: 'number', value: 'abc' })
    expectApiError(bad, 'VALIDATION_ERROR', 422)
    expect(fieldPaths(bad)).toContain('value')
    for (const v of ['1,5', '1e3', '12abc', '--1']) {
      expectApiError(await owner.c.post('/api/global-variables', { name: `n_${rnd()}`, type: 'number', value: v }), 'VALIDATION_ERROR', 422)
    }
    const ok = await owner.c.post('/api/global-variables', { name: `preco_${rnd()}`, type: 'number', value: '-12.50' })
    expect(ok.status, ok.text).toBe(201)
    expect(ok.body.global_variable).toMatchObject({ type: 'number', value: '-12.50' })
    expect(ok.body.global_variable.name).toMatch(/^g_preco_/)
    const id = ok.body.global_variable.id
    expectApiError(await owner.c.patch(`/api/global-variables/${id}`, { value: 'abc' }), 'VALIDATION_ERROR', 422)
    expect((await owner.c.patch(`/api/global-variables/${id}`, { value: '7' })).body.global_variable.value).toBe('7')

    // texto aceita qualquer coisa; mudar para number com valor não numérico → 422
    const txt = (await owner.c.post('/api/global-variables', { name: `loja_${rnd()}`, type: 'text', value: 'Loja Centro' })).body.global_variable
    expect(txt.type).toBe('text')
    expectApiError(await owner.c.patch(`/api/global-variables/${txt.id}`, { type: 'number' }), 'VALIDATION_ERROR', 422)
    const still = await owner.c.get(`/api/global-variables/${txt.id}`)
    if (still.status === 200) expect(still.body.global_variable.type).toBe('text')
  })

  it('AC-T35-02 renomear → 422 name_immutable; prefixo g_ automático; nome fora do padrão → 422; repetido → 409', async () => {
    const base = `cupom_${rnd()}`
    const created = await owner.c.post('/api/global-variables', { name: base, type: 'text', value: 'PROMO10', description: 'cupom' })
    expect(created.status, created.text).toBe(201)
    const gv = created.body.global_variable
    expect(gv.name).toBe(`g_${base}`)

    const rename = await owner.c.patch(`/api/global-variables/${gv.id}`, { name: 'g_outro' })
    expectApiError(rename, 'VALIDATION_ERROR', 422)
    expect(rename.body.error.details?.error_code).toBe('name_immutable')
    expect(fieldPaths(rename)).toContain('name')
    const list = await owner.c.get(`/api/global-variables?search=${base}`)
    expect(list.body.items.map((x: any) => x.name)).toEqual([`g_${base}`])

    // descrição e valor continuam editáveis
    const upd = await owner.c.patch(`/api/global-variables/${gv.id}`, { description: 'novo', value: 'PROMO20' })
    expect(upd.status, upd.text).toBe(200)
    expect(upd.body.global_variable).toMatchObject({ name: `g_${base}`, description: 'novo', value: 'PROMO20' })

    const already = await owner.c.post('/api/global-variables', { name: `g_ja_${base}`, type: 'text' })
    expect(already.body.global_variable.name).toBe(`g_ja_${base}`)
    for (const bad of ['com espaço', 'hífen-x', 'acentuação', '']) {
      const r = await owner.c.post('/api/global-variables', { name: bad, type: 'text' })
      expectApiError(r, 'VALIDATION_ERROR', 422)
      expect(fieldPaths(r)).toContain('name')
    }
    const dup = await owner.c.post('/api/global-variables', { name: base, type: 'text' })
    expectApiError(dup, 'CONFLICT', 409)
    expect(dup.body.error.details?.error_code).toBe('name_taken')
  })
})

describe('AC-T35-03 modelo interno renderizado como texto', () => {
  it('AC-T35-03 botões viram menu numerado e links no corpo; a prévia substitui variáveis do contato e globais', async () => {
    const loja = `loja_${rnd()}`
    await owner.c.post('/api/global-variables', { name: loja, type: 'text', value: 'Loja Centro' })
    const contactId = await newContact(env, owner.companyId, 'Maria Souza', '+5511988887777', 'maria@example.test')
    const created = await owner.c.post('/api/message-templates', {
      name: `promo_${rnd()}`,
      header: { type: 'text', text: 'Promoção da semana' },
      body: `Olá {first_name}, a {g_${loja}} tem novidades para você ({phone_number}).`,
      footer: 'Equipe de vendas',
      buttons: [
        { type: 'reply', text: 'Quero' },
        { type: 'reply', text: 'Agora não' },
        { type: 'url', text: 'Ver catálogo', url: 'https://example.test/catalogo' },
        { type: 'phone', text: 'Ligue', phone: '+5511900001111' },
      ],
    })
    expect(created.status, created.text).toBe(201)
    const tpl = created.body.template
    expect(tpl).not.toHaveProperty('status')

    const res = await owner.c.post('/api/content/render', { template_id: tpl.id, contact_id: contactId })
    expect(res.status, res.text).toBe(200)
    const text: string = res.body.text
    expect(res.body.media).toBeNull()
    const blocks = text.split(/\n\s*\n/).map((b) => b.trim())
    expect(blocks[0]).toBe('Promoção da semana')
    // {phone_number} sem '+', no mesmo formato do motor de fluxos (T25): a prévia mostra o que o fluxo envia
    expect(blocks[1]).toBe('Olá Maria, a Loja Centro tem novidades para você (5511988887777).')
    expect(text).toMatch(/^1 - Quero$/m)
    expect(text).toMatch(/^2 - Agora não$/m)
    expect(text.indexOf('1 - Quero')).toBeLessThan(text.indexOf('2 - Agora não'))
    expect(text).toContain('Ver catálogo: https://example.test/catalogo')
    expect(text).toContain('Ligue: +5511900001111')
    expect(blocks[blocks.length - 1]).toBe('Equipe de vendas')
    expect(text).not.toMatch(/\{[a-z_]+\}/)
  })

  it('AC-T35-03 prévia de texto avulso e de resposta rápida; header de mídia vai em media; contato de outra empresa → 404', async () => {
    const contactId = await newContact(env, owner.companyId, 'João Pedro Lima', '+5511977776666')
    const avulso = await owner.c.post('/api/content/render', { template: 'Oi {full_name} / {first_name}', contact_id: contactId })
    expect(avulso.status, avulso.text).toBe(200)
    expect(avulso.body.text).toBe('Oi João Pedro Lima / João')

    const mediaId = await uploadMedia(env, owner, PNG)
    const withMedia = await owner.c.post('/api/message-templates', { name: `banner_${rnd()}`, header: { type: 'image', media_id: mediaId }, body: 'Confira, {first_name}!' })
    expect(withMedia.status, withMedia.text).toBe(201)
    const r = await owner.c.post('/api/content/render', { template_id: withMedia.body.template.id, contact_id: contactId })
    expect(r.body.media).toMatchObject({ type: 'image', media_id: mediaId })
    expect(r.body.text).toBe('Confira, João!')

    const qr = (await quickReply(owner, `saudacao ${rnd()}`, [textAction('Bom dia {first_name}'), { type: 'send_message', order: 1, config: { message_text: 'Seu número: {phone_number}' } }])).body.quick_reply
    const rq = await owner.c.post('/api/content/render', { quick_reply_id: qr.id, contact_id: contactId })
    expect(rq.status, rq.text).toBe(200)
    expect(rq.body.actions.map((a: any) => a.config.message_text)).toEqual(['Bom dia João', 'Seu número: 5511977776666'])

    const other = await newOwner(env)
    const foreign = await newContact(env, other.companyId, 'Fulano de Tal')
    expectApiError(await owner.c.post('/api/content/render', { template: 'Oi {first_name}', contact_id: foreign }), 'NOT_FOUND', 404)
    expectApiError(await other.c.post('/api/content/render', { template_id: withMedia.body.template.id, contact_id: foreign }), 'NOT_FOUND', 404)
    // nome do modelo único por empresa
    const dupName = await owner.c.post('/api/message-templates', { name: withMedia.body.template.name, body: 'x' })
    expectApiError(dupName, 'CONFLICT', 409)
    expect(dupName.body.error.details?.error_code).toBe('name_taken')
  })
})

describe('AC-T35-04 permissão das respostas rápidas', () => {
  it('AC-T35-04 member com a matriz padrão (exceção: quick_replies.edit) cria e edita, mas não exclui', async () => {
    const member = await newMember(env, owner.companyId, null)
    const created = await quickReply(member, `do membro ${rnd()}`)
    expect(created.status, created.text).toBe(201)
    const id = created.body.quick_reply.id
    const edited = await member.c.patch(`/api/quick-replies/${id}`, { actions: [textAction('editado pelo membro')] })
    expect(edited.status, edited.text).toBe(200)
    expect(edited.body.quick_reply.actions[0].config.message_text).toBe('editado pelo membro')
    const ownerCreated = (await quickReply(owner, `do dono ${rnd()}`)).body.quick_reply
    expect((await member.c.patch(`/api/quick-replies/${ownerCreated.id}`, { shortcut: `renomeado ${rnd()}` })).status).toBe(200)
    expectApiError(await member.c.delete(`/api/quick-replies/${id}`), 'FORBIDDEN', 403)
    // modelos: member só vê
    expect((await member.c.get('/api/message-templates')).status).toBe(200)
    expectApiError(await member.c.post('/api/message-templates', { name: `m_${rnd()}`, body: 'x' }), 'FORBIDDEN', 403)
    // variáveis globais: concedidas a todos
    expect((await member.c.post('/api/global-variables', { name: `m_${rnd()}`, type: 'text' })).status).toBe(201)
  })

  it('AC-T35-04 com permissões explícitas: com settings.quick_replies.edit edita; sem a chave → 403', async () => {
    const qr = (await quickReply(owner, `alvo ${rnd()}`)).body.quick_reply
    const editor = await newMember(env, owner.companyId, ['settings.quick_replies.view', 'settings.quick_replies.edit'])
    expect((await editor.c.patch(`/api/quick-replies/${qr.id}`, { actions: [textAction('ok')] })).status).toBe(200)
    expect((await quickReply(editor, `editor ${rnd()}`)).status).toBe(201)

    const viewer = await newMember(env, owner.companyId, ['settings.quick_replies.view'])
    expect((await viewer.c.get('/api/quick-replies')).status).toBe(200)
    expect((await viewer.c.get(`/api/quick-replies/${qr.id}`)).status).toBe(200)
    expectApiError(await viewer.c.post('/api/quick-replies', { shortcut: `viewer ${rnd()}`, actions: [textAction()] }), 'FORBIDDEN', 403)
    expectApiError(await viewer.c.patch(`/api/quick-replies/${qr.id}`, { actions: [textAction('não')] }), 'FORBIDDEN', 403)
    expectApiError(await viewer.c.delete(`/api/quick-replies/${qr.id}`), 'FORBIDDEN', 403)
    const after = await owner.c.get(`/api/quick-replies/${qr.id}`)
    expect(after.body.quick_reply.actions[0].config.message_text).toBe('ok')

    const nobody = await newMember(env, owner.companyId, ['chat.view'])
    expectApiError(await nobody.c.get('/api/quick-replies'), 'FORBIDDEN', 403)
    // de outra empresa → 404
    const other = await newOwner(env)
    expectApiError(await other.c.get(`/api/quick-replies/${qr.id}`), 'NOT_FOUND', 404)
    expectApiError(await other.c.patch(`/api/quick-replies/${qr.id}`, { actions: [textAction()] }), 'NOT_FOUND', 404)
  })
})

describe('AC-T35-05 figurinhas', () => {
  it('AC-T35-05 só image/webp é aceito (outros → 415); acima de 100 KB → 413', async () => {
    const ok = await upload(env, owner, '/api/stickers', webp(), 'image/webp', 'gato.webp', { name: 'Gato' })
    expect(ok.status, ok.text).toBe(201)
    expect(ok.body.sticker).toMatchObject({ name: 'Gato', mime: 'image/webp', favorite: false })
    const media = await env.app.request(ok.body.sticker.url, { headers: { cookie: `crm_session=${owner.token}`, 'x-company-id': owner.companyId } })
    expect(media.status).toBe(200)
    expect(Buffer.from(await media.arrayBuffer()).equals(Buffer.from(webp()))).toBe(true)

    for (const [bytes, mime, name] of [
      [PNG, 'image/png', 'a.png'],
      [new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), 'image/jpeg', 'a.jpg'],
      [new TextEncoder().encode('GIF89a'), 'image/gif', 'a.gif'],
    ] as const) {
      const r = await upload(env, owner, '/api/stickers', bytes, mime, name)
      expect(r.status, r.text).toBe(415)
      expect(r.body?.error?.code).toBe('UNSUPPORTED_MEDIA')
    }
    const big = await upload(env, owner, '/api/stickers', webp(100 * 1024 + 16), 'image/webp', 'grande.webp')
    expect(big.status, big.text).toBe(413)
    expect(big.body?.error?.code).toBe('PAYLOAD_TOO_LARGE')
    const items = (await owner.c.get('/api/stickers')).body.items
    expect(items.map((s: any) => s.id)).toEqual([ok.body.sticker.id])
  })

  it('AC-T35-05 favoritas são por usuário; figurinha de outra empresa não aparece nem pode ser favoritada', async () => {
    const s1 = (await upload(env, owner, '/api/stickers', webp(10), 'image/webp', 's1.webp')).body.sticker
    const s2 = (await upload(env, owner, '/api/stickers', webp(20), 'image/webp', 's2.webp')).body.sticker
    const colleague = await newMember(env, owner.companyId, ['chat.view'])

    const fav = await owner.c.post(`/api/stickers/${s1.id}/favorite`)
    expect(fav.status, fav.text).toBe(200)
    expect(fav.body.sticker).toMatchObject({ id: s1.id, favorite: true })
    expect((await owner.c.get('/api/stickers?favorites=1')).body.items.map((s: any) => s.id)).toEqual([s1.id])
    expect((await colleague.c.get('/api/stickers?favorites=1')).body.items).toEqual([])
    const seen = (await colleague.c.get('/api/stickers')).body.items
    expect(seen.find((s: any) => s.id === s1.id)?.favorite).toBe(false)

    await colleague.c.post(`/api/stickers/${s2.id}/favorite`)
    expect((await colleague.c.get('/api/stickers?favorites=1')).body.items.map((s: any) => s.id)).toEqual([s2.id])
    expect((await owner.c.get('/api/stickers?favorites=1')).body.items.map((s: any) => s.id)).toEqual([s1.id])

    const unfav = await owner.c.delete(`/api/stickers/${s1.id}/favorite`)
    expect(unfav.status, unfav.text).toBe(200)
    expect(unfav.body.sticker.favorite).toBe(false)
    expect((await owner.c.get('/api/stickers?favorites=1')).body.items).toEqual([])
    expect((await colleague.c.get('/api/stickers?favorites=1')).body.items.map((s: any) => s.id)).toEqual([s2.id])

    const other = await newOwner(env)
    expect((await other.c.get('/api/stickers')).body.items.map((s: any) => s.id)).not.toContain(s1.id)
    expectApiError(await other.c.post(`/api/stickers/${s1.id}/favorite`), 'NOT_FOUND', 404)
    expectApiError(await other.c.delete(`/api/stickers/${s1.id}`), 'NOT_FOUND', 404)
    expectApiError(await owner.c.post(`/api/stickers/${uuid()}/favorite`), 'NOT_FOUND', 404)

    const noChat = await newMember(env, owner.companyId, ['settings.quick_replies.view'])
    expectApiError(await noChat.c.get('/api/stickers'), 'FORBIDDEN', 403)

    expect((await owner.c.delete(`/api/stickers/${s2.id}`)).status).toBe(200)
    expect((await colleague.c.get('/api/stickers?favorites=1')).body.items).toEqual([])
  })
})
