// Rota provisória do shell (T23); a tarefa do módulo substitui este arquivo.
import { createFileRoute } from '@tanstack/react-router'
import { PlaceholderPage } from '@/components/placeholder-page'

export const Route = createFileRoute('/crms/')({
  component: () => <PlaceholderPage id="kanban" titleKey="pages.kanban" />,
})
