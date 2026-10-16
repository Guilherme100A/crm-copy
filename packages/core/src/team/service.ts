// Equipe da empresa (T22; 16 §3.4, §4, §5 Equipe, §8): listar, mudar papel/permissões, remover e transferir a
// propriedade. Regras: o owner é intocável por terceiros; papel `owner` só por transferência (atômica, para um
// admin existente); chaves de permissão validadas no catálogo e normalizadas (edit/delete ⇒ view).
import { and, asc, eq, sql } from 'drizzle-orm'
import { companyMembers, users, type Database, type MemberRole } from '@crm/db'
import type { Logger } from '@crm/node-kit'
import {
  ALWAYS_GRANTED_PERMISSIONS,
  DEFAULT_ROLE_PERMISSIONS,
  OWNER_ONLY_PERMISSIONS,
  PERMISSION_CATALOG,
  effectivePermissions,
  isPermissionKey,
  normalizePermissions,
  type PermissionKey,
} from '@crm/shared'
import type { RealtimePublisher } from '../realtime/publisher'
import type { TeamActor } from '../companies/service'
import { TeamError } from './errors'
import { forbidden, notFound } from './internal'

export interface MemberDto {
  id: string
  company_id: string
  user_id: string
  role: MemberRole
  /** Lista explícita normalizada; `null` = matriz padrão do papel. */
  permission_keys: string[] | null
  effective_permissions: PermissionKey[]
  user: { id: string; name: string; email: string }
  created_at: string
}

export interface UpdateMemberInput {
  role?: 'admin' | 'member' | 'owner'
  /** `null` ou `[]` = volta para a matriz do papel. */
  permissionKeys?: string[] | null
}

export interface TeamServiceOptions {
  db: Database
  publisher?: RealtimePublisher
  logger?: Pick<Logger, 'warn'>
}

const memberColumns = {
  id: companyMembers.id,
  companyId: companyMembers.companyId,
  userId: companyMembers.userId,
  role: companyMembers.role,
  permissionKeys: companyMembers.permissionKeys,
  createdAt: companyMembers.createdAt,
  name: users.name,
  email: users.email,
  systemRole: users.systemRole,
}

type MemberRow = {
  id: string
  companyId: string
  userId: string
  role: MemberRole
  permissionKeys: string[] | null
  createdAt: Date
  name: string
  email: string
  systemRole: (typeof users.$inferSelect)['systemRole']
}

const ROLE_ORDER: Record<MemberRole, number> = { owner: 0, admin: 1, member: 2 }

export function toMemberDto(r: MemberRow): MemberDto {
  return {
    id: r.id,
    company_id: r.companyId,
    user_id: r.userId,
    role: r.role,
    permission_keys: r.permissionKeys,
    effective_permissions: [...effectivePermissions({ role: r.role, permissionKeys: r.permissionKeys, systemRole: r.systemRole })],
    user: { id: r.userId, name: r.name, email: r.email },
    created_at: r.createdAt.toISOString(),
  }
}

/**
 * Valida e normaliza chaves de permissão. Chave fora do catálogo → `validation` com `fields`.
 * Lista vazia vira `null` (matriz do papel: lista explícita só vale quando não é vazia, SPEC 3.3).
 */
export function normalizePermissionInput(keys: readonly string[] | null | undefined): string[] | null {
  if (!keys || keys.length === 0) return null
  const invalid = keys.map((k, i) => [k, i] as const).filter(([k]) => !isPermissionKey(k))
  if (invalid.length > 0) {
    throw new TeamError('validation', 'Chaves de permissão inválidas', 'invalid_permission_keys', {
      fields: invalid.map(([k, i]) => ({ path: `permission_keys.${i}`, message: `Chave desconhecida: ${k}` })),
    })
  }
  const normalized = normalizePermissions(keys)
  return normalized.length ? normalized : null
}

/** Grupos do modal "Permissões do membro" com as seções fixas e a matriz padrão do papel. */
export function permissionDefinitions(role?: MemberRole) {
  return {
    groups: PERMISSION_CATALOG.map((g) => ({ key: g.group, keys: [...g.keys] })),
    always_granted: [...ALWAYS_GRANTED_PERMISSIONS],
    owner_only: [...OWNER_ONLY_PERMISSIONS],
    ...(role ? { role, defaults: [...DEFAULT_ROLE_PERMISSIONS[role]] } : {}),
  }
}

export class TeamService {
  private readonly db: Database
  private readonly opts: TeamServiceOptions

  constructor(opts: TeamServiceOptions) {
    this.db = opts.db
    this.opts = opts
  }

  /** Membros na ordem owner < admin < member, depois por nome. */
  async list(companyId: string): Promise<MemberDto[]> {
    const rows = await this.db
      .select(memberColumns)
      .from(companyMembers)
      .innerJoin(users, eq(users.id, companyMembers.userId))
      .where(eq(companyMembers.companyId, companyId))
      .orderBy(asc(users.name))
    return rows.sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]).map(toMemberDto)
  }

  async get(companyId: string, userId: string): Promise<MemberDto> {
    return toMemberDto(await this.requireMember(this.db, companyId, userId))
  }

  /**
   * Muda papel e/ou permissões. `actor` precisa de `team.edit` (conferido na rota). Owner não é alterado por
   * terceiros (403); papel `owner` só por transferência (422); o owner não troca o próprio papel (409).
   * Permissões explícitas: só owner/admin da empresa.
   */
  async update(actor: TeamActor & { role: MemberRole | null }, companyId: string, targetUserId: string, input: UpdateMemberInput): Promise<MemberDto> {
    if (input.role === 'owner')
      throw new TeamError('validation', 'Use a transferência de propriedade para definir o proprietário', 'use_transfer_ownership', {
        fields: [{ path: 'role', message: 'Use a transferência de propriedade' }],
      })
    const target = await this.requireMember(this.db, companyId, targetUserId)
    const self = target.userId === actor.userId
    if (target.role === 'owner') {
      if (!self) throw forbidden('O proprietário não pode ser alterado por outro membro')
      if (input.role !== undefined) throw new TeamError('conflict', 'Transfira a propriedade antes de mudar o seu papel', 'owner_must_transfer')
      if (input.permissionKeys !== undefined)
        throw new TeamError('validation', 'O proprietário tem acesso total', 'owner_permissions_locked', {
          fields: [{ path: 'permission_keys', message: 'O proprietário tem acesso total' }],
        })
    }
    if (input.permissionKeys !== undefined && actor.role !== 'owner' && actor.role !== 'admin')
      throw forbidden('Só o proprietário ou um administrador define permissões')
    const permissionKeys = input.permissionKeys === undefined ? undefined : normalizePermissionInput(input.permissionKeys)

    const changes: Partial<typeof companyMembers.$inferInsert> = {}
    if (input.role !== undefined && input.role !== target.role) changes.role = input.role
    if (permissionKeys !== undefined && JSON.stringify(permissionKeys) !== JSON.stringify(target.permissionKeys)) changes.permissionKeys = permissionKeys
    if (Object.keys(changes).length === 0) return toMemberDto(target)

    await this.db.update(companyMembers).set({ ...changes, updatedAt: new Date() }).where(eq(companyMembers.id, target.id))
    const updated = await this.requireMember(this.db, companyId, targetUserId)
    await this.notify(updated)
    return toMemberDto(updated)
  }

  /** Remove o membro (`team.delete` na rota). O owner nunca é removido. */
  async remove(companyId: string, targetUserId: string): Promise<void> {
    const target = await this.requireMember(this.db, companyId, targetUserId)
    if (target.role === 'owner') throw forbidden('O proprietário não pode ser removido')
    await this.db.transaction(async (tx) => {
      await tx.delete(companyMembers).where(eq(companyMembers.id, target.id))
      await tx
        .update(users)
        .set({ lastCompanyId: null })
        .where(and(eq(users.id, targetUserId), eq(users.lastCompanyId, companyId)))
    })
    await this.publish(companyId, targetUserId, { company_id: companyId, user_id: targetUserId, permission_keys: null })
  }

  /**
   * Transfere a propriedade de forma atômica: o owner atual vira `admin` e o alvo (um admin) vira o único `owner`.
   * A linha do owner é travada (`FOR UPDATE`): transferências concorrentes do mesmo owner — só uma vence.
   */
  async transferOwnership(actor: TeamActor, companyId: string, targetUserId: string): Promise<{ owner: MemberDto; previous_owner: MemberDto }> {
    await this.db.transaction(async (tx) => {
      const [me] = await tx
        .select({ id: companyMembers.id, role: companyMembers.role })
        .from(companyMembers)
        .where(and(eq(companyMembers.companyId, companyId), eq(companyMembers.userId, actor.userId)))
        .for('update')
        .limit(1)
      if (!me) throw notFound('Empresa')
      if (me.role !== 'owner') throw forbidden('Só o proprietário transfere a propriedade')
      if (targetUserId === actor.userId) throw new TeamError('conflict', 'Você já é o proprietário', 'target_not_admin')
      const [target] = await tx
        .select({ id: companyMembers.id, role: companyMembers.role })
        .from(companyMembers)
        .where(and(eq(companyMembers.companyId, companyId), eq(companyMembers.userId, targetUserId)))
        .for('update')
        .limit(1)
      if (!target) throw notFound('Membro')
      if (target.role !== 'admin') throw new TeamError('conflict', 'A propriedade só pode ir para um administrador', 'target_not_admin')
      // Ordem importa por causa do índice parcial "um owner por empresa".
      await tx.update(companyMembers).set({ role: 'admin', updatedAt: sql`now()` }).where(eq(companyMembers.id, me.id))
      await tx.update(companyMembers).set({ role: 'owner', permissionKeys: null, updatedAt: sql`now()` }).where(eq(companyMembers.id, target.id))
    })
    const owner = await this.requireMember(this.db, companyId, targetUserId)
    const previous = await this.requireMember(this.db, companyId, actor.userId)
    await this.notify(owner)
    await this.notify(previous)
    return { owner: toMemberDto(owner), previous_owner: toMemberDto(previous) }
  }

  private async requireMember(db: Database, companyId: string, userId: string): Promise<MemberRow> {
    const [row] = await db
      .select(memberColumns)
      .from(companyMembers)
      .innerJoin(users, eq(users.id, companyMembers.userId))
      .where(and(eq(companyMembers.companyId, companyId), eq(companyMembers.userId, userId)))
      .limit(1)
    if (!row) throw notFound('Membro')
    return row
  }

  /** `member.permissions_changed` só para o usuário afetado (stream do usuário, T16). */
  private notify(m: MemberRow) {
    return this.publish(m.companyId, m.userId, { company_id: m.companyId, user_id: m.userId, role: m.role, permission_keys: m.permissionKeys })
  }

  private async publish(companyId: string, userId: string, data: Record<string, unknown>) {
    await this.opts.publisher
      ?.publish(companyId, 'member.permissions_changed', data, { userId })
      .catch((err: unknown) => this.opts.logger?.warn({ err }, 'realtime publish failed'))
  }
}
