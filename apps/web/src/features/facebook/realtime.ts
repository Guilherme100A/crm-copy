// Realtime do Gerenciador: `meta.bundle.progress` (T101) avisa o andamento do bundle; a tela inscrita relê o GET.
// Registrado no carregamento das rotas de `/facebook` (antes de o shell abrir o SSE; docs/licoes.md).
import { onRealtime } from '@/lib/realtime'

export interface BundleProgress {
  bundle_key: string
  status: 'loading' | 'partial' | 'refreshing' | 'ready'
  targets_done: number
  targets_total: number
  errors?: { ad_account_id: string; error: string }[]
  warnings?: string[]
}

const listeners = new Set<(p: BundleProgress) => void>()
let registered = false

export function registerFacebookRealtime(): void {
  if (registered) return
  registered = true
  onRealtime('meta.bundle.progress', (event) => {
    const data = event.data as BundleProgress | null
    if (!data?.bundle_key) return
    for (const l of [...listeners]) l(data)
  })
}

/** Inscreve a tela no progresso do bundle; devolve a função que cancela. */
export function onBundleProgress(listener: (p: BundleProgress) => void): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}
