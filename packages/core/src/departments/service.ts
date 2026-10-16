// Departamentos (T31; 16 §3.2) e escopo de chat por membro (departamentos + conexões).
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm'
import { buildPageMeta, pageOffset, type PageResponse } from '@crm/shared'
import { companyMembers, departments, DEFAULT_DEPARTMENT_COLOR, memberConnections, memberDepartments, type Database } from '@crm/db'
import { deptInvalid, deptNotFound } from './errors'

export const DEPARTMENT_NAME_MAX = 60
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface DepartmentDto {
  id: string
  name: string
  color: string
  created_at: string
  updated_at: string
}

export interface DepartmentInput {
  name?: string
  color?: string | null
}

export interface MemberScopeDto {
  member_id: string
  department_ids: string[]
  connection_ids: string[]
}

/** `#abc`/`#AbCdEf` → `#AABBCC`; inválido → `null`. */
export function normalizeHexColor(value: string): string | null {
  if (typeof value !== 'string' || !HEX_RE.test(value.trim())) return null
  let hex = value.trim().slice(1)
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join('')
  return `#${hex.toUpperCase()}`
}

/** Minúsculas sem acento (para a busca). */
export function foldText(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

const ACCENTED = 'áàâãäåéèêëíìîïóòôõöúùûüçñý'
const PLAIN = 'aaaaaaeeeeiiiiooooouuuucny'

const toDto = (r: typeof departments.$inferSelect): DepartmentDto => ({
  id: r.id,
  name: r.name,
  color: r.color,
  created_at: r.createdAt.toISOString(),
  updated_at: r.updatedAt.toISOString(),
})

export class DepartmentsService {
  constructor(private readonly db: Database) {}

  async list(companyId: string, q: { page: number; limit: number; search?: string; skip_total?: boolean }): Promise<PageResponse<DepartmentDto>> {
    const term = q.search?.trim() ? foldText(q.search.trim()).replace(/[\\%_]/g, (c) => `\\${c}`) : null
    const where = and(
      eq(departments.companyId, companyId),
      term ? sql`translate(lower(${departments.name}), ${ACCENTED}, ${PLAIN}) like ${`%${term}%`}` : undefined,
    )
    const rows = await this.db
      .select()
      .from(departments)
      .where(where)
      .orderBy(asc(departments.name), asc(departments.id))
      .limit(q.skip_total ? q.limit + 1 : q.limit)
      .offset(pageOffset(q))
    if (q.skip_total) return { items: rows.slice(0, q.limit).map(toDto), page: buildPageMeta(q, { fetchedCount: rows.length }) }
    const [c] = await this.db.select({ n: count() }).from(departments).where(where)
    return { items: rows.map(toDto), page: buildPageMeta(q, { total: c?.n ?? 0 }) }
  }

  async all(companyId: string): Promise<DepartmentDto[]> {
    const rows = await this.db.select().from(departments).where(eq(departments.companyId, companyId)).orderBy(asc(departments.name), asc(departments.id))
    return rows.map(toDto)
  }

  async get(companyId: string, id: string): Promise<DepartmentDto> {
    return toDto(await this.row(companyId, id))
  }

  async create(companyId: string, input: DepartmentInput): Promise<DepartmentDto> {
    const v = this.validate(input, true)
    const [row] = await this.db.insert(departments).values({ companyId, name: v.name!, color: v.color ?? DEFAULT_DEPARTMENT_COLOR }).returning()
    return toDto(row!)
  }

  async update(companyId: string, id: string, input: DepartmentInput): Promise<DepartmentDto> {
    await this.row(companyId, id)
    const v = this.validate(input, false)
    const [row] = await this.db
      .update(departments)
      .set({ ...(v.name !== undefined ? { name: v.name } : {}), ...(v.color !== undefined ? { color: v.color ?? DEFAULT_DEPARTMENT_COLOR } : {}), updatedAt: new Date() })
      .where(and(eq(departments.companyId, companyId), eq(departments.id, id)))
      .returning()
    return toDto(row!)
  }

  /** Remove o departamento; os vínculos de membros saem por cascata e os chats ficam sem departamento (SET NULL). */
  async delete(companyId: string, id: string): Promise<void> {
    await this.row(companyId, id)
    await this.db.delete(departments).where(and(eq(departments.companyId, companyId), eq(departments.id, id)))
  }

  // ---------- escopo do membro ----------

  async getMemberScope(companyId: string, memberId: string): Promise<MemberScopeDto> {
    await this.member(companyId, memberId)
    const [deps, conns] = await Promise.all([
      this.db.select({ id: memberDepartments.departmentId }).from(memberDepartments).where(eq(memberDepartments.memberId, memberId)),
      this.db.select({ id: memberConnections.connectionId }).from(memberConnections).where(eq(memberConnections.memberId, memberId)),
    ])
    return { member_id: memberId, department_ids: deps.map((d) => d.id).sort(), connection_ids: conns.map((c) => c.id).sort() }
  }

  /** Substitui departamentos e conexões do membro (listas vazias = vê todos). */
  async setMemberScope(companyId: string, memberId: string, input: { department_ids?: string[]; connection_ids?: string[] }): Promise<MemberScopeDto> {
    await this.member(companyId, memberId)
    const deptIds = [...new Set(input.department_ids ?? [])]
    const connIds = [...new Set(input.connection_ids ?? [])]
    const badConn = connIds.findIndex((c) => !UUID_RE.test(c))
    if (badConn >= 0) throw deptInvalid([{ path: `connection_ids.${badConn}`, message: 'Conexão inválida' }])
    if (deptIds.length) {
      const own = deptIds.every((d) => UUID_RE.test(d))
        ? await this.db.select({ id: departments.id }).from(departments).where(and(eq(departments.companyId, companyId), inArray(departments.id, deptIds)))
        : []
      if (own.length !== deptIds.length) throw deptInvalid([{ path: 'department_ids', message: 'Departamento não encontrado' }])
    }
    await this.db.transaction(async (tx) => {
      if (input.department_ids !== undefined) {
        await tx.delete(memberDepartments).where(eq(memberDepartments.memberId, memberId))
        if (deptIds.length) await tx.insert(memberDepartments).values(deptIds.map((departmentId) => ({ companyId, memberId, departmentId })))
      }
      if (input.connection_ids !== undefined) {
        await tx.delete(memberConnections).where(eq(memberConnections.memberId, memberId))
        if (connIds.length) await tx.insert(memberConnections).values(connIds.map((connectionId) => ({ companyId, memberId, connectionId })))
      }
    })
    return this.getMemberScope(companyId, memberId)
  }

  // ---------- internos ----------

  private validate(input: DepartmentInput, creating: boolean): { name?: string; color?: string | null } {
    const out: { name?: string; color?: string | null } = {}
    const errors: { path: string; message: string }[] = []
    if (input.name !== undefined || creating) {
      const name = typeof input.name === 'string' ? input.name.trim() : ''
      if (!name) errors.push({ path: 'name', message: 'Informe o nome do departamento' })
      else if (name.length > DEPARTMENT_NAME_MAX) errors.push({ path: 'name', message: `No máximo ${DEPARTMENT_NAME_MAX} caracteres` })
      else out.name = name
    }
    if (input.color !== undefined && input.color !== null && input.color !== '') {
      const color = normalizeHexColor(input.color)
      if (!color) errors.push({ path: 'color', message: 'Cor deve ser hexadecimal (ex.: #3B82F6)' })
      else out.color = color
    } else if (input.color === null || input.color === '') out.color = null
    if (errors.length) throw deptInvalid(errors)
    return out
  }

  private async row(companyId: string, id: string) {
    if (!UUID_RE.test(id)) throw deptNotFound()
    const [row] = await this.db.select().from(departments).where(and(eq(departments.companyId, companyId), eq(departments.id, id))).limit(1)
    if (!row) throw deptNotFound()
    return row
  }

  private async member(companyId: string, memberId: string) {
    if (!UUID_RE.test(memberId)) throw deptNotFound('Membro')
    const [m] = await this.db
      .select({ id: companyMembers.id })
      .from(companyMembers)
      .where(and(eq(companyMembers.companyId, companyId), eq(companyMembers.id, memberId)))
      .limit(1)
    if (!m) throw deptNotFound('Membro')
    return m
  }
}
