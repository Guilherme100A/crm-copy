import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchRealtime, registeredTypes, type RealtimeEnvelope } from '@/lib/realtime'
import {
  badgeLabel,
  DEFAULT_SETTINGS,
  genericItem,
  ITEM_TTL_MS,
  ITEMS_KEY,
  itemTarget,
  itemTexts,
  messageItem,
  openChatIdFromPath,
  parseSettings,
  pruneExpired,
  SETTINGS_KEY,
  shouldPlaySound,
  unreadCount,
  type NotificationItem,
  type NotificationSettings,
} from './model'
import { chatTitleFromCache, resolveChatTitle, TITLE_FETCH_TIMEOUT_MS } from './realtime'
import { NotificationStore, notificationStore, type NotificationEffects, type StorageLike } from './store'

const COMPANY = 'co-1'
const T0 = Date.UTC(2026, 9, 16, 12, 0, 0)

const memStorage = (init: Record<string, string> = {}): StorageLike & { data: Record<string, string> } => {
  const data = { ...init }
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) }
}

const fakeEffects = (muted = false) => {
  const calls = { toast: [] as NotificationItem[], sound: [] as number[], browser: [] as NotificationItem[] }
  const effects: NotificationEffects = {
    toast: (i) => void calls.toast.push(i),
    sound: (v) => void calls.sound.push(v),
    browser: (i) => void calls.browser.push(i),
    muted: () => muted,
  }
  return { calls, effects }
}

const inbound = (id: string, chatId = 'chat-1', extra: Record<string, unknown> = {}) => ({
  chat_id: chatId,
  message: { id, direction: 'inbound', historical: false, type: 'text', body: `oi ${id}`, ...extra },
})

const ctx = (
  over: Partial<{ openChatId: string | null; settings: NotificationSettings; title: string | null; now: number }> = {},
) => ({
  companyId: COMPANY,
  now: T0,
  openChatId: null,
  settings: { ...DEFAULT_SETTINGS },
  title: 'Maria',
  ...over,
})

const msgItem = (id: string, at = T0, read = false): NotificationItem => ({
  ...messageItem(inbound(id), ctx({ now: at }))!,
  read,
})

describe('AC-T84-01 message.created de entrada: badge "9+", item na central e som', () => {
  it('badge: vazio com 0, número até 9, "9+" acima de 9', () => {
    expect(badgeLabel(0)).toBe('')
    expect(badgeLabel(1)).toBe('1')
    expect(badgeLabel(9)).toBe('9')
    expect(badgeLabel(10)).toBe('9+')
    expect(badgeLabel(250)).toBe('9+')
  })

  it('só mensagem recebida e não histórica vira item (saída e importação não notificam)', () => {
    const item = messageItem(inbound('m1'), ctx())
    expect(item).toMatchObject({
      id: 'm1',
      kind: 'message',
      chat_id: 'chat-1',
      title: 'Maria',
      body: 'oi m1',
      read: false,
      at: T0,
    })
    expect(messageItem(inbound('m2', 'chat-1', { direction: 'outbound' }), ctx())).toBeNull()
    expect(messageItem(inbound('m3', 'chat-1', { historical: true }), ctx())).toBeNull()
    expect(messageItem({ chat_id: 'chat-1' }, ctx())).toBeNull()
    expect(messageItem(null, ctx())).toBeNull()
  })

  it('cada mensagem incrementa o badge; 10 mensagens mostram "9+"; o som toca com o volume atual', () => {
    const { calls, effects } = fakeEffects()
    const store = new NotificationStore(
      () => memStorage(),
      effects,
      () => T0,
    )
    for (let i = 0; i < 10; i++) expect(store.ingest(msgItem(`m${i}`))).toBe(true)
    const count = unreadCount(store.getState().items, COMPANY, T0)
    expect(count).toBe(10)
    expect(badgeLabel(count)).toBe('9+')
    expect(calls.sound).toEqual(Array(10).fill(50))
    expect(store.getState().sound).toMatchObject({ count: 10, lastVolume: 50, lastAt: T0 })
    expect(calls.toast).toHaveLength(10)
  })

  it('reentrega do mesmo evento (reconexão do SSE) não duplica nem toca de novo', () => {
    const { calls, effects } = fakeEffects()
    const store = new NotificationStore(
      () => memStorage(),
      effects,
      () => T0,
    )
    store.ingest(msgItem('m1'))
    expect(store.ingest(msgItem('m1'))).toBe(false)
    expect(store.getState().items).toHaveLength(1)
    expect(calls.sound).toHaveLength(1)
  })

  it('o badge conta só não lidas da empresa ativa; fechar a central marca como lidas', () => {
    const store = new NotificationStore(
      () => memStorage(),
      fakeEffects().effects,
      () => T0,
    )
    store.ingest(msgItem('m1'))
    store.ingest({ ...msgItem('m2'), company_id: 'outra' })
    expect(unreadCount(store.getState().items, COMPANY, T0)).toBe(1)
    store.markRead(COMPANY)
    expect(unreadCount(store.getState().items, COMPANY, T0)).toBe(0)
    expect(unreadCount(store.getState().items, 'outra', T0)).toBe(1)
  })

  it('título vem do cache do chat (detalhe ou listas); sem cache usa o texto padrão; mídia sem legenda tem rótulo', () => {
    const qc = new QueryClient()
    expect(chatTitleFromCache(qc, 'chat-1')).toBeNull()
    qc.setQueryData(['chat-list', { tab: 'waiting' }], {
      pages: [{ items: [{ id: 'chat-1', contact: { name: 'João', phone_e164: '+5511' } }] }],
    })
    expect(chatTitleFromCache(qc, 'chat-1')).toBe('João')
    qc.setQueryData(['chat', 'chat-2'], { id: 'chat-2', contact: { name: '', phone_e164: '+5511999' } })
    expect(chatTitleFromCache(qc, 'chat-2')).toBe('+5511999')
    const tr = (k: string) => `[${k}]`
    expect(itemTexts({ ...msgItem('m1'), title: null }, tr).title).toBe('[item.newMessage]')
    expect(itemTexts({ ...msgItem('m1'), body: '', message_type: 'image' }, tr).body).toBe('[media.image]')
    expect(itemTexts({ ...msgItem('m1'), body: '', message_type: 'ptt' }, tr).body).toBe('[media.audio]')
    expect(itemTexts({ ...msgItem('m1'), body: '', message_type: 'reaction' }, tr).body).toBe('[media.other]')
  })

  it('o handler realtime registrado no módulo (import estático do shell) cria o item a partir do evento', () => {
    expect(registeredTypes()).toEqual(expect.arrayContaining(['message.created', 'notification.created']))
  })
})

describe('AC-T84-02 mensagem do chat aberto não notifica', () => {
  it('a URL /chats/<id> identifica o chat aberto', () => {
    expect(openChatIdFromPath('/chats/abc-1')).toBe('abc-1')
    expect(openChatIdFromPath('/chats/abc-1/x')).toBe('abc-1')
    expect(openChatIdFromPath('/chats')).toBeNull()
    expect(openChatIdFromPath('/contacts/abc')).toBeNull()
  })

  it('chat aberto → nenhum item; outro chat → item', () => {
    expect(messageItem(inbound('m1', 'chat-1'), ctx({ openChatId: 'chat-1' }))).toBeNull()
    expect(messageItem(inbound('m2', 'chat-2'), ctx({ openChatId: 'chat-1' }))).not.toBeNull()
  })
})

describe('AC-T84-03 clique abre o chat; itens com mais de 1 h somem', () => {
  it('item de mensagem leva a /chats/<id> (rota real; /chat/<id> é a forma legada)', () => {
    expect(itemTarget(msgItem('m1'))).toEqual({ internal: '/chats/chat-1' })
  })

  it('genérico: caminho interno navega, http(s) abre fora, sem url não navega, javascript: é ignorado', () => {
    const g = (url: string | null) =>
      genericItem(
        { title: 'Venda', body: 'x', url },
        { id: 'n1', companyId: COMPANY, now: T0, settings: { ...DEFAULT_SETTINGS } },
      )!
    expect(itemTarget(g('/dashboard'))).toEqual({ internal: '/dashboard' })
    expect(itemTarget(g('https://ex.com/a'))).toEqual({ external: 'https://ex.com/a' })
    expect(itemTarget(g(null))).toBeNull()
    expect(itemTarget(g('javascript:alert(1)'))).toBeNull()
    expect(itemTarget(g('//evil.com'))).toBeNull()
  })

  it('itens com mais de 1 h saem da lista, do badge e do storage na limpeza', () => {
    let now = T0
    const storage = memStorage()
    const store = new NotificationStore(
      () => storage,
      fakeEffects().effects,
      () => now,
    )
    store.ingest(msgItem('velho', T0))
    now = T0 + 30 * 60_000
    store.ingest(msgItem('novo', now))
    expect(pruneExpired(store.getState().items, T0 + ITEM_TTL_MS + 1).map((i) => i.id)).toEqual(['novo'])
    now = T0 + ITEM_TTL_MS + 1
    expect(unreadCount(store.getState().items, COMPANY, now)).toBe(1)
    store.prune()
    expect(store.getState().items.map((i) => i.id)).toEqual(['novo'])
    expect(JSON.parse(storage.data[ITEMS_KEY]!).map((i: NotificationItem) => i.id)).toEqual(['novo'])
  })

  it('itens persistidos voltam ao recarregar, já sem os expirados', () => {
    const storage = memStorage({
      [ITEMS_KEY]: JSON.stringify([msgItem('a', T0), msgItem('b', T0 - ITEM_TTL_MS - 1), { lixo: 1 }]),
    })
    const store = new NotificationStore(
      () => storage,
      fakeEffects().effects,
      () => T0,
    )
    expect(store.getState().items.map((i) => i.id)).toEqual(['a'])
  })

  it('clicar marca só aquele item como lido', () => {
    const store = new NotificationStore(
      () => memStorage(),
      fakeEffects().effects,
      () => T0,
    )
    store.ingest(msgItem('m1'))
    store.ingest(msgItem('m2'))
    store.markRead(COMPANY, 'm1')
    expect(store.getState().items.find((i) => i.id === 'm1')?.read).toBe(true)
    expect(unreadCount(store.getState().items, COMPANY, T0)).toBe(1)
  })
})

describe('AC-T84-04 preferências persistem; "Restaurar padrão"; volume 0 não toca', () => {
  it('padrões de 14#10 e merge tolerante (campo inválido → padrão; volume preso em 0–100)', () => {
    expect(parseSettings(null)).toEqual({
      enabled: true,
      volume: 50,
      browserNotifications: true,
      toastNotifications: true,
      sounds: true,
    })
    expect(parseSettings('{quebrado')).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings('[1]')).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings(JSON.stringify({ sounds: false, volume: 140, enabled: 'sim' }))).toEqual({
      ...DEFAULT_SETTINGS,
      sounds: false,
      volume: 100,
    })
    expect(parseSettings(JSON.stringify({ volume: -3 })).volume).toBe(0)
    expect(parseSettings(JSON.stringify({ volume: '30' })).volume).toBe(30)
  })

  it('alterações gravam em localStorage["notification_settings"] e sobrevivem a recarregar', () => {
    const storage = memStorage()
    const a = new NotificationStore(
      () => storage,
      fakeEffects().effects,
      () => T0,
    )
    a.updateSettings({
      volume: 20,
      browserNotifications: false,
      toastNotifications: false,
      sounds: false,
      enabled: false,
    })
    expect(JSON.parse(storage.data[SETTINGS_KEY]!)).toEqual({
      enabled: false,
      volume: 20,
      browserNotifications: false,
      toastNotifications: false,
      sounds: false,
    })
    const b = new NotificationStore(
      () => storage,
      fakeEffects().effects,
      () => T0,
    )
    expect(b.getState().settings).toEqual({
      enabled: false,
      volume: 20,
      browserNotifications: false,
      toastNotifications: false,
      sounds: false,
    })
    b.resetSettings()
    expect(b.getState().settings).toEqual(DEFAULT_SETTINGS)
    expect(JSON.parse(storage.data[SETTINGS_KEY]!)).toEqual(DEFAULT_SETTINGS)
  })

  it('decisão do som: ativo && sons && volume > 0 && fora da gravação', () => {
    const s = { ...DEFAULT_SETTINGS }
    expect(shouldPlaySound(s, false)).toBe(true)
    expect(shouldPlaySound({ ...s, volume: 0 }, false)).toBe(false)
    expect(shouldPlaySound({ ...s, sounds: false }, false)).toBe(false)
    expect(shouldPlaySound({ ...s, enabled: false }, false)).toBe(false)
    expect(shouldPlaySound(s, true)).toBe(false)
  })

  it('volume 0: o item entra, mas o som não toca e o sinal do sino não muda', () => {
    const { calls, effects } = fakeEffects()
    const store = new NotificationStore(
      () => memStorage(),
      effects,
      () => T0,
    )
    store.updateSettings({ volume: 0 })
    store.ingest(msgItem('m1'))
    expect(store.getState().items).toHaveLength(1)
    expect(calls.sound).toEqual([])
    expect(store.getState().sound.count).toBe(0)
  })

  it('gravação de áudio (body[data-notifications-muted]) silencia', () => {
    const { calls, effects } = fakeEffects(true)
    const store = new NotificationStore(
      () => memStorage(),
      effects,
      () => T0,
    )
    store.ingest(msgItem('m1'))
    expect(calls.sound).toEqual([])
  })

  it('toast e navegador desligados não disparam; central desligada ignora tudo', () => {
    const { calls, effects } = fakeEffects()
    const store = new NotificationStore(
      () => memStorage(),
      effects,
      () => T0,
    )
    store.updateSettings({ toastNotifications: false, browserNotifications: false })
    store.ingest(msgItem('m1'))
    expect(calls.toast).toEqual([])
    expect(calls.browser).toEqual([])
    expect(calls.sound).toHaveLength(1)
    store.updateSettings({ enabled: false })
    expect(store.ingest(msgItem('m2'))).toBe(false)
    expect(messageItem(inbound('m3'), ctx({ settings: { ...DEFAULT_SETTINGS, enabled: false } }))).toBeNull()
    expect(store.getState().items).toHaveLength(1)
  })
})

describe('AC-T84-05 notification.created genérico: toast e item na central com as mesmas preferências', () => {
  it('monta o item com título, corpo e url opcional', () => {
    const g = genericItem(
      { title: ' Venda aprovada ', body: 'R$ 97,00 — Curso', url: null, kind: 'approved_sale', sale_id: 's1' },
      { id: 'n-1', companyId: COMPANY, now: T0, settings: { ...DEFAULT_SETTINGS } },
    )
    expect(g).toMatchObject({
      id: 'n-1',
      kind: 'generic',
      title: 'Venda aprovada',
      body: 'R$ 97,00 — Curso',
      url: null,
      chat_id: null,
    })
    expect(
      genericItem(
        { title: '', body: '' },
        { id: 'n-2', companyId: COMPANY, now: T0, settings: { ...DEFAULT_SETTINGS } },
      ),
    ).toBeNull()
    expect(
      genericItem(
        { title: 'x', body: 'y' },
        { id: 'n-3', companyId: COMPANY, now: T0, settings: { ...DEFAULT_SETTINGS, enabled: false } },
      ),
    ).toBeNull()
  })

  it('toast + som + item; com toast desligado só o item', () => {
    const { calls, effects } = fakeEffects()
    const store = new NotificationStore(
      () => memStorage(),
      effects,
      () => T0,
    )
    const mk = (id: string) =>
      genericItem(
        { title: 'Venda aprovada', body: 'b' },
        { id, companyId: COMPANY, now: T0, settings: store.getState().settings },
      )!
    store.ingest(mk('n-1'))
    expect(calls.toast.map((i) => i.id)).toEqual(['n-1'])
    expect(calls.sound).toEqual([50])
    store.updateSettings({ toastNotifications: false, sounds: false })
    store.ingest(mk('n-2'))
    expect(calls.toast).toHaveLength(1)
    expect(calls.sound).toHaveLength(1)
    expect(store.getState().items.map((i) => i.id)).toEqual(['n-2', 'n-1'])
  })
})

describe('AC-T84-01/02/05 handlers realtime do módulo', () => {
  const qc = new QueryClient()
  const env = (type: string, data: unknown, id = ''): RealtimeEnvelope => ({
    id,
    type,
    company_id: COMPANY,
    at: new Date(T0).toISOString(),
    data,
  })
  let calls: ReturnType<typeof fakeEffects>['calls']
  let saved: NotificationEffects

  beforeEach(() => {
    saved = notificationStore.effects
    const f = fakeEffects()
    calls = f.calls
    notificationStore.effects = f.effects
    notificationStore.resetSettings()
    notificationStore.clear(COMPANY)
  })
  afterEach(() => {
    notificationStore.effects = saved
    vi.unstubAllGlobals()
  })

  it('AC-T84-01 message.created de entrada entra na central com o nome do cache', () => {
    qc.setQueryData(['chat', 'chat-9'], { id: 'chat-9', contact: { name: 'Ana', phone_e164: null } })
    dispatchRealtime(env('message.created', inbound('rt-1', 'chat-9')), qc)
    expect(notificationStore.getState().items[0]).toMatchObject({ id: 'rt-1', chat_id: 'chat-9', title: 'Ana' })
    expect(calls.sound).toEqual([50])
  })

  it('AC-T84-02 com /chats/<id> aberto, a mensagem desse chat é ignorada', async () => {
    vi.stubGlobal('location', { pathname: '/chats/chat-9' })
    dispatchRealtime(env('message.created', inbound('rt-2', 'chat-9')), qc)
    // chat-8 fora do cache: o item entra depois da consulta do nome (aqui falha → título padrão).
    dispatchRealtime(env('message.created', inbound('rt-3', 'chat-8')), qc)
    await vi.waitFor(() => expect(notificationStore.getState().items.map((i) => i.id)).toContain('rt-3'))
    expect(notificationStore.getState().items.map((i) => i.id)).not.toContain('rt-2')
    expect(notificationStore.getState().items.find((i) => i.id === 'rt-3')?.title).toBeNull()
  })

  it('AC-T84-01 sem o chat no cache, o nome vem do detalhe do chat; demora ou erro → null', async () => {
    const fresh = new QueryClient()
    expect(await resolveChatTitle(fresh, 'c1', async () => ({ id: 'c1', contact: { name: 'Bia' } }))).toBe('Bia')
    expect(await resolveChatTitle(fresh, 'c1', async () => Promise.reject(new Error('500')))).toBeNull()
    vi.useFakeTimers()
    try {
      const pending = resolveChatTitle(fresh, 'c1', () => new Promise(() => undefined))
      await vi.advanceTimersByTimeAsync(TITLE_FETCH_TIMEOUT_MS)
      expect(await pending).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('AC-T84-05 notification.created vira item genérico com id do evento e toast', () => {
    dispatchRealtime(env('notification.created', { title: 'Venda aprovada', body: 'R$ 10', url: null }, 'evt-1'), qc)
    expect(notificationStore.getState().items[0]).toMatchObject({
      id: 'n-evt-1',
      kind: 'generic',
      title: 'Venda aprovada',
    })
    expect(calls.toast.map((i) => i.id)).toEqual(['n-evt-1'])
  })
})
