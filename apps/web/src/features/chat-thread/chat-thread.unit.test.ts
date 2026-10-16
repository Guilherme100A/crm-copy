import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { dispatchRealtime } from '@/lib/realtime'
import { mediaUrl, threadKey, type MessageDto, type NoteDto } from './api'
import { isNearBottom } from './chat-thread'
import { onThreadAppend, receiveMessage, registerThreadRealtime } from './realtime'
import { clearReplyTarget, getReplyTarget, setReplyTarget } from './reply-store'
import { appendMessage, applyReaction, buildTimeline, findQuoted, flattenMessages, formatWhatsApp, groupReactions, patchMessage, tickOf, type ThreadData } from './timeline'

const msg = (id: string, at: string, extra: Partial<MessageDto> = {}): MessageDto => ({
  id,
  chat_id: 'chat-1',
  direction: 'inbound',
  sender_type: 'contact',
  sender_user_id: null,
  type: 'text',
  wa_type: 'conversation',
  body: `msg ${id}`,
  media: null,
  quoted_wa_message_id: null,
  status: 'received',
  error: null,
  wa_message_id: `wa-${id}`,
  pipeline_message_id: null,
  historical: false,
  deleted_at: null,
  wa_timestamp: null,
  created_at: at,
  reactions: [],
  ...extra,
})
const note = (id: string, at: string): NoteDto => ({ id, chat_id: 'chat-1', body: `nota ${id}`, author: { id: 'u', name: 'Bia' }, created_at: at })
// Páginas: a 1ª é a mais recente.
const data = (...pages: MessageDto[][]): ThreadData => ({ pages: pages.map((items, i) => ({ items, next_cursor: i < pages.length - 1 ? items[0]!.id : null })), pageParams: pages.map((_, i) => (i ? `c${i}` : null)) })

describe('linha do tempo', () => {
  it('páginas viram ordem cronológica; notas mescladas por data com separador de dia', () => {
    const d = data([msg('c', '2026-10-16T10:00:00Z'), msg('d', '2026-10-16T11:00:00Z')], [msg('a', '2026-10-15T09:00:00Z'), msg('b', '2026-10-15T10:00:00Z')])
    const ms = flattenMessages(d)
    expect(ms.map((m) => m.id)).toEqual(['a', 'b', 'c', 'd'])
    const tl = buildTimeline(ms, [note('n1', '2026-10-16T10:30:00Z'), note('old', '2026-10-01T00:00:00Z')], true)
    expect(tl.map((x) => (x.kind === 'message' ? x.message.id : x.kind === 'note' ? `note:${x.note.id}` : 'day'))).toEqual(['day', 'a', 'b', 'day', 'c', 'note:n1', 'd'])
    // sem páginas antigas a nota antiga aparece no começo
    expect(buildTimeline(ms, [note('old', '2026-10-01T00:00:00Z')], false)[1]).toMatchObject({ kind: 'note' })
  })

  it('ticks só na saída', () => {
    expect(tickOf({ direction: 'inbound', status: 'received' })).toBe('none')
    expect(['queued', 'processing', 'retrying'].map((s) => tickOf({ direction: 'outbound', status: s }))).toEqual(['pending', 'pending', 'pending'])
    expect(['sent', 'delivered', 'read', 'failed'].map((s) => tickOf({ direction: 'outbound', status: s }))).toEqual(['sent', 'delivered', 'read', 'failed'])
  })

  it('citação pelo wa_message_id; reações agrupadas', () => {
    const a = msg('a', '2026-10-16T10:00:00Z')
    expect(findQuoted([a], { quoted_wa_message_id: 'wa-a' })).toBe(a)
    expect(findQuoted([a], { quoted_wa_message_id: 'wa-x' })).toBeNull()
    expect(groupReactions([{ emoji: '👍', actor_type: 'user', user_id: 'u1' }, { emoji: '👍', actor_type: 'contact', user_id: null }, { emoji: '🔥', actor_type: 'user', user_id: 'u2' }])).toEqual([
      { emoji: '👍', count: 2 },
      { emoji: '🔥', count: 1 },
    ])
    const r = applyReaction([{ emoji: '👍', actor_type: 'user', user_id: 'u1' }], { emoji: '❤️', user_id: 'u1' })
    expect(r).toEqual([{ emoji: '❤️', actor_type: 'user', user_id: 'u1' }])
    expect(applyReaction(r, { emoji: '', user_id: 'u1' })).toEqual([])
  })

  it('formatação WhatsApp sem HTML', () => {
    expect(formatWhatsApp('oi *forte* e _leve_ ~não~ ```x=1```')).toEqual([
      { text: 'oi ' },
      { text: 'forte', bold: true },
      { text: ' e ' },
      { text: 'leve', italic: true },
      { text: ' ' },
      { text: 'não', strike: true },
      { text: ' ' },
      { text: 'x=1', mono: true },
    ])
    expect(formatWhatsApp('2 * 3 = 6 e a_b')).toEqual([{ text: '2 * 3 = 6 e a_b' }])
    expect(formatWhatsApp('<b>*x*</b>')).toEqual([{ text: '<b>' }, { text: 'x', bold: true }, { text: '</b>' }])
  })

  it('append no fim sem duplicar; patch por id', () => {
    const d = data([msg('a', '2026-10-16T10:00:00Z')], [msg('z', '2026-10-15T10:00:00Z')])
    const after = appendMessage(d, msg('b', '2026-10-16T11:00:00Z'))
    expect(flattenMessages(after).map((m) => m.id)).toEqual(['z', 'a', 'b'])
    expect(flattenMessages(appendMessage(after, msg('b', '2026-10-16T11:00:00Z', { status: 'read' }))).map((m) => m.id)).toEqual(['z', 'a', 'b'])
    expect(flattenMessages(patchMessage(after, 'a', { status: 'read' })).find((m) => m.id === 'a')!.status).toBe('read')
  })

  it('mídia pela rota da mensagem', () => {
    expect(mediaUrl('c 1', 'm/1')).toBe('/api/chats/c%201/messages/m%2F1/media')
    expect(mediaUrl('c', 'm', true)).toBe('/api/chats/c/messages/m/media?download=1')
  })
})

describe('realtime da thread (AC-T75-03/05)', () => {
  it('message.created entra no fim e avisa a thread; message.status muda o tick', () => {
    registerThreadRealtime()
    const qc = new QueryClient()
    qc.setQueryData(threadKey('chat-1'), data([msg('a', '2026-10-16T10:00:00Z')]))
    const seen = vi.fn()
    const off = onThreadAppend(seen)
    const env = (type: string, d: unknown) => ({ id: '1', type, company_id: 'co', at: '2026-10-16T12:00:00Z', data: d })
    dispatchRealtime(env('message.created', { chat_id: 'chat-1', message: msg('b', '2026-10-16T11:00:00Z') }), qc)
    expect(seen).toHaveBeenCalledWith('chat-1', expect.objectContaining({ id: 'b' }))
    dispatchRealtime(env('message.created', { chat_id: 'chat-1', message: msg('b', '2026-10-16T11:00:00Z') }), qc)
    expect(seen).toHaveBeenCalledTimes(1)
    dispatchRealtime(env('message.status', { chat_id: 'chat-1', message_id: 'a', status: 'failed', error: 'x' }), qc)
    dispatchRealtime(env('message.deleted', { chat_id: 'chat-1', message_id: 'b' }), qc)
    dispatchRealtime(env('message.reacted', { chat_id: 'chat-1', message_id: 'b', emoji: '🔥', user_id: 'u1' }), qc)
    const ms = flattenMessages(qc.getQueryData<ThreadData>(threadKey('chat-1')))
    expect(ms.map((m) => m.id)).toEqual(['a', 'b'])
    expect(ms[0]).toMatchObject({ status: 'failed', error: 'x' })
    expect(ms[1]!.deleted_at).toBeTruthy()
    expect(ms[1]!.reactions).toEqual([{ emoji: '🔥', actor_type: 'user', user_id: 'u1' }])
    off()
  })

  it('chat sem thread em cache é ignorado', () => {
    const qc = new QueryClient()
    receiveMessage(qc, msg('x', '2026-10-16T11:00:00Z', { chat_id: 'outro' }))
    expect(qc.getQueryData(threadKey('outro'))).toBeUndefined()
  })
})

describe('responder e rolagem', () => {
  it('alvo de resposta por chat', () => {
    setReplyTarget('chat-1', msg('a', '2026-10-16T10:00:00Z'))
    expect(getReplyTarget('chat-1')).toMatchObject({ id: 'a', body: 'msg a' })
    expect(getReplyTarget('chat-2')).toBeNull()
    clearReplyTarget('chat-1')
    expect(getReplyTarget('chat-1')).toBeNull()
  })

  it('"no fim" com folga de 80 px', () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 360 })).toBe(true)
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 400, clientHeight: 360 })).toBe(false)
  })
})
