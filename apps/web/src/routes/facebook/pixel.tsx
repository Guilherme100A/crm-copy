// `/facebook/pixel` (11 §2.2; permissão facebook.pixel): configurações de pixel (Conversions API). Sem a permissão, vai
// para a primeira sub-rota permitida (AC-T106-01).
import { createFileRoute, redirect } from '@tanstack/react-router'
import { FacebookLayout } from '@/features/facebook/layout'
import { PixelPage } from '@/features/facebook/pixel-page'
import { registerFacebookRealtime } from '@/features/facebook/realtime'
import { facebookRedirect } from '@/features/facebook/rules'

registerFacebookRealtime()

export const Route = createFileRoute('/facebook/pixel')({
  beforeLoad: ({ context }) => {
    const to = facebookRedirect(context.session, 'pixel')
    if (to) throw redirect({ to, replace: true } as never)
  },
  component: () => (
    <FacebookLayout active="pixel">
      <PixelPage />
    </FacebookLayout>
  ),
})
