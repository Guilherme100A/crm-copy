// Tela do usuário de suporte (T54; 16 §3.7, T32): pedir acesso, pedidos e concessões.
import { createFileRoute } from '@tanstack/react-router'
import { SupportAccessPage } from '@/features/settings-support/support-page'

export const Route = createFileRoute('/support/access')({
  component: SupportAccessPage,
})
