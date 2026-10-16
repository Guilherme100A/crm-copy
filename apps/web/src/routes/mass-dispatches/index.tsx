// Rota provisória do shell (T23); a tarefa do módulo substitui este arquivo.
import { createFileRoute } from '@tanstack/react-router'
import { PlaceholderPage } from '@/components/placeholder-page'

export const Route = createFileRoute('/mass-dispatches/')({
  component: () => <PlaceholderPage id="mass-dispatch" titleKey="pages.massDispatch" />,
})
