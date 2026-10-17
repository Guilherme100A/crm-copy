import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it } from 'vitest'
import { listKey, pairingKey, qrKey, type ConnectionDto, type ConnectionsPage } from './api'
import {
  actionsFor,
  connectionsSearchSchema,
  limitReached,
  nameIssue,
  patchFromEvent,
  patchPage,
  phoneDigits,
  phoneValid,
  proxyDraftOf,
  proxyInputOf,
  proxyIssues,
  slotsLeft,
} from './logic'
import { connectionsUi, handleConnectionEvent } from './realtime'

const conn = (over: Partial<ConnectionDto> = {}): ConnectionDto => ({
  id: 'c1',
  name: 'Vendas',
  session_id: 's1',
  phone_number: null,
  status: 'pending',
  session_state: 'NEW',
  badges: [],
  connection_state: null,
  last_disconnect_reason: null,
  disconnected_at: null,
  connected_at: null,
  notify_sent_by_me: false,
  ephemeral_duration: 'off',
  save_contacts_enabled: false,
  scheduled_for_deletion_at: null,
  requires_restart: false,
  proxy: null,
  created_at: '2026-10-16T12:00:00.000Z',
  updated_at: '2026-10-16T12:00:00.000Z',
  paused_flows_count: 0,
  ...over,
})

const page = (items: ConnectionDto[]): ConnectionsPage => ({
  items,
  page: { page: 1, limit: 20, total_count: items.length, total_pages: 1, has_more: false },
  status_counts: {
    pending: items.filter((i) => i.status === 'pending').length,
    connecting: 0,
    connected: items.filter((i) => i.status === 'connected').length,
    paused: 0,
    disconnected: 0,
    banned: 0,
  },
  limits: { connections: null, used: items.length },
})

const all = { canEdit: true, canDelete: true, canRunFlows: true }

afterEach(() => connectionsUi.reset())

describe('AC-T71-05 limite de conexões', () => {
  it('sem limite nunca bloqueia; com limite, bloqueia só quando used >= limite', () => {
    expect(limitReached(undefined)).toBe(false)
    expect(limitReached({ connections: null, used: 500 })).toBe(false)
    expect(limitReached({ connections: 2, used: 1 })).toBe(false)
    expect(limitReached({ connections: 2, used: 2 })).toBe(true)
    expect(limitReached({ connections: 0, used: 0 })).toBe(true)
  })
})

describe('AC-T71-01 lista: search params e ações', () => {
  it('search params tipados: status inválido cai fora', () => {
    expect(connectionsSearchSchema.parse({ filter: 'connected', search: 'x', page: '2' })).toEqual({
      filter: 'connected',
      search: 'x',
      page: 2,
    })
    expect(connectionsSearchSchema.parse({ filter: 'restricted' })).toEqual({ filter: undefined })
  })

  it('ações por status e permissão (08 §4)', () => {
    expect(actionsFor(conn({ status: 'pending' }), all)).toEqual([
      'connect',
      'rename',
      'proxy',
      'instance',
      'stop-flows',
      'delete',
    ])
    expect(actionsFor(conn({ status: 'connected' }), all)).toEqual([
      'disconnect',
      'restart',
      'rename',
      'proxy',
      'instance',
      'stop-flows',
      'delete',
    ])
    expect(actionsFor(conn({ status: 'paused' }), all)).toContain('resume')
    expect(actionsFor(conn({ status: 'disconnected', requires_restart: true }), all).slice(0, 2)).toEqual([
      'connect',
      'restart',
    ])
    expect(actionsFor(conn({ status: 'connected', paused_flows_count: 3 }), all)).toContain('paused-flows')
    expect(actionsFor(conn({ scheduled_for_deletion_at: '2026-10-16T12:00:00.000Z' }), all)).not.toContain('delete')
    // Sem `flows.run`: nada de Parar todos / pausados; sem edição: só leitura.
    expect(actionsFor(conn({ paused_flows_count: 2 }), { ...all, canRunFlows: false })).not.toContain('stop-flows')
    expect(actionsFor(conn(), { canEdit: false, canDelete: false, canRunFlows: false })).toEqual([])
  })
})

describe('validação replicada do servidor', () => {
  it('nome 2–100 e telefone DDI+número', () => {
    expect(nameIssue('  ')).toBe('required')
    expect(nameIssue('a')).toBe('length')
    expect(nameIssue('x'.repeat(101))).toBe('length')
    expect(nameIssue('Vendas')).toBeNull()
    expect(phoneDigits('+55 (11) 99999-9999')).toBe('5511999999999')
    expect(phoneValid('+55 11 99999-9999')).toBe(true)
    expect(phoneValid('0551199999')).toBe(false)
    expect(phoneValid('123456')).toBe(false)
  })

  it('AC-T71-03 proxy: porta 1–65535, host sem espaço; a senha salva nunca vem no rascunho', () => {
    const d = proxyDraftOf(
      conn({ proxy: { protocol: 'socks5', host: 'p.example', port: 1080, username: 'u', has_password: true } }),
    )
    expect(d).toEqual({
      protocol: 'socks5',
      host: 'p.example',
      port: '1080',
      username: 'u',
      password: '',
      removePassword: false,
    })
    expect(proxyIssues(d)).toEqual({})
    expect(proxyIssues({ ...d, host: 'a b', port: '70000' })).toEqual({ host: 'invalid', port: 'invalid' })
    expect(proxyIssues({ ...d, host: '', port: '' })).toEqual({ host: 'required', port: 'required' })
    expect(proxyInputOf({ ...d, username: '', password: 's3cr3t' })).toEqual({
      protocol: 'socks5',
      host: 'p.example',
      port: 1080,
      password: 's3cr3t',
    })
    // Senha vazia não vai no corpo (o servidor mantém a salva); apagar é explícito; senha nova vence o "apagar".
    expect(proxyInputOf(d)).not.toHaveProperty('password')
    expect(proxyInputOf(d)).not.toHaveProperty('remove_password')
    expect(proxyInputOf({ ...d, removePassword: true })).toMatchObject({ remove_password: true })
    expect(proxyInputOf({ ...d, removePassword: true, password: 'nova' })).toEqual({
      protocol: 'socks5',
      host: 'p.example',
      port: 1080,
      username: 'u',
      password: 'nova',
    })
  })
})

describe('AC-T71-02 realtime', () => {
  it('status_changed e connected mudam o status no cache e sinalizam o modal Conectar', () => {
    const qc = new QueryClient()
    const key = listKey({})
    qc.setQueryData(key, page([conn({ status: 'connecting' })]))
    handleConnectionEvent(
      {
        type: 'connection.status_changed',
        data: {
          connection_id: 'c1',
          session_id: 's1',
          status: 'connected',
          session_state: 'STABLE',
          connection_state: 'open',
          badges: ['warming'],
        },
      },
      qc,
    )
    const after = qc.getQueryData<ConnectionsPage>(key)!
    expect(after.items[0]).toMatchObject({ status: 'connected', session_state: 'STABLE', badges: ['warming'] })
    expect(after.status_counts).toMatchObject({ connecting: 0, connected: 1 })
    expect(connectionsUi.get().connected.c1).toBeTypeOf('number')

    handleConnectionEvent(
      {
        type: 'connection.disconnected',
        data: {
          connection_id: 'c1',
          status: 'disconnected',
          disconnected_at: '2026-10-16T13:00:00.000Z',
          reason: 'transient',
        },
      },
      qc,
    )
    expect(qc.getQueryData<ConnectionsPage>(key)!.items[0]).toMatchObject({
      status: 'disconnected',
      disconnected_at: '2026-10-16T13:00:00.000Z',
    })
  })

  it('qr_updated e pairing_code vão para o cache do modal', () => {
    const qc = new QueryClient()
    handleConnectionEvent(
      { type: 'connection.qr_updated', data: { connection_id: 'c1', qr_code: 'data:image/png;base64,QUJD' } },
      qc,
    )
    expect(qc.getQueryData<{ qr_code: string }>(qrKey('c1'))?.qr_code).toBe('data:image/png;base64,QUJD')
    handleConnectionEvent({ type: 'connection.pairing_code', data: { connection_id: 'c1', code: 'ABCD1234' } }, qc)
    expect(qc.getQueryData(pairingKey('c1'))).toBe('ABCD1234')
  })

  it('patch ignora conexão fora da página e evento sem connection_id', () => {
    expect(patchPage(page([conn()]), { id: 'zz', status: 'connected' })).toBeNull()
    expect(patchFromEvent('connection.status_changed', {})).toBeNull()
    expect(patchFromEvent('connection.created', { connection_id: 'c1' })).toBeNull()
  })
})

describe('AC-T71-04 fluxos pausados e marca neutra', () => {
  it('reconnected_with_paused_flows abre o modal com as contagens (só com pausados)', () => {
    const qc = new QueryClient()
    handleConnectionEvent(
      {
        type: 'connection.reconnected_with_paused_flows',
        data: { connection_id: 'c1', name: 'Vendas', paused_count: 0 },
      },
      qc,
    )
    expect(connectionsUi.get().pausedPrompt).toBeNull()
    handleConnectionEvent(
      {
        type: 'connection.reconnected_with_paused_flows',
        data: {
          connection_id: 'c1',
          name: 'Vendas',
          paused_count: 3,
          waiting_count: 1,
          failed_count: 0,
          received_count: 4,
          total_leads: 2,
        },
      },
      qc,
    )
    expect(connectionsUi.get().pausedPrompt).toEqual({
      connection_id: 'c1',
      name: 'Vendas',
      paused_count: 3,
      waiting_count: 1,
      failed_count: 0,
      received_count: 4,
      total_leads: 2,
    })
  })

  it('nenhum texto da tela cita API Oficial, Embedded Signup ou imunidade a ban', () => {
    for (const lang of ['pt-BR', 'en', 'es']) {
      const raw = readFileSync(join(__dirname, '..', '..', 'i18n', lang, 'connections.json'), 'utf8')
      expect(raw).not.toMatch(/api oficial|official api|api oficial|embedded signup|imune a ban|immune to ban|inmune/i)
    }
  })
})

describe('chips importados do ai-manager', () => {
  it('sem ações de sessão (ficam no ai-manager); Desvincular no lugar de Excluir', () => {
    const c = conn({ origin: 'ai-manager', status: 'connected', session_state: 'WARMING', badges: ['warming'] })
    expect(actionsFor(c, all)).toEqual(['rename', 'instance', 'stop-flows', 'unlink'])
    for (const a of ['connect', 'resume', 'disconnect', 'restart', 'proxy', 'delete'] as const)
      expect(actionsFor(c, all)).not.toContain(a)
    expect(actionsFor(conn({ origin: 'ai-manager', status: 'disconnected' }), all)).not.toContain('connect')
    expect(actionsFor(c, { canEdit: false, canDelete: false, canRunFlows: false })).toEqual([])
    expect(actionsFor(c, { canEdit: false, canDelete: true, canRunFlows: false })).toEqual(['unlink'])
    // Criada pelo CRM: nada muda (sem Desvincular).
    expect(actionsFor(conn({ status: 'connected' }), all)).not.toContain('unlink')
    expect(actionsFor(conn({ origin: 'crm', status: 'connected' }), all)).toContain('delete')
  })

  it('vagas no limite para importar', () => {
    expect(slotsLeft(undefined)).toBeNull()
    expect(slotsLeft({ connections: null, used: 9 })).toBeNull()
    expect(slotsLeft({ connections: 5, used: 3 })).toBe(2)
    expect(slotsLeft({ connections: 2, used: 3 })).toBe(0)
  })

  it('os 3 idiomas têm os textos da importação e do desvincular', () => {
    for (const loc of ['pt-BR', 'en', 'es']) {
      const j = JSON.parse(readFileSync(join(__dirname, '../../i18n', loc, 'connections.json'), 'utf8'))
      expect(j.import, loc).toMatchObject({
        open: expect.any(String),
        title: expect.any(String),
        body: expect.any(String),
        empty: expect.any(String),
        submit: expect.stringContaining('{n}'),
      })
      for (const st of ['NEW', 'WARMING', 'STABLE', 'DEGRADED', 'PAUSED', 'DISCONNECTED'])
        expect(j.import.states[st], `${loc} ${st}`).toBeTruthy()
      expect(j.unlink, loc).toMatchObject({
        title: expect.stringContaining('{name}'),
        body: expect.any(String),
        confirm: expect.any(String),
      })
      expect(j.actions.unlink && j.badges.ai_manager && j.toast.unlinked, loc).toBeTruthy()
    }
  })
})
