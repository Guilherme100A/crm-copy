// `/facebook` (11 §2; AC-T106-01): vai para a primeira sub-rota permitida, na ordem campaigns → pixel → profiles.
import { createFileRoute, redirect } from '@tanstack/react-router'
import { registerFacebookRealtime } from '@/features/facebook/realtime'
import { facebookRedirect } from '@/features/facebook/rules'

// Handlers do SSE registrados junto com a árvore de rotas (antes de o shell abrir a conexão).
registerFacebookRealtime()

export const Route = createFileRoute('/facebook/')({
  beforeLoad: ({ context }) => {
    throw redirect({ to: facebookRedirect(context.session, null) ?? '/facebook/campaigns', replace: true } as never)
  },
  component: () => <section data-testid="page-facebook" />,
})
