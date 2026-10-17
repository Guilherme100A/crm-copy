// Liga o painel de Atendimento ao slot da T78 (importado estaticamente por `features/dashboard/dashboard-page.tsx`).
import { registerDashboardTab } from '@/features/dashboard/tabs'
import { AttendancePanel } from './attendance-panel'

registerDashboardTab('attendance', AttendancePanel)
