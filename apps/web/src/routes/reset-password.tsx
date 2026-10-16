// `/reset-password?token=` (público, só deslogado).
import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { redirectIfAuthenticated } from '@/features/auth/guest'
import { ResetPasswordPage } from '@/features/auth/reset-password-page'

export const Route = createFileRoute('/reset-password')({
  validateSearch: z.object({ token: z.string().optional().catch(undefined) }),
  beforeLoad: ({ context }) => redirectIfAuthenticated(context),
  component: () => <ResetPasswordPage token={Route.useSearch().token} />,
})
