// Liga o histórico de vendas ao slot `history` da T78 (abaixo do painel de Vendas; importado estaticamente por
// `features/dashboard/dashboard-page.tsx`).
import { registerDashboardTab } from '@/features/dashboard/tabs'
import { HistoryPanel } from './history-panel'

registerDashboardTab('history', HistoryPanel)
