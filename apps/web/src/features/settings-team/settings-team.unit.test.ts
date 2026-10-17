import { describe, expect, it } from 'vitest'
import { DEFAULT_ROLE_PERMISSIONS, SETTINGS_AREAS } from '@crm/shared'
import { SETTINGS_TABS } from '@/features/settings/tabs'
import type { MemberDto } from './api'
import {
  activeCount,
  cellKey,
  columnChecked,
  filterMembers,
  initialSelection,
  memberActions,
  PERMISSION_GROUPS,
  permissionPayload,
  roleDefaults,
  scopeEnabled,
  sortMembers,
  toggleColumn,
  toggleKey,
  type Actor,
} from './team'
import { TRANSFER_CONSEQUENCES } from './transfer-dialog'

const m = (id: string, role: MemberDto['role'], name: string, department_ids: string[] = []): MemberDto => ({
  id: `m-${id}`,
  company_id: 'c1',
  user_id: id,
  role,
  permission_keys: null,
  effective_permissions: [],
  user: { id, name, email: `${name.toLowerCase()}@ex.test` },
  department_ids,
  created_at: '2026-01-01T00:00:00.000Z',
})

const team = [m('u3', 'member', 'Zé', ['d1']), m('u2', 'admin', 'Bia'), m('u1', 'owner', 'Ana'), m('u4', 'member', 'Caio')]

describe('lista da equipe (AC-T54-01)', () => {
  it('ordena owner < admin < member e depois por nome', () => {
    expect(sortMembers(team).map((x) => x.user_id)).toEqual(['u1', 'u2', 'u4', 'u3'])
  })

  it('filtra por papel, por departamento e por "Sem departamento"', () => {
    const all = { role: 'all', department: 'all' } as const
    expect(filterMembers(team, { ...all, role: 'member' }).map((x) => x.user_id)).toEqual(['u4', 'u3'])
    expect(filterMembers(team, { ...all, department: 'd1' }).map((x) => x.user_id)).toEqual(['u3'])
    expect(filterMembers(team, { ...all, department: 'none' }).map((x) => x.user_id)).toEqual(['u1', 'u2', 'u4'])
    expect(filterMembers(team, { role: 'member', department: 'none' }).map((x) => x.user_id)).toEqual(['u4'])
    // DTO antigo sem `department_ids` conta como sem departamento.
    const { department_ids: _omit, ...legacy } = m('u9', 'member', 'Legado')
    expect(filterMembers([legacy as MemberDto], { ...all, department: 'none' })).toHaveLength(1)
  })

  it('busca por nome, e-mail ou rótulo do papel (sem acento)', () => {
    const all = { role: 'all', department: 'all' } as const
    expect(filterMembers(team, { ...all, search: 'ze' }).map((x) => x.user_id)).toEqual(['u3'])
    expect(filterMembers(team, { ...all, search: 'bia@' }).map((x) => x.user_id)).toEqual(['u2'])
    const label = (r: string) => ({ owner: 'Proprietário', admin: 'Administrador', member: 'Membro' })[r]!
    expect(filterMembers(team, { ...all, search: 'propri', roleLabel: label }).map((x) => x.user_id)).toEqual(['u1'])
  })
})

describe('ações por membro (16 §4, §8.4)', () => {
  const actor = (role: 'owner' | 'admin' | 'member', keys: string[] = []): Actor => ({
    userId: role === 'owner' ? 'u1' : role === 'admin' ? 'u2' : 'u4',
    role,
    isOwner: role === 'owner',
    can: (k) => role === 'owner' || keys.includes(k),
  })
  const [owner, admin, member] = [team[2]!, team[1]!, team[3]!]

  it('transferir: só o owner, só para um admin', () => {
    expect(memberActions(actor('owner'), admin).transfer).toBe(true)
    expect(memberActions(actor('owner'), member).transfer).toBe(false)
    expect(memberActions(actor('owner'), owner).transfer).toBe(false)
    expect(memberActions(actor('admin', ['team.edit']), admin).transfer).toBe(false)
  })

  it('owner não é alterado nem removido; permissões só para owner/admin', () => {
    const a = actor('admin', ['team.edit', 'team.delete'])
    expect(memberActions(a, owner)).toMatchObject({ changeRole: false, remove: false, permissions: true })
    expect(memberActions(a, member)).toMatchObject({ changeRole: true, remove: true })
    expect(memberActions(a, admin).remove).toBe(false) // a si mesmo
    expect(memberActions(actor('member', ['team.view']), member).permissions).toBe(false)
  })

  it('a transferência mostra 4 consequências', () => {
    expect(TRANSFER_CONSEQUENCES).toHaveLength(4)
  })
})

describe('modal de permissões (AC-T54-02)', () => {
  it('marcar editar/excluir marca ver (e "Acessar configurações"); desmarcar ver desmarca editar/excluir', () => {
    let s = new Set<string>(['profile.view'])
    s = toggleKey(s, cellKey('labels', 'delete'), true)
    expect(s.has('settings.labels.view')).toBe(true)
    expect(s.has('settings.view')).toBe(true)
    s = toggleKey(s, cellKey('labels', 'edit'), true)
    s = toggleKey(s, cellKey('labels', 'view'), false)
    expect(['view', 'edit', 'delete'].some((a) => s.has(`settings.labels.${a}`))).toBe(false)
  })

  it('chat.block ⇒ chat.view; tirar chat.view tira chat.block; escopo só com chat.view', () => {
    let s = toggleKey(new Set(), 'chat.block', true)
    expect(s.has('chat.view')).toBe(true)
    expect(scopeEnabled(s)).toBe(true)
    s = toggleKey(s, 'chat.view', false)
    expect(s.has('chat.block')).toBe(false)
    expect(scopeEnabled(s)).toBe(false)
  })

  it('sempre concedidas e só do proprietário não mudam pelo modal', () => {
    const s = toggleKey(new Set(['settings.global_variables.view']), 'settings.global_variables.view', false)
    expect(s.has('settings.global_variables.view')).toBe(true)
    expect(toggleKey(new Set(), cellKey('platform_invitations', 'view'), true).has('settings.platform_invitations.view')).toBe(false)
  })

  it('cabeçalho de coluna marca/desmarca a ação nas áreas editáveis', () => {
    let s = toggleColumn(new Set(), 'edit', true)
    expect(columnChecked(s, 'edit')).toBe(true)
    expect(columnChecked(s, 'view')).toBe(true) // edit ⇒ view
    expect(s.has('settings.platform_invitations.edit')).toBe(false)
    s = toggleColumn(s, 'view', false)
    expect(columnChecked(s, 'edit')).toBe(false)
  })

  it('contador "N ativa(s)" por grupo', () => {
    const settings = PERMISSION_GROUPS.find((g) => g.key === 'settings')!
    expect(settings.areas).toEqual([...SETTINGS_AREAS])
    const s = toggleKey(new Set(), cellKey('labels', 'edit'), true)
    // labels.edit + labels.view + settings.view + as 3 sempre concedidas (settings.global_variables.*)
    expect(activeCount(settings, s)).toBe(6)
    const chat = PERMISSION_GROUPS.find((g) => g.key === 'chat')!
    expect(activeCount(chat, toggleKey(new Set(), 'chat.block', true))).toBe(2)
  })

  it('seleção inicial = lista explícita ou matriz do papel; igual à matriz → PATCH com null', () => {
    const member = m('u4', 'member', 'Caio')
    const s = initialSelection(member)
    for (const k of DEFAULT_ROLE_PERMISSIONS.member) expect(s.has(k)).toBe(true)
    expect(permissionPayload('member', s)).toBeNull()
    expect(permissionPayload('member', roleDefaults('member'))).toBeNull()
    const custom = toggleKey(s, 'contacts.edit', true)
    expect(permissionPayload('member', custom)).toEqual(expect.arrayContaining(['contacts.edit', 'contacts.view']))
    expect(initialSelection({ role: 'member', permission_keys: ['flows.edit'] }).has('flows.view')).toBe(true)
  })
})

describe('abas do hub (16 §2.1)', () => {
  it('equipe, convites e suporte no grupo Conta, logo depois de Empresa; suporte só owner/admin', () => {
    const account = SETTINGS_TABS.filter((x) => x.group === 'account').map((x) => x.id)
    expect(account.slice(0, 4)).toEqual(['accounts', 'team', 'platform_invitations', 'support_access'])
    expect(SETTINGS_TABS.find((x) => x.id === 'team')!.permissions).toEqual(['team.view'])
    expect(SETTINGS_TABS.find((x) => x.id === 'platform_invitations')!.permissions).toEqual(['settings.platform_invitations.view'])
    const support = SETTINGS_TABS.find((x) => x.id === 'support_access')!
    expect(support.roles).toEqual(['owner', 'admin'])
    expect(support.hiddenForSupport).toBe(true)
  })
})
