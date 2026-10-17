// Slot das abas do dashboard (T78 → T87): a T87 registra o painel de Atendimento pela pasta dela
// (`registerDashboardTab('attendance', AttendancePanel)`); sem registro, a aba mostra um aviso provisório.
// T87: o slot `history` (histórico de vendas) aparece abaixo do painel de Vendas; os painéis recebem também o período
// já calculado no fuso da empresa e a barra de filtros do dashboard (com o "Atualizar" do próprio painel).
import type { ComponentType, ReactNode } from 'react'
import type { DashboardSearch, Period } from './search'

export interface DashboardTabProps {
  /** Conexões selecionadas no dashboard (o Atendimento usa as mesmas). */
  connectionIds: string[]
  /** T87: período do filtro (inclusivo, no fuso da empresa). */
  period?: Period
  /** T87: fuso da empresa. */
  timeZone?: string
  /** T87: filtros da URL (produtos etc.). */
  search?: DashboardSearch
  /** T87: falso enquanto o fuso da empresa não chegou (as datas ainda podem mudar). */
  ready?: boolean
  /** T87: barra de filtros do dashboard ligada ao "Atualizar" do painel. */
  renderFilters?: (bar: DashboardFiltersSlot) => ReactNode
}

/** T87: o que o painel informa à barra de filtros. */
export interface DashboardFiltersSlot {
  computedAt: string | null
  refreshing: boolean
  onRefresh: () => void
}

export type DashboardSlotId = 'attendance' | 'history'

const tabs = new Map<string, ComponentType<DashboardTabProps>>()

export function registerDashboardTab(id: DashboardSlotId, component: ComponentType<DashboardTabProps>): () => void {
  tabs.set(id, component)
  return () => {
    if (tabs.get(id) === component) tabs.delete(id)
  }
}

export const dashboardTab = (id: DashboardSlotId): ComponentType<DashboardTabProps> | null => tabs.get(id) ?? null
