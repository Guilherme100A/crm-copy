// `/customers` (05 §2; permissão contacts.view): lista de contatos com filtros nos search params tipados (T77).
import { createFileRoute } from '@tanstack/react-router'
import { useCallback } from 'react'
import { ContactsPage } from '@/features/contacts/contacts-page'
import { contactsSearchSchema, type ContactsSearch } from '@/features/contacts/filters'
import { registerContactsRealtime } from '@/features/contacts/realtime'

// Handlers do SSE registrados junto com a árvore de rotas (antes de o shell abrir a conexão).
registerContactsRealtime()

export const Route = createFileRoute('/customers/')({
  validateSearch: contactsSearchSchema,
  component: CustomersRoute,
})

/** Tira chaves vazias para a URL ficar limpa. */
const clean = (s: ContactsSearch): ContactsSearch =>
  Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0))) as ContactsSearch

function CustomersRoute() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const onSearch = useCallback((next: ContactsSearch) => void navigate({ search: clean(next), replace: true }), [navigate])
  return <ContactsPage search={search} onSearch={onSearch} />
}
