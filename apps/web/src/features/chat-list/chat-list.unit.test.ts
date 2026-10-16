import { QueryClient, type InfiniteData } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { collectSlots } from '@/features/chat/slots'
import { CHAT_LIST_KEY, type ChatListItem, type ChatListPage } from './api'
import { avatarText, formatListTime } from './chat-list-panel'
import { applyChatPatch, applyToCache, removeChat } from './realtime'
import { advancedCount, chatSearchSchema, cleanSearch, dayBound, periodProblem, toApiQuery } from './search'

const chat = (id: string, at: string, extra: Partial<ChatListItem> = {}): ChatListItem => ({
  id,
  connection_id: 'conn',
  contact_id: `ct-${id}`,
  status: 'waiting',
  assigned_user_id: null,
  department_id: null,
  ai_agent_id: null,
  unread_count: 0,
  last_message_preview: `msg ${id}`,
  last_message_at: at,
  last_inbound_at: at,
  opened_at: at,
  resolved_at: null,
  blocked: false,
  created_at: at,
  updated_at: at,
  contact: { id: `ct-${id}`, name: `Contato ${id}`, phone_e164: '+5511999990000', wa_lid: null },
  assigned_user: null,
  label_ids: [],
  ...extra,
})

const pages = (...lists: ChatListItem[][]): InfiniteData<ChatListPage, string | null> => ({
  pages: lists.map((items, i) => ({ items, next_cursor: i < lists.length - 1 ? `c${i}` : null, counts: { waiting: 9, attending: 0, resolved: 0 } })),
  pageParams: lists.map((_, i) => (i === 0 ? null : `c${i - 1}`)),
})
const ids = (d: InfiniteData<ChatListPage, string | null> | null) => d?.pages.map((p) => p.items.map((c) => c.id))

describe('search params ↔ API (AC-T69-01)', () => {
  it('URL inválida não quebra: valores ruins viram undefined', () => {
    expect(chatSearchSchema.parse({ status: 'x', quick: 'unread', created_from: '16/10/2026', connection_ids: 'a' })).toEqual({ quick: 'unread' })
  })

  it('aba padrão waiting; quick vira read_status/response_status; listas e período', () => {
    expect(toApiQuery({})).toEqual({ status: 'waiting', limit: 15 })
    expect(toApiQuery({ status: 'resolved', quick: 'unread', search: 'ana' })).toEqual({ status: 'resolved', limit: 15, read_status: 'unread', search: 'ana' })
    expect(toApiQuery({ quick: 'unanswered' }).response_status).toBe('unanswered')
    const q = toApiQuery({ connection_ids: ['a', 'b'], label_ids: ['l'], assigned_to: 'me', created_from: '2026-10-01', created_to: '2026-10-16', crm_id: 'k' })
    expect(q).toMatchObject({ connection_ids: ['a', 'b'], label_ids: ['l'], assigned_to: 'me', crm_id: 'k' })
    expect(q.created_from).toBe(dayBound('2026-10-01', false))
    expect(q.created_to).toBe(dayBound('2026-10-16', true))
    // período incompleto não vai para a API
    expect(toApiQuery({ created_from: '2026-10-01' }).created_from).toBeUndefined()
  })

  it('dayBound cobre o dia local inteiro', () => {
    const from = new Date(dayBound('2026-10-16', false))
    const to = new Date(dayBound('2026-10-16', true))
    expect([from.getDate(), from.getHours(), from.getMinutes()]).toEqual([16, 0, 0])
    expect([to.getDate(), to.getHours(), to.getMinutes(), to.getSeconds()]).toEqual([16, 23, 59, 59])
  })

  it('periodProblem, advancedCount e cleanSearch', () => {
    expect(periodProblem('2026-10-01')).toBe('both')
    expect(periodProblem('2026-10-10', '2026-10-01')).toBe('order')
    expect(periodProblem('2026-10-01', '2026-10-01')).toBeNull()
    expect(advancedCount({ assigned_to: 'me', created_from: 'a', created_to: 'b', label_ids: ['x', 'y'] })).toBe(4)
    expect(cleanSearch({ status: 'attending', search: '', label_ids: [], quick: undefined })).toEqual({ status: 'attending' })
  })
})

describe('realtime na lista (AC-T69-02)', () => {
  const list = pages([chat('a', '2026-10-16T10:00:00Z'), chat('b', '2026-10-16T09:00:00Z')], [chat('c', '2026-10-16T08:00:00Z')])

  it('mensagem nova sobe o chat para o topo e atualiza não lidas e prévia, mantendo o contato', () => {
    const next = applyChatPatch(list, { status: 'waiting' }, { id: 'c', unread_count: 3, last_message_preview: 'oi', last_message_at: '2026-10-16T11:00:00Z' })
    expect(ids(next)).toEqual([['c', 'a', 'b'], []])
    const c = next!.pages[0]!.items[0]!
    expect(c).toMatchObject({ unread_count: 3, last_message_preview: 'oi', contact: { name: 'Contato c' } })
  })

  it('sem mensagem nova fica no lugar; mudou de status sai da aba; fora da lista devolve null', () => {
    expect(ids(applyChatPatch(list, { status: 'waiting' }, { id: 'b', assigned_user_id: 'u1' }))).toEqual([['a', 'b'], ['c']])
    expect(ids(applyChatPatch(list, { status: 'waiting' }, { id: 'a', status: 'attending' }))).toEqual([['b'], ['c']])
    expect(applyChatPatch(list, { status: 'waiting' }, { id: 'zz', unread_count: 1 })).toBeNull()
    expect(ids(removeChat(list, 'b'))).toEqual([['a'], ['c']])
  })

  it('applyToCache atualiza todas as listas em cache', () => {
    const qc = new QueryClient()
    qc.setQueryData([...CHAT_LIST_KEY, { status: 'waiting', limit: 15 }], list)
    qc.setQueryData([...CHAT_LIST_KEY, { status: 'waiting', limit: 15, read_status: 'unread' }], pages([chat('b', '2026-10-16T09:00:00Z')]))
    applyToCache(qc, { id: 'b', unread_count: 2, last_message_at: '2026-10-16T12:00:00Z' })
    expect(ids(qc.getQueryData([...CHAT_LIST_KEY, { status: 'waiting', limit: 15 }]) as never)).toEqual([['b', 'a'], ['c']])
    expect((qc.getQueryData([...CHAT_LIST_KEY, { status: 'waiting', limit: 15, read_status: 'unread' }]) as InfiniteData<ChatListPage>).pages[0]!.items[0]!.unread_count).toBe(2)
  })
})

describe('item da lista', () => {
  it('avatar: iniciais do nome ou +DDI do telefone', () => {
    expect(avatarText({ id: '1', name: 'Ana Maria Souza', phone_e164: null, wa_lid: null })).toBe('AM')
    expect(avatarText({ id: '1', name: '', phone_e164: '+5511988887777', wa_lid: null })).toBe('+55')
    expect(avatarText({ id: '1', name: '+55 11 98888', phone_e164: '+5511988887777', wa_lid: null })).toBe('+55')
    expect(avatarText({ id: '1', name: 'Cliente 17', phone_e164: null, wa_lid: null })).toBe('C')
  })

  it('hora se hoje, data se outro dia', () => {
    const now = new Date(2026, 9, 16, 15, 0)
    expect(formatListTime(new Date(2026, 9, 16, 9, 5).toISOString(), 'pt-BR', now)).toBe('09:05')
    expect(formatListTime(new Date(2026, 9, 2, 9, 5).toISOString(), 'pt-BR', now)).toBe('02/10')
    expect(formatListTime(null, 'pt-BR', now)).toBe('')
  })
})

describe('slots (T75/T85/T91)', () => {
  it('descobre chatSlot por área e ignora módulos inválidos', () => {
    const Thread = () => null
    const Panel = () => null
    const slots = collectSlots({
      '../chat-thread/chat-slot.tsx': { chatSlot: { area: 'thread', Component: Thread } },
      '../chat-panel/chat-slot.tsx': { chatSlot: { area: 'panel', Component: Panel } },
      '../x/chat-slot.tsx': { chatSlot: { area: 'sidebar', Component: Thread } },
      '../y/chat-slot.tsx': {},
    })
    expect(slots).toEqual({ thread: Thread, panel: Panel })
  })
})
