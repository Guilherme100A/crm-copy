// `/auth/sso` (público, com ou sem sessão): entrada pelo painel do ai-manager (`#token=<jwt>`; ver features/auth/sso-page).
import { createFileRoute } from '@tanstack/react-router'
import { SsoPage } from '@/features/auth/sso-page'

export const Route = createFileRoute('/auth/sso')({
  component: SsoPage,
})
