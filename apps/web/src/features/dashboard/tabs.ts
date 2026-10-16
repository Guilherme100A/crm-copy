// Slot das abas do dashboard (T78 → T87): a T87 registra o painel de Atendimento pela pasta dela
// (`registerDashboardTab('attendance', AttendancePanel)`); sem registro, a aba mostra um aviso provisório.
import type { ComponentType } from 'react'

export interface DashboardTabProps {
  /** Conexões selecionadas no dashboard (o Atendimento usa as mesmas). */
  connectionIds: string[]
}

const tabs = new Map<string, ComponentType<DashboardTabProps>>()

export function registerDashboardTab(id: 'attendance', component: ComponentType<DashboardTabProps>): () => void {
  tabs.set(id, component)
  return () => {
    if (tabs.get(id) === component) tabs.delete(id)
  }
}

export const dashboardTab = (id: 'attendance'): ComponentType<DashboardTabProps> | null => tabs.get(id) ?? null
