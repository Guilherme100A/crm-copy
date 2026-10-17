// `/facebook/links` (revisão 3; permissão facebook.pixel): links rastreáveis (opcionais, para anúncios com destino
// site/link; anúncio de clique para WhatsApp não usa link).
import { createFileRoute, redirect } from '@tanstack/react-router'
import { FacebookLayout } from '@/features/facebook/layout'
import { LinksPage } from '@/features/facebook/links-page'
import { registerFacebookRealtime } from '@/features/facebook/realtime'
import { facebookRedirect } from '@/features/facebook/rules'

registerFacebookRealtime()

export const Route = createFileRoute('/facebook/links')({
  beforeLoad: ({ context }) => {
    const to = facebookRedirect(context.session, 'links')
    if (to) throw redirect({ to, replace: true } as never)
  },
  component: () => (
    <FacebookLayout active="links">
      <LinksPage />
    </FacebookLayout>
  ),
})
