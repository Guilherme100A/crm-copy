// Cards de Vendas e Rastreamento do hub (AC-T114-01; 19 §2.3, §2.4): itens fixos XPag e Notasy (Vendas) e UTMify
// (Rastreamento) + as fontes de registros da conta, entregues ao catálogo compartilhado `features/integrations/catalog.ts`
// (T59). Só `import type` de lá: o catálogo importa este módulo. Zenith fora de escopo (SPEC 10.1 nº 13).
import type { CatalogItem, RecordSource } from '@/features/integrations/catalog'
import { INVOICES_KEY, paymentsApi, PAYMENTS_KEY, tokenApi, UTMIFY_KEY } from './api'
import { INVOICES_SOURCE, PAYMENTS_SOURCE, paymentRecord, tokenRecord, UTMIFY_SOURCE } from './rules'

const EDIT = ['settings.integrations.edit'] as const
const VIEW = ['settings.integrations.view'] as const
const DELETE = ['settings.integrations.delete'] as const

const loadPayments = () => import('./payment-modal')
const loadInvoice = () => import('./invoice-modal')
const loadUtmify = () => import('./utmify-modal')

export const SALES_CATALOG: CatalogItem[] = [
  {
    id: 'xpag',
    category: 'sales',
    titleKey: 'settings-payments:catalog.xpag.title',
    descriptionKey: 'settings-payments:catalog.xpag.description',
    provider: 'xpag',
    providerLabel: 'XPag',
    initials: 'XP',
    modalKind: 'payments',
    editPermissions: EDIT,
    loadModal: loadPayments,
  },
  {
    id: 'notasy',
    category: 'sales',
    titleKey: 'settings-payments:catalog.notasy.title',
    descriptionKey: 'settings-payments:catalog.notasy.description',
    provider: 'notasy',
    providerLabel: 'Notasy',
    initials: 'NT',
    modalKind: 'invoice',
    editPermissions: EDIT,
    loadModal: loadInvoice,
  },
  {
    id: 'utmify',
    category: 'tracking',
    titleKey: 'settings-payments:catalog.utmify.title',
    descriptionKey: 'settings-payments:catalog.utmify.description',
    provider: 'utmify',
    providerLabel: 'UTMify',
    initials: 'UT',
    modalKind: 'utmify',
    editPermissions: EDIT,
    loadModal: loadUtmify,
  },
]

export const SALES_RECORD_SOURCES: RecordSource[] = [
  {
    id: PAYMENTS_SOURCE,
    category: 'sales',
    viewPermissions: VIEW,
    editPermissions: EDIT,
    deletePermissions: DELETE,
    query: () => ({
      queryKey: [...PAYMENTS_KEY, 'records'],
      queryFn: async () => (await paymentsApi.list('xpag')).map(paymentRecord),
    }),
    loadModal: loadPayments,
  },
  {
    id: INVOICES_SOURCE,
    category: 'sales',
    viewPermissions: VIEW,
    editPermissions: EDIT,
    deletePermissions: DELETE,
    query: () => ({
      queryKey: [...INVOICES_KEY, 'records'],
      queryFn: async () => (await tokenApi('invoice').list()).map((r) => tokenRecord('invoice', r)),
    }),
    loadModal: loadInvoice,
  },
  {
    id: UTMIFY_SOURCE,
    category: 'tracking',
    viewPermissions: VIEW,
    editPermissions: EDIT,
    deletePermissions: DELETE,
    query: () => ({
      queryKey: [...UTMIFY_KEY, 'records'],
      queryFn: async () => (await tokenApi('utmify').list()).map((r) => tokenRecord('utmify', r)),
    }),
    loadModal: loadUtmify,
  },
]
