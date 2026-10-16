import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatListItem } from '@/features/chat-list/api'
import { configureHttp } from '@/lib/http'
import { applyChat, isoToLocal, kanbanLocationQuery, localToIso, scheduleWindowProblem } from './api'
import { chatSlot } from './chat-slot'

afterEach(() => configureHttp({ companyId: null }))

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

describe('agendamento (AC-T91-03)', () => {
  it('datetime-local ida e volta na hora local', () => {
    const iso = localToIso('2026-10-20T14:30')!
    expect(new Date(iso).getHours()).toBe(14)
    expect(isoToLocal(iso)).toBe('2026-10-20T14:30')
    expect(localToIso('20/10/2026')).toBeNull()
  })

  it('janela de 31 dias como na T64', () => {
    const now = Date.parse('2026-10-16T12:00:00Z')
    expect(scheduleWindowProblem('2026-10-16T11:00:00Z', now)).toBe('past')
    expect(scheduleWindowProblem('2026-11-16T12:00:00Z', now)).toBeNull()
    expect(scheduleWindowProblem('2026-11-16T12:00:01Z', now)).toBe('too_far')
  })
})

describe('kanban do chat', () => {
  it('acha quadro e coluna pela lista filtrada por crm/coluna/contato', async () => {
    const fetch = vi.fn(async (url: string) => {
      const u = new URL(url, 'http://x')
      const hit = u.searchParams.get('crm_id') === 'b2' && u.searchParams.get('crm_column_id') === 'c22'
      return json({ items: hit ? [{ id: 'chat-1' }] : [] })
    })
    configureHttp({ fetch: fetch as never })
    const boards = [
      { id: 'b1', name: 'Vendas', columns: [{ id: 'c11', name: 'Novo' }] },
      { id: 'b2', name: 'Suporte', columns: [{ id: 'c21', name: 'Aberto' }, { id: 'c22', name: 'Em andamento' }] },
    ]
    const q = kanbanLocationQuery({ id: 'chat-1', contact_id: 'ct-1' }, boards)
    const r = await (q.queryFn as (ctx: unknown) => Promise<unknown>)({})
    expect(r).toEqual({ crmId: 'b2', columnId: 'c22' })
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toContain('contact_id=ct-1')
    const none = kanbanLocationQuery({ id: 'chat-9', contact_id: 'ct-9' }, boards)
    expect(await (none.queryFn as (ctx: unknown) => Promise<unknown>)({})).toBeNull()
  })
})

describe('cache e slot', () => {
  it('applyChat atualiza o detalhe; o slot é da área panel', () => {
    const qc = new QueryClient()
    const chat = { id: 'chat-1', department_id: 'd2' } as ChatListItem
    applyChat(qc, chat)
    expect(qc.getQueryData(['chat', 'chat-1'])).toMatchObject({ id: 'chat-1', department_id: 'd2' })
    applyChat(qc, undefined)
    expect(chatSlot.area).toBe('panel')
  })
})
