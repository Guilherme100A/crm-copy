// `/forgot-password` (público, só deslogado).
import { createFileRoute } from '@tanstack/react-router'
import { ForgotPasswordPage } from '@/features/auth/forgot-password-page'
import { redirectIfAuthenticated } from '@/features/auth/guest'

export const Route = createFileRoute('/forgot-password')({
  beforeLoad: ({ context }) => redirectIfAuthenticated(context),
  component: ForgotPasswordPage,
})
