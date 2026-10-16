// Horários de atendimento por conexão (T31; 16 §3.3, §5): `put` substitui config e intervalos numa transação.
import { and, asc, eq } from 'drizzle-orm'
import { BUSINESS_HOUR_ACTIONS, businessHourConfigs, businessHours, flows, type BusinessHourAction, type Database } from '@crm/db'
import { deptInvalid, deptNotFound } from '../departments/errors'
import { intervalErrors, type BusinessHourInterval } from './is-open'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const MAX_INTERVALS = 70

export interface BusinessHoursInput {
  active: boolean
  action_type?: BusinessHourAction
  message_text?: string | null
  flow_id?: string | null
  business_hours?: BusinessHourInterval[]
}

export interface BusinessHoursDto {
  id: string | null
  connection_id: string
  active: boolean
  action_type: BusinessHourAction
  message_text: string | null
  flow_id: string | null
  business_hours: (Required<BusinessHourInterval> & { id: string })[]
  updated_at: string | null
}

export class BusinessHoursService {
  constructor(private readonly db: Database) {}

  /** Config da conexão; sem config → vazia (inativa, sem intervalos). */
  async get(companyId: string, connectionId: string): Promise<BusinessHoursDto> {
    this.assertConnection(connectionId)
    const [cfg] = await this.db
      .select()
      .from(businessHourConfigs)
      .where(and(eq(businessHourConfigs.companyId, companyId), eq(businessHourConfigs.connectionId, connectionId)))
      .limit(1)
    if (!cfg)
      return { id: null, connection_id: connectionId, active: false, action_type: 'message', message_text: null, flow_id: null, business_hours: [], updated_at: null }
    const hours = await this.db
      .select()
      .from(businessHours)
      .where(eq(businessHours.configId, cfg.id))
      .orderBy(asc(businessHours.dayOfWeek), asc(businessHours.startTime), asc(businessHours.position))
    return {
      id: cfg.id,
      connection_id: cfg.connectionId,
      active: cfg.active,
      action_type: cfg.actionType,
      message_text: cfg.messageText,
      flow_id: cfg.flowId,
      business_hours: hours.map((h) => ({ id: h.id, day_of_week: h.dayOfWeek, start_time: h.startTime, end_time: h.endTime, active: h.active })),
      updated_at: cfg.updatedAt.toISOString(),
    }
  }

  /** Valida e substitui a config e TODOS os intervalos (AC-T31-03). Erro → nada muda. */
  async put(companyId: string, connectionId: string, input: BusinessHoursInput): Promise<BusinessHoursDto> {
    this.assertConnection(connectionId)
    const actionType = input.action_type ?? 'message'
    const messageText = typeof input.message_text === 'string' ? input.message_text : null
    const flowId = input.flow_id ?? null
    const hours = input.business_hours ?? []
    const errors: { path: string; message: string }[] = []
    if (typeof input.active !== 'boolean') errors.push({ path: 'active', message: 'Obrigatório' })
    if (!(BUSINESS_HOUR_ACTIONS as readonly string[]).includes(actionType)) errors.push({ path: 'action_type', message: 'Use message ou flow' })
    if (input.active && actionType === 'message' && !messageText?.trim()) errors.push({ path: 'message_text', message: 'Informe a mensagem fora do horário' })
    if (input.active && actionType === 'flow' && !flowId) errors.push({ path: 'flow_id', message: 'Escolha o fluxo fora do horário' })
    if (flowId && !(await this.flowExists(companyId, flowId))) errors.push({ path: 'flow_id', message: 'Fluxo não encontrado' })
    if (hours.length > MAX_INTERVALS) errors.push({ path: 'business_hours', message: `No máximo ${MAX_INTERVALS} intervalos` })
    hours.forEach((h, i) => {
      for (const [field, message] of Object.entries(intervalErrors(h))) errors.push({ path: `business_hours.${i}.${field}`, message: message! })
    })
    if (errors.length) throw deptInvalid(errors)

    await this.db.transaction(async (tx) => {
      const values = { active: input.active, actionType, messageText, flowId, updatedAt: new Date() }
      const [cfg] = await tx
        .insert(businessHourConfigs)
        .values({ companyId, connectionId, ...values })
        .onConflictDoUpdate({ target: [businessHourConfigs.companyId, businessHourConfigs.connectionId], set: values })
        .returning({ id: businessHourConfigs.id })
      await tx.delete(businessHours).where(eq(businessHours.configId, cfg!.id))
      if (hours.length)
        await tx.insert(businessHours).values(
          hours.map((h, position) => ({ companyId, configId: cfg!.id, dayOfWeek: h.day_of_week, startTime: h.start_time, endTime: h.end_time, active: h.active ?? true, position })),
        )
    })
    return this.get(companyId, connectionId)
  }

  /** Configs que apontam para o fluxo (bloqueiam a exclusão do fluxo, T28). */
  async flowReferences(companyId: string, flowId: string): Promise<{ id: string; connectionId: string }[]> {
    if (!UUID_RE.test(flowId)) return []
    return this.db
      .select({ id: businessHourConfigs.id, connectionId: businessHourConfigs.connectionId })
      .from(businessHourConfigs)
      .where(and(eq(businessHourConfigs.companyId, companyId), eq(businessHourConfigs.flowId, flowId)))
  }

  private assertConnection(connectionId: string): void {
    if (!UUID_RE.test(connectionId)) throw deptNotFound('Conexão')
  }

  private async flowExists(companyId: string, flowId: string): Promise<boolean> {
    if (!UUID_RE.test(flowId)) return false
    const [f] = await this.db.select({ id: flows.id }).from(flows).where(and(eq(flows.companyId, companyId), eq(flows.id, flowId))).limit(1)
    return Boolean(f)
  }
}
