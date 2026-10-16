import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { threadKey, type MessageDto } from '@/features/chat-thread/api'
import { flattenMessages, type ThreadData } from '@/features/chat-thread/timeline'
import { confirmTemp, dropTemp, isBlockedStatus, showTemp, tempMessage } from './api'
import { pixPreview } from './pix-dialog'
import { pickRecorderMime } from './recorder'
import { checkFile, hasFormatting, insertAt, isNotificationMuted, MEDIA_LIMITS, parseAmountCents, replaceSlash, setNotificationsMuted, signatureKey, slashQuery, wrapSelection } from './rules'

const MB = 1024 * 1024

describe('anexos (AC-T85-02)', () => {
  it('limite por tipo igual ao servidor; mime não aceito bloqueia', () => {
    expect(checkFile({ type: 'image/png', size: 20 * MB })).toEqual({ ok: true, kind: 'image' })
    expect(checkFile({ type: 'image/png', size: 20 * MB + 1 })).toEqual({ ok: false, reason: 'too_large', kind: 'image', limit: MEDIA_LIMITS.image })
    expect(checkFile({ type: 'audio/ogg; codecs=opus', size: 16 * MB + 1 })).toMatchObject({ ok: false, reason: 'too_large', kind: 'audio' })
    expect(checkFile({ type: 'application/pdf', size: 30 * MB })).toEqual({ ok: true, kind: 'document' })
    expect(checkFile({ type: 'video/mp4', size: 21 * MB })).toMatchObject({ ok: false, kind: 'video' })
    expect(checkFile({ type: 'application/x-msdownload', size: 10 })).toEqual({ ok: false, reason: 'unsupported' })
    expect(checkFile({ type: '', size: 10 })).toEqual({ ok: false, reason: 'unsupported' })
  })
})

describe('texto (AC-T85-01, AC-T85-04)', () => {
  it('formatação envolve a seleção ou insere o par', () => {
    expect(wrapSelection('olá mundo', 4, 9, 'bold')).toEqual({ text: 'olá *mundo*', start: 5, end: 10 })
    expect(wrapSelection('ab', 1, 1, 'strike')).toEqual({ text: 'a~~b', start: 2, end: 2 })
    expect(hasFormatting('um *dois* três')).toBe(true)
    expect(hasFormatting('2 * 3 = 6')).toBe(false)
    expect(insertAt('oi!', 2, 2, '👋')).toEqual({ text: 'oi👋!', cursor: 4 })
  })

  it('"/" no início ou depois de espaço abre as respostas rápidas', () => {
    expect(slashQuery('/boas', 5)).toEqual({ start: 0, query: 'boas' })
    expect(slashQuery('oi /pre', 7)).toEqual({ start: 3, query: 'pre' })
    expect(slashQuery('http://x', 8)).toBeNull()
    expect(slashQuery('oi/x', 4)).toBeNull()
    expect(slashQuery('/a b', 4)).toBeNull()
    expect(replaceSlash('oi /boas fim', 8, 3, 'Olá, Ana!')).toEqual({ text: 'oi Olá, Ana! fim', cursor: 12 })
  })

  it('assinatura por usuário', () => {
    expect(signatureKey('u1')).toBe('crm.chat.signature:u1')
  })
})

describe('Pix', () => {
  it('valor em reais e prévia igual ao servidor', () => {
    expect(parseAmountCents('12,50')).toBe(1250)
    expect(parseAmountCents('1.234,56')).toBe(123456)
    expect(parseAmountCents('12.5')).toBe(1250)
    expect(parseAmountCents('')).toBeNull()
    expect(parseAmountCents('abc')).toBeNaN()
    expect(pixPreview({ key: 'loja@ex.com', name: 'Loja', amount_cents: 1250 })).toBe('*Pagamento via Pix*\nChave Pix: loja@ex.com\nRecebedor: Loja\nValor: R$ 12,50')
  })
})

describe('áudio (AC-T85-03)', () => {
  it('mime preferido do MediaRecorder; notificações mudas durante a gravação', () => {
    expect(pickRecorderMime((m) => m === 'audio/ogg;codecs=opus')).toBe('audio/ogg;codecs=opus')
    expect(pickRecorderMime(() => false)).toBeUndefined()
    const body = { dataset: {} as DOMStringMap }
    setNotificationsMuted(true, body)
    expect(isNotificationMuted(body)).toBe(true)
    setNotificationsMuted(false, body)
    expect(isNotificationMuted(body)).toBe(false)
  })
})

describe('envio otimista (AC-T85-01) e conexão (AC-T85-05)', () => {
  const real = (id: string): MessageDto => ({ ...tempMessage({ chatId: 'c1', clientId: 'x', type: 'text', body: 'oi', userId: 'u' }), id, status: 'sent' })

  it('temporária entra na hora e vira a real', () => {
    const qc = new QueryClient()
    qc.setQueryData<ThreadData>(threadKey('c1'), { pages: [{ items: [], next_cursor: null }], pageParams: [null] })
    const temp = tempMessage({ chatId: 'c1', clientId: 'abc', type: 'text', body: 'oi', userId: 'u' })
    expect(temp).toMatchObject({ id: 'tmp-abc', status: 'queued', direction: 'outbound', sender_user_id: 'u' })
    showTemp(qc, temp)
    expect(flattenMessages(qc.getQueryData(threadKey('c1'))).map((m) => m.id)).toEqual(['tmp-abc'])
    confirmTemp(qc, 'c1', 'tmp-abc', real('m1'))
    expect(flattenMessages(qc.getQueryData(threadKey('c1'))).map((m) => [m.id, m.status])).toEqual([['m1', 'sent']])
  })

  it('se o SSE trouxe a real antes, a temporária some; falha remove a temporária', () => {
    const qc = new QueryClient()
    qc.setQueryData<ThreadData>(threadKey('c1'), { pages: [{ items: [], next_cursor: null }], pageParams: [null] })
    showTemp(qc, tempMessage({ chatId: 'c1', clientId: 'a', type: 'text', body: 'oi', userId: 'u' }))
    showTemp(qc, real('m2'))
    confirmTemp(qc, 'c1', 'tmp-a', real('m2'))
    expect(flattenMessages(qc.getQueryData(threadKey('c1'))).map((m) => m.id)).toEqual(['m2'])
    showTemp(qc, tempMessage({ chatId: 'c1', clientId: 'b', type: 'text', body: 'x', userId: 'u' }))
    dropTemp(qc, 'c1', 'tmp-b')
    expect(flattenMessages(qc.getQueryData(threadKey('c1'))).map((m) => m.id)).toEqual(['m2'])
  })

  it('status de conexão que bloqueia o envio', () => {
    expect(['disconnected', 'banned', 'paused'].map(isBlockedStatus)).toEqual([true, true, true])
    expect(['connected', 'connecting', 'pending', null].map(isBlockedStatus)).toEqual([false, false, false, false])
  })
})
