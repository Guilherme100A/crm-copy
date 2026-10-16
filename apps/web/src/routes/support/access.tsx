// Rota provisória do shell (T23); a tarefa do módulo substitui este arquivo.
import { createFileRoute } from '@tanstack/react-router'
import { PlaceholderPage } from '@/components/placeholder-page'

export const Route = createFileRoute('/support/access')({
  component: () => <PlaceholderPage id="support-access" titleKey="pages.supportAccess" />,
})
