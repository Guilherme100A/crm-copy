// `/cadastro`: alias de `/register` (mesmo componente; spec 01 §2).
import { createFileRoute } from '@tanstack/react-router'
import { referralSearch, RegisterRoutePage } from '@/features/auth/register-route'
import { redirectIfAuthenticated } from '@/features/auth/guest'

export const Route = createFileRoute('/cadastro')({
  validateSearch: referralSearch,
  beforeLoad: ({ context }) => redirectIfAuthenticated(context),
  component: () => <RegisterRoutePage search={Route.useSearch()} />,
})
