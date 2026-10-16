// Fluxos padrões por conexão (T61; 08 §3.3, 17 §3.F): um por conexão com boas-vindas, resposta padrão (+ atraso
// 1–168 h), conversa finalizada, atendimento finalizado e gatilhos por palavra-chave. `put` substitui tudo numa
// transação; `bulkUpdate` aplica a várias conexões com as sentinelas `keep`/`clear` por campo.
import { and, asc, eq, inArray, or } from 'drizzle-orm'
import {
  connectionFlowConfigs,
  connections,
  DEFAULT_RESPONSE_DELAY_HOURS,
  flows,
  KEYWORD_MATCH_TYPES,
  KEYWORD_RULE_TYPES,
  keywordTriggers,
  MAX_RESPONSE_DELAY_HOURS,
  MIN_RESPONSE_DELAY_HOURS,
  type Database,
  type KeywordCondition,
  type KeywordMatchType,
  type KeywordRuleType,
} from '@crm/db'
import { triggersInvalid, triggersNotFound } from './errors'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const MAX_KEYWORD_TRIGGERS = 100
export const MAX_KEYWORD_CONDITIONS = 20
export const MAX_KEYWORD_LENGTH = 200

/** Os quatro fluxos fixos (contam para o status de completude). */
export const FIXED_FLOW_FIELDS = ['welcome_flow_id', 'default_response_flow_id', 'finished_conversation_flow_id', 'finished_attendance_flow_id'] as const
export type FixedFlowField = (typeof FIXED_FLOW_FIELDS)[number]

export type ConfigStatus = 'empty' | 'incomplete' | 'complete'

export interface KeywordTriggerInput {
  id?: string
  flow_id?: string | null
  rule_type?: string
  conditions?: { keyword?: string | null; match_type?: string | null }[]
  /** Formato legado: uma condição na raiz do gatilho. */
  keyword?: string | null
  match_type?: string | null
  position?: number
  active?: boolean
  /** Nested attributes do produto de referência: `_destroy: true` remove o item. */
  _destroy?: boolean
}

export interface ConnectionFlowConfigInput {
  welcome_flow_id?: string | null
  default_response_flow_id?: string | null
  default_response_delay_hours?: number | null
  finished_conversation_flow_id?: string | null
  finished_attendance_flow_id?: string | null
  keyword_triggers?: KeywordTriggerInput[]
}

/** Valor da edição em massa: valor novo, `keep` (não altera) ou `clear` (anula). */
export type BulkValue<T> = T | 'keep' | 'clear' | '__keep__' | '__clear__'
export type BulkConfigInput = { [K in FixedFlowField]?: BulkValue<string | null> } & {
  default_response_delay_hours?: BulkValue<number | null>
  keyword_triggers?: BulkValue<KeywordTriggerInput[]>
}

export interface KeywordTriggerDto {
  id: string
  flow_id: string
  rule_type: KeywordRuleType
  conditions: KeywordCondition[]
  position: number
  active: boolean
}

export interface ConnectionFlowConfigDto {
  id: string | null
  connection_id: string
  connection_name: string
  welcome_flow_id: string | null
  default_response_flow_id: string | null
  default_response_delay_hours: number
  finished_conversation_flow_id: string | null
  finished_attendance_flow_id: string | null
  keyword_triggers: KeywordTriggerDto[]
  status: ConfigStatus
  /** Quantos dos 4 fluxos fixos estão preenchidos. */
  filled: number
  updated_at: string | null
}

type Field = { path: string; message: string }
type ConfigRow = typeof connectionFlowConfigs.$inferSelect
type TriggerRow = typeof keywordTriggers.$inferSelect

/** Valores normalizados de uma config (o que vai para o banco). */
interface ConfigValues {
  welcomeFlowId: string | null
  defaultResponseFlowId: string | null
  defaultResponseDelayHours: number
  finishedConversationFlowId: string | null
  finishedAttendanceFlowId: string | null
}
interface TriggerValues {
  flowId: string
  ruleType: KeywordRuleType
  conditions: KeywordCondition[]
  position: number
  active: boolean
}

const COLUMN: Record<FixedFlowField, keyof ConfigValues> = {
  welcome_flow_id: 'welcomeFlowId',
  default_response_flow_id: 'defaultResponseFlowId',
  finished_conversation_flow_id: 'finishedConversationFlowId',
  finished_attendance_flow_id: 'finishedAttendanceFlowId',
}

const isKeep = (v: unknown) => v === undefined || v === 'keep' || v === '__keep__'
const isClear = (v: unknown) => v === 'clear' || v === '__clear__'

export function configStatus(filled: number): ConfigStatus {
  return filled === 0 ? 'empty' : filled === FIXED_FLOW_FIELDS.length ? 'complete' : 'incomplete'
}

const emptyValues = (): ConfigValues => ({
  welcomeFlowId: null,
  defaultResponseFlowId: null,
  defaultResponseDelayHours: DEFAULT_RESPONSE_DELAY_HOURS,
  finishedConversationFlowId: null,
  finishedAttendanceFlowId: null,
})

export class ConnectionFlowConfigService {
  constructor(private readonly db: Database) {}

  /** Todas as conexões da empresa com a config de cada uma (vazia se não houver). */
  async list(companyId: string, opts: { status?: 'all' | ConfigStatus } = {}): Promise<ConnectionFlowConfigDto[]> {
    const conns = await this.db
      .select({ id: connections.id, name: connections.name })
      .from(connections)
      .where(eq(connections.companyId, companyId))
      .orderBy(asc(connections.name), asc(connections.createdAt))
    if (conns.length === 0) return []
    const configs = await this.db
      .select()
      .from(connectionFlowConfigs)
      .where(and(eq(connectionFlowConfigs.companyId, companyId), inArray(connectionFlowConfigs.connectionId, conns.map((c) => c.id))))
    const triggers = configs.length
      ? await this.db
          .select()
          .from(keywordTriggers)
          .where(inArray(keywordTriggers.configId, configs.map((c) => c.id)))
          .orderBy(asc(keywordTriggers.position), asc(keywordTriggers.createdAt))
      : []
    const byConn = new Map(configs.map((c) => [c.connectionId, c]))
    const items = conns.map((c) => {
      const cfg = byConn.get(c.id)
      return this.dto(c.id, c.name, cfg, cfg ? triggers.filter((t) => t.configId === cfg.id) : [])
    })
    return !opts.status || opts.status === 'all' ? items : items.filter((i) => i.status === opts.status)
  }

  async get(companyId: string, connectionId: string): Promise<ConnectionFlowConfigDto> {
    const conn = await this.connection(companyId, connectionId)
    const [cfg] = await this.db.select().from(connectionFlowConfigs).where(eq(connectionFlowConfigs.connectionId, conn.id)).limit(1)
    const triggers = cfg
      ? await this.db.select().from(keywordTriggers).where(eq(keywordTriggers.configId, cfg.id)).orderBy(asc(keywordTriggers.position), asc(keywordTriggers.createdAt))
      : []
    return this.dto(conn.id, conn.name, cfg, triggers)
  }

  /** Substitui a config e TODOS os gatilhos (campo ausente = vazio). Erro → nada muda. */
  async put(companyId: string, connectionId: string, input: ConnectionFlowConfigInput): Promise<ConnectionFlowConfigDto> {
    const conn = await this.connection(companyId, connectionId)
    const errors: Field[] = []
    const values = emptyValues()
    for (const field of FIXED_FLOW_FIELDS) values[COLUMN[field]] = (input[field] ?? null) as never
    if (input.default_response_delay_hours !== undefined && input.default_response_delay_hours !== null)
      values.defaultResponseDelayHours = input.default_response_delay_hours
    this.validateDelay(values.defaultResponseDelayHours, 'default_response_delay_hours', errors)
    const triggers = this.parseTriggers(input.keyword_triggers ?? [], 'keyword_triggers', errors)
    await this.validateFlows(companyId, values, triggers, '', errors)
    if (errors.length) throw triggersInvalid(errors)
    await this.db.transaction((tx) => this.write(tx as unknown as Database, companyId, conn.id, values, triggers))
    return this.get(companyId, conn.id)
  }

  /**
   * Edição em massa (17 §3.F): para cada conexão, campo ausente ou `keep` mantém o valor, `clear` anula (o atraso
   * volta a 24 h; os gatilhos ficam vazios) e qualquer outro valor substitui. Tudo ou nada.
   */
  async bulkUpdate(companyId: string, connectionIds: readonly string[], input: BulkConfigInput): Promise<ConnectionFlowConfigDto[]> {
    const errors: Field[] = []
    const ids = [...new Set(connectionIds)]
    if (ids.length === 0) errors.push({ path: 'connection_ids', message: 'Escolha ao menos uma conexão' })
    if (ids.length > 500) errors.push({ path: 'connection_ids', message: 'No máximo 500 conexões' })
    const owned = ids.filter((id) => UUID_RE.test(id)).length
      ? await this.db
          .select({ id: connections.id })
          .from(connections)
          .where(and(eq(connections.companyId, companyId), inArray(connections.id, ids.filter((id) => UUID_RE.test(id)))))
      : []
    if (ids.length && owned.length !== ids.length) errors.push({ path: 'connection_ids', message: 'Conexão não encontrada' })

    const patch: Partial<ConfigValues> = {}
    for (const field of FIXED_FLOW_FIELDS) {
      const v = input[field]
      if (isKeep(v)) continue
      patch[COLUMN[field]] = (isClear(v) ? null : v) as never
    }
    const delay = input.default_response_delay_hours
    if (!isKeep(delay)) {
      patch.defaultResponseDelayHours = isClear(delay) || delay === null ? DEFAULT_RESPONSE_DELAY_HOURS : (delay as number)
      this.validateDelay(patch.defaultResponseDelayHours, 'connection_flow_config.default_response_delay_hours', errors)
    }
    const rawTriggers = input.keyword_triggers
    let triggers: TriggerValues[] | undefined
    if (!isKeep(rawTriggers)) {
      if (isClear(rawTriggers)) triggers = []
      else if (Array.isArray(rawTriggers)) triggers = this.parseTriggers(rawTriggers, 'connection_flow_config.keyword_triggers', errors)
      else errors.push({ path: 'connection_flow_config.keyword_triggers', message: 'Use keep, clear ou a lista de gatilhos' })
    }
    for (const field of FIXED_FLOW_FIELDS) {
      const v = patch[COLUMN[field]]
      if (v !== undefined && v !== null && typeof v !== 'string') errors.push({ path: `connection_flow_config.${field}`, message: 'Fluxo inválido' })
    }
    if (!errors.length) await this.validateFlows(companyId, patch, triggers ?? [], 'connection_flow_config.', errors)
    if (errors.length) throw triggersInvalid(errors)

    await this.db.transaction(async (txAny) => {
      const tx = txAny as unknown as Database
      const current = await tx.select().from(connectionFlowConfigs).where(inArray(connectionFlowConfigs.connectionId, ids))
      const byConn = new Map(current.map((c) => [c.connectionId, c]))
      for (const connectionId of ids) {
        const cfg = byConn.get(connectionId)
        const base: ConfigValues = cfg
          ? {
              welcomeFlowId: cfg.welcomeFlowId,
              defaultResponseFlowId: cfg.defaultResponseFlowId,
              defaultResponseDelayHours: cfg.defaultResponseDelayHours,
              finishedConversationFlowId: cfg.finishedConversationFlowId,
              finishedAttendanceFlowId: cfg.finishedAttendanceFlowId,
            }
          : emptyValues()
        await this.write(tx, companyId, connectionId, { ...base, ...patch }, triggers)
      }
    })
    const all = await this.list(companyId)
    return all.filter((c) => ids.includes(c.connection_id))
  }

  /** Remove a config (e os gatilhos) da conexão. */
  async remove(companyId: string, connectionId: string): Promise<void> {
    const conn = await this.connection(companyId, connectionId)
    await this.db.delete(connectionFlowConfigs).where(and(eq(connectionFlowConfigs.companyId, companyId), eq(connectionFlowConfigs.connectionId, conn.id)))
  }

  /** Configs que apontam para o fluxo (fixos ou palavra-chave): bloqueiam a exclusão do fluxo (T28). */
  async flowReferences(companyId: string, flowId: string): Promise<{ id: string; connectionId: string; connectionName: string }[]> {
    if (!UUID_RE.test(flowId)) return []
    const fixed = await this.db
      .select({ id: connectionFlowConfigs.id, connectionId: connectionFlowConfigs.connectionId, connectionName: connections.name })
      .from(connectionFlowConfigs)
      .innerJoin(connections, eq(connections.id, connectionFlowConfigs.connectionId))
      .where(
        and(
          eq(connectionFlowConfigs.companyId, companyId),
          or(
            eq(connectionFlowConfigs.welcomeFlowId, flowId),
            eq(connectionFlowConfigs.defaultResponseFlowId, flowId),
            eq(connectionFlowConfigs.finishedConversationFlowId, flowId),
            eq(connectionFlowConfigs.finishedAttendanceFlowId, flowId),
          ),
        ),
      )
    const byKeyword = await this.db
      .selectDistinct({ id: connectionFlowConfigs.id, connectionId: connectionFlowConfigs.connectionId, connectionName: connections.name })
      .from(keywordTriggers)
      .innerJoin(connectionFlowConfigs, eq(connectionFlowConfigs.id, keywordTriggers.configId))
      .innerJoin(connections, eq(connections.id, connectionFlowConfigs.connectionId))
      .where(and(eq(keywordTriggers.companyId, companyId), eq(keywordTriggers.flowId, flowId)))
    const seen = new Set<string>()
    return [...fixed, ...byKeyword].filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
  }

  // ------------------------------------------------------------------ internos

  private async connection(companyId: string, connectionId: string): Promise<{ id: string; name: string }> {
    if (!UUID_RE.test(connectionId)) throw triggersNotFound()
    const [conn] = await this.db
      .select({ id: connections.id, name: connections.name })
      .from(connections)
      .where(and(eq(connections.companyId, companyId), eq(connections.id, connectionId)))
      .limit(1)
    if (!conn) throw triggersNotFound()
    return conn
  }

  private validateDelay(value: unknown, path: string, errors: Field[]): void {
    if (!Number.isInteger(value) || (value as number) < MIN_RESPONSE_DELAY_HOURS || (value as number) > MAX_RESPONSE_DELAY_HOURS)
      errors.push({ path, message: `O atraso deve ser um número inteiro de ${MIN_RESPONSE_DELAY_HOURS} a ${MAX_RESPONSE_DELAY_HOURS} horas` })
  }

  private parseTriggers(raw: readonly KeywordTriggerInput[], path: string, errors: Field[]): TriggerValues[] {
    if (!Array.isArray(raw)) {
      errors.push({ path, message: 'Lista de gatilhos inválida' })
      return []
    }
    const kept = raw.filter((t) => !t?._destroy)
    if (kept.length > MAX_KEYWORD_TRIGGERS) errors.push({ path, message: `No máximo ${MAX_KEYWORD_TRIGGERS} gatilhos` })
    return kept.map((t, i) => {
      const p = `${path}.${i}`
      const ruleType = (t.rule_type ?? 'any') as KeywordRuleType
      if (!(KEYWORD_RULE_TYPES as readonly string[]).includes(ruleType)) errors.push({ path: `${p}.rule_type`, message: 'Use any ou all' })
      if (typeof t.flow_id !== 'string' || !t.flow_id) errors.push({ path: `${p}.flow_id`, message: 'Escolha o fluxo do gatilho' })
      const rawConds = t.conditions ?? (t.keyword !== undefined ? [{ keyword: t.keyword, match_type: t.match_type ?? null }] : [])
      if (!Array.isArray(rawConds) || rawConds.length === 0) errors.push({ path: `${p}.conditions`, message: 'Informe ao menos uma condição' })
      if (Array.isArray(rawConds) && rawConds.length > MAX_KEYWORD_CONDITIONS) errors.push({ path: `${p}.conditions`, message: `No máximo ${MAX_KEYWORD_CONDITIONS} condições` })
      const conditions: KeywordCondition[] = (Array.isArray(rawConds) ? rawConds : []).map((c, j) => {
        const keyword = typeof c?.keyword === 'string' ? c.keyword.trim() : ''
        const matchType = (c?.match_type ?? 'contains') as KeywordMatchType
        if (!keyword) errors.push({ path: `${p}.conditions.${j}.keyword`, message: 'Informe a palavra-chave' })
        else if (keyword.length > MAX_KEYWORD_LENGTH) errors.push({ path: `${p}.conditions.${j}.keyword`, message: `No máximo ${MAX_KEYWORD_LENGTH} caracteres` })
        if (!(KEYWORD_MATCH_TYPES as readonly string[]).includes(matchType))
          errors.push({ path: `${p}.conditions.${j}.match_type`, message: 'Tipo de comparação inválido' })
        return { keyword, match_type: matchType }
      })
      return {
        flowId: typeof t.flow_id === 'string' ? t.flow_id : '',
        ruleType,
        conditions,
        position: Number.isInteger(t.position) ? (t.position as number) : i,
        active: t.active ?? true,
      }
    })
  }

  /** Todo fluxo citado precisa existir na empresa. */
  private async validateFlows(companyId: string, values: Partial<ConfigValues>, triggers: TriggerValues[], prefix: string, errors: Field[]): Promise<void> {
    const wanted = new Map<string, string[]>()
    const want = (id: string | null | undefined, path: string) => {
      if (!id) return
      wanted.set(id, [...(wanted.get(id) ?? []), path])
    }
    for (const field of FIXED_FLOW_FIELDS) want(values[COLUMN[field]] as string | null | undefined, `${prefix}${field}`)
    triggers.forEach((t, i) => want(t.flowId, `${prefix}keyword_triggers.${i}.flow_id`))
    if (wanted.size === 0) return
    const ids = [...wanted.keys()]
    const valid = ids.filter((id) => UUID_RE.test(id))
    const found = valid.length
      ? new Set((await this.db.select({ id: flows.id }).from(flows).where(and(eq(flows.companyId, companyId), inArray(flows.id, valid)))).map((f) => f.id))
      : new Set<string>()
    for (const [id, paths] of wanted) if (!found.has(id)) for (const path of paths) errors.push({ path, message: 'Fluxo não encontrado' })
  }

  /** Upsert da config e, com `triggers`, substituição dos gatilhos. */
  private async write(tx: Database, companyId: string, connectionId: string, values: ConfigValues, triggers: TriggerValues[] | undefined): Promise<void> {
    const set = { ...values, updatedAt: new Date() }
    const [cfg] = await tx
      .insert(connectionFlowConfigs)
      .values({ companyId, connectionId, ...set })
      .onConflictDoUpdate({ target: connectionFlowConfigs.connectionId, set })
      .returning({ id: connectionFlowConfigs.id })
    if (!triggers) return
    await tx.delete(keywordTriggers).where(eq(keywordTriggers.configId, cfg!.id))
    if (triggers.length) await tx.insert(keywordTriggers).values(triggers.map((t) => ({ companyId, configId: cfg!.id, ...t })))
  }

  private dto(connectionId: string, connectionName: string, cfg: ConfigRow | undefined, triggers: TriggerRow[]): ConnectionFlowConfigDto {
    const values = cfg ?? { id: null, ...emptyValues(), updatedAt: null }
    const filled = FIXED_FLOW_FIELDS.filter((f) => values[COLUMN[f]] !== null).length
    return {
      id: cfg?.id ?? null,
      connection_id: connectionId,
      connection_name: connectionName,
      welcome_flow_id: values.welcomeFlowId,
      default_response_flow_id: values.defaultResponseFlowId,
      default_response_delay_hours: values.defaultResponseDelayHours,
      finished_conversation_flow_id: values.finishedConversationFlowId,
      finished_attendance_flow_id: values.finishedAttendanceFlowId,
      keyword_triggers: triggers.map((t) => ({ id: t.id, flow_id: t.flowId, rule_type: t.ruleType, conditions: t.conditions, position: t.position, active: t.active })),
      status: configStatus(filled),
      filled,
      updated_at: cfg ? cfg.updatedAt.toISOString() : null,
    }
  }
}
