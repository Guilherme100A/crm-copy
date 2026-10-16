// AC-T51-01..05: ações do nó Mensagem, atraso/presença, nó modelo (T35), Pix copia-e-cola e notificação interna.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { action, chain, crc16, node, run, sends, startEnv, tlv, world, type Env } from './support'

let env: Env
beforeAll(async () => {
  env = await startEnv()
})
afterAll(async () => {
  await env?.close()
})

describe('AC-T51-01 ações de envio do nó Mensagem', () => {
  it('AC-T51-01 send_message, mídias (imagem, vídeo, vídeo-nota, áudio PTT, view_once), arquivo, figurinha e contato chamam o gateway com o conteúdo certo', async () => {
    const w = await world(env)
    const def = chain(
      node('M', 'message', [
        action('a-txt', 'send_message', { message_text: 'Olá {first_name}, tudo bem?' }, 0),
        action(
          'a-img',
          'send_multi_media',
          { media_type: 'image', media_source: 'url', messages: [{ url: 'https://example.test/1.jpg', caption: 'Para {first_name}', view_once: true }, { url: 'https://example.test/2.jpg' }] },
          1,
        ),
        action('a-vid', 'send_multi_media', { media_type: 'video', media_source: 'url', media_url: 'https://example.test/v.mp4', messages: [{ caption: 'Vídeo' }] }, 2),
        action('a-ptv', 'send_multi_media', { media_type: 'video', media_source: 'url', media_url: 'https://example.test/nota.mp4', uazapi_video_type: 'ptv' }, 3),
        action('a-aud', 'send_multi_media', { media_type: 'audio', media_source: 'url', media_url: 'https://example.test/a.ogg' }, 4),
        action('a-aud2', 'send_multi_media', { media_type: 'audio', media_source: 'url', media_url: 'https://example.test/b.mp3', audio_forward: false }, 5),
        action('a-doc', 'send_file', { file_name: 'proposta.pdf', file_url: 'https://example.test/proposta.pdf' }, 6),
        action('a-stk', 'send_sticker', { sticker_name: 'oi', sticker_url: 'https://example.test/oi.webp' }, 7),
        action('a-ctt', 'send_contact', { contact_name: 'Suporte de {first_name}', contact_phone: '+5511955554444' }, 8),
      ]),
    )
    const r = await run(env, w, def)
    expect(r.error, String(r.error)).toBeNull()
    expect(r.status).toBe('completed')

    const s = sends(w)
    for (const req of s) {
      expect(req.sessionId).toBe(w.sessionId)
      expect(req.phone).toBe(w.contactPhone)
      expect(String(req.actor)).toMatch(/^flow:/)
    }
    const contents = s.map((x) => x.content)
    expect(contents[0]).toEqual({ text: 'Olá Maria, tudo bem?' })
    expect(contents[1]).toMatchObject({ image: { url: 'https://example.test/1.jpg' }, caption: 'Para Maria' })
    expect(s[1].viewOnce).toBe(true)
    expect(contents[2]).toMatchObject({ image: { url: 'https://example.test/2.jpg' } })
    expect(s[2].viewOnce ?? false).toBe(false)
    expect(contents[3]).toMatchObject({ video: { url: 'https://example.test/v.mp4' }, caption: 'Vídeo' })
    expect(contents[4]).toMatchObject({ video: { url: 'https://example.test/nota.mp4' }, ptv: true })
    expect(contents[5]).toMatchObject({ audio: { url: 'https://example.test/a.ogg' }, ptt: true })
    expect(contents[6]).toMatchObject({ audio: { url: 'https://example.test/b.mp3' }, ptt: false })
    expect(contents[7]).toMatchObject({ document: { url: 'https://example.test/proposta.pdf' }, fileName: 'proposta.pdf', mimetype: 'application/pdf' })
    expect(contents[8]).toEqual({ sticker: { url: 'https://example.test/oi.webp' } })
    expect(contents[9].contact.displayName).toBe('Suporte de Maria')
    expect(contents[9].contact.vcard).toMatch(/^BEGIN:VCARD/)
    expect(contents[9].contact.vcard).toContain('Suporte de Maria')
    expect(contents[9].contact.vcard).toContain('5511955554444')
    expect(contents[9].contact.vcard).toMatch(/END:VCARD\s*$/)
    expect(s).toHaveLength(10)
    // o gateway recebeu tudo
    expect(w.wa.sent).toHaveLength(10)
  })

  it('AC-T51-01 envios são idempotentes por ação: o mesmo step não reenvia', async () => {
    const w = await world(env)
    const r = await run(env, w, chain(node('M', 'message', [action('a1', 'send_message', { message_text: 'uma vez' })])))
    expect(r.status).toBe('completed')
    expect(w.wa.sent.map((m: any) => m.content.text)).toEqual(['uma vez'])
  })
})

describe('AC-T51-02 atraso entre mensagens e presença', () => {
  const delayDef = (cfg: Record<string, number>) =>
    chain(
      node('M', 'message', [
        action('t1', 'send_message', { message_text: 'antes' }, 0),
        action('d1', 'delay_between_messages', cfg, 1),
        action('t2', 'send_message', { message_text: 'depois' }, 2),
      ]),
    )
  const sleepBetween = (w: any) => {
    const tl = w.timeline
    const first = tl.findIndex((e: any) => e[0] === 'send' && e[1].content.text === 'antes')
    const second = tl.findIndex((e: any) => e[0] === 'send' && e[1].content.text === 'depois')
    return tl.slice(first + 1, second).filter((e: any) => e[0] === 'sleep').map((e: any) => e[1])
  }

  it('AC-T51-02 atraso aleatório entre mín e máx com RNG injetado (limites inclusivos) e fixo', async () => {
    const lo = await world(env)
    await run(env, lo, delayDef({ delay_min_seconds: 10, delay_max_seconds: 20 }), { rng: () => 0 })
    expect(sleepBetween(lo)).toEqual([10_000])

    const hi = await world(env)
    await run(env, hi, delayDef({ delay_min_seconds: 10, delay_max_seconds: 20 }), { rng: () => 0.9999 })
    expect(sleepBetween(hi)).toEqual([20_000])

    const mid = await world(env)
    await run(env, mid, delayDef({ delay_min_seconds: 10, delay_max_seconds: 20 }), { rng: () => 0.5 })
    const [ms] = sleepBetween(mid)
    expect(ms).toBeGreaterThanOrEqual(10_000)
    expect(ms).toBeLessThanOrEqual(20_000)
    expect(ms! % 1000).toBe(0)

    const fixed = await world(env)
    await run(env, fixed, delayDef({ delay_seconds: 7 }), { rng: () => 0.42 })
    expect(sleepBetween(fixed)).toEqual([7_000])
    // o atraso não envia nada
    expect(sends(fixed).map((x) => x.content.text)).toEqual(['antes', 'depois'])
  })

  it('AC-T51-02 atraso nunca passa de 120 s', async () => {
    const w = await world(env)
    await run(env, w, delayDef({ delay_min_seconds: 100, delay_max_seconds: 600 }), { rng: () => 0.9999 })
    const [ms] = sleepBetween(w)
    expect(ms).toBeLessThanOrEqual(120_000)
    expect(ms).toBeGreaterThanOrEqual(100_000)
  })

  it('AC-T51-02 presença composing antes do texto (com o atraso de digitação) e recording antes do áudio', async () => {
    const w = await world(env)
    await run(
      env,
      w,
      chain(
        node('M', 'message', [
          action('t1', 'send_message', { message_text: 'digitando', typing_delay_seconds: 3 }, 0),
          action('au', 'send_multi_media', { media_type: 'audio', media_source: 'url', media_url: 'https://example.test/a.ogg' }, 1),
          action('im', 'send_multi_media', { media_type: 'image', media_source: 'url', media_url: 'https://example.test/i.png' }, 2),
        ]),
      ),
    )
    const tl = w.timeline.map((e: any) => (e[0] === 'send' ? `send:${Object.keys(e[1].content)[0]}` : e[0] === 'presence' ? `presence:${e[3]}` : `sleep:${e[1]}`))
    const iText = tl.indexOf('send:text')
    const iAudio = tl.indexOf('send:audio')
    const iImage = tl.indexOf('send:image')
    expect(tl.slice(0, iText)).toContain('presence:composing')
    expect(tl.slice(tl.lastIndexOf('presence:composing', iText), iText)).toContain('sleep:3000')
    expect(tl.slice(iText + 1, iAudio)).toContain('presence:recording')
    expect(tl.slice(iAudio + 1, iImage)).toContain('presence:composing')
    const pres = w.timeline.filter((e: any) => e[0] === 'presence')
    for (const p of pres) expect([p[1], p[2]]).toEqual([w.sessionId, w.contactPhone])
  })
})

describe('AC-T51-03 nó modelo (modelo interno da T35)', () => {
  it('AC-T51-03 corpo renderizado com variáveis do contato e globais; botões viram menu numerado e links em texto', async () => {
    const w = await world(env)
    await env.q(`INSERT INTO crm.global_variables (company_id, name, type, value) VALUES ($1, 'g_loja', 'text', 'Loja Centro')`, [w.companyId])
    const [tpl] = await env.q(
      `INSERT INTO crm.message_templates (company_id, name, header, body, footer, buttons) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        w.companyId,
        'promo_semana',
        JSON.stringify({ type: 'text', text: 'Promoção' }),
        'Oi {first_name}, a {g_loja} separou ofertas para você.',
        'Equipe de vendas',
        JSON.stringify([
          { type: 'reply', text: 'Quero' },
          { type: 'reply', text: 'Agora não' },
          { type: 'url', text: 'Catálogo', url: 'https://example.test/cat' },
        ]),
      ],
    )
    const r = await run(env, w, chain(node('T', 'message', [action('tp', 'send_message', { message_text: '', message_template_id: tpl.id })])))
    expect(r.error, String(r.error)).toBeNull()
    expect(r.status).toBe('completed')
    const s = sends(w)
    expect(s).toHaveLength(1)
    const text: string = s[0].content.text
    expect(typeof text).toBe('string')
    expect(text).toContain('Promoção')
    expect(text).toContain('Oi Maria, a Loja Centro separou ofertas para você.')
    expect(text).toMatch(/^1 - Quero$/m)
    expect(text).toMatch(/^2 - Agora não$/m)
    expect(text).toContain('Catálogo: https://example.test/cat')
    expect(text).toContain('Equipe de vendas')
    expect(text.indexOf('Promoção')).toBeLessThan(text.indexOf('Oi Maria'))
    expect(text.indexOf('Oi Maria')).toBeLessThan(text.indexOf('1 - Quero'))
    expect(text).not.toMatch(/\{[a-z_]+\}/)
  })

  it('AC-T51-03 modelo de outra empresa não é usado (run falha, nada enviado)', async () => {
    const w = await world(env)
    const other = await world(env)
    const [tpl] = await env.q(`INSERT INTO crm.message_templates (company_id, name, body) VALUES ($1, 'alheio', 'segredo de outra empresa') RETURNING id`, [other.companyId])
    const r = await run(env, w, chain(node('T', 'message', [action('tp', 'send_message', { message_text: '', message_template_id: tpl.id })])))
    expect(sends(w).some((x) => String(x.content.text ?? '').includes('segredo'))).toBe(false)
    expect(r.status === 'failed' || r.error !== null, `status ${r.status}`).toBe(true)
  })
})

describe('AC-T51-04 Pix copia e cola (EMV com CRC16)', () => {
  it('AC-T51-04 crc16ccitt e pixEmv batem com vetores conhecidos (CCITT-FALSE e exemplo do manual do Pix)', () => {
    expect(env.core.crc16ccitt('123456789')).toBe('29B1')
    const emv = env.core.pixEmv({ key: '123e4567-e12b-12d1-a456-426655440000', merchantName: 'Fulano de Tal', city: 'BRASILIA', txid: '***' })
    expect(emv).toBe('00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D')
    const withAmount = env.core.pixEmv({ key: 'contato@example.test', merchantName: 'Loja', city: 'SAO PAULO', amount: 10, txid: 'PED123' })
    expect(withAmount.slice(-8, -4)).toBe('6304')
    expect(withAmount.slice(-4)).toBe(crc16(withAmount.slice(0, -4)))
    const f = tlv(withAmount)
    expect(f['54']).toBe('10.00')
    expect(f['53']).toBe('986')
    expect(f['58']).toBe('BR')
    expect(f['59']).toBe('Loja')
    expect(f['26']).toContain('br.gov.bcb.pix')
    expect(f['26']).toContain('contato@example.test')
  })

  it('AC-T51-04 nó Pix envia uma mensagem com a chave e o copia-e-cola válido', async () => {
    const w = await world(env)
    const key = '123e4567-e12b-12d1-a456-426655440000'
    const r = await run(env, w, chain(node('P', 'pix', [action('px', 'send_pix_button', { pix_key: key, pix_type: 'EVP', merchant_name: 'Loja Centro', amount_reais: 10 })])))
    expect(r.error, String(r.error)).toBeNull()
    expect(r.status).toBe('completed')
    const s = sends(w)
    expect(s).toHaveLength(1)
    const text: string = s[0].content.text
    expect(text).toContain(key)
    expect(text).toContain('R$ 10,00')
    // o EMV pode ter espaços (ex.: campo 59 'Loja Centro'); fica numa linha só
    const emv = /000201.+6304[0-9A-F]{4}/.exec(text)?.[0]
    expect(emv, text).toBeTruthy()
    expect(emv!.slice(-4)).toBe(crc16(emv!.slice(0, -4)))
    const f = tlv(emv!)
    expect(f['54']).toBe('10.00')
    expect(f['59']).toBe('Loja Centro')
    expect(f['26']).toContain(key)
    expect(s[0].sessionId).toBe(w.sessionId)
    expect(s[0].phone).toBe(w.contactPhone)
  })
})

describe('AC-T51-05 notificação para número interno', () => {
  it('AC-T51-05 send_notification envia ao número interno pela mesma conexão do run, com a mensagem renderizada', async () => {
    const w = await world(env, { sessions: [{ id: 'sess-a-t51' + Math.random().toString(36).slice(2, 6) }, { id: 'sess-b-t51' + Math.random().toString(36).slice(2, 6) }] })
    // o chat do run está na 2ª conexão
    const second = (await env.q(`SELECT id, session_id FROM crm.connections WHERE company_id = $1 ORDER BY session_id DESC LIMIT 1`, [w.companyId]))[0]
    await env.q(`UPDATE crm.chats SET connection_id = $2 WHERE id = $1`, [w.chatId, second.id])
    const r = await run(
      env,
      w,
      chain(node('N', 'notification', [action('nt', 'send_notification', { name: 'Gerente', phone: '11912345678', country_code: '55', message: 'Novo lead: {full_name}' })])),
    )
    expect(r.error, String(r.error)).toBeNull()
    expect(r.status).toBe('completed')
    const s = sends(w)
    expect(s).toHaveLength(1)
    expect(s[0]).toMatchObject({ sessionId: second.session_id, phone: '+5511912345678', content: { text: 'Novo lead: Maria Souza' } })
    expect(String(s[0].actor)).toMatch(/^flow:/)
    expect(w.wa.sent).toHaveLength(1)
  })

  it('AC-T51-05 a notificação passa pelo pipeline: sessão pausada rejeita e o run não segue como enviado', async () => {
    const sid = `sess-p-t51${Math.random().toString(36).slice(2, 6)}`
    const w = await world(env, { sessions: [{ id: sid, state: 'PAUSED' }] })
    const r = await run(
      env,
      w,
      chain(node('N', 'notification', [action('nt', 'send_notification', { name: 'Equipe', phone: '11912345678', message: 'aviso' })]), node('M', 'message', [action('m', 'send_message', { message_text: 'depois' })])),
    )
    expect(w.wa.sent).toHaveLength(0)
    expect(sends(w)[0]).toMatchObject({ sessionId: sid, phone: '+5511912345678' })
    expect(r.status === 'failed' || r.error !== null, `status ${r.status}`).toBe(true)
  })
})
