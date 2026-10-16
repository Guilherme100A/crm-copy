// Dashboard: métricas de vendas (T55). Exporta só nomes próprios do dashboard (helpers de data ficam internos).
export {
  computeExpenses,
  computeKpis,
  EXPENSE_PERIOD_DAYS,
  previousRange as dashboardPreviousRange,
  trendOf as dashboardTrendOf,
  type ExpenseLine,
  type ExpenseRuleLike,
  type SalesKpis,
  type Trend as DashboardTrend,
} from './calc'
export * from './service'
