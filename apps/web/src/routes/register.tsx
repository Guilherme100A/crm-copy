// `/register` (público, só deslogado). `?ref`/`?via` = código de indicação (spec 01 §2; afiliação T97).
import { createFileRoute } from '@tanstack/react-router'
import { referralSearch, RegisterRoutePage } from '@/features/auth/register-route'
import { redirectIfAuthenticated } from '@/features/auth/guest'

export const Route = createFileRoute('/register')({
  validateSearch: referralSearch,
  beforeLoad: ({ context }) => redirectIfAuthenticated(context),
  component: () => <RegisterRoutePage search={Route.useSearch()} />,
})
