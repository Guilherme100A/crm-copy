// Página provisória das rotas do shell: cada tarefa de módulo substitui a sua (SPEC 2.4).
import { Construction } from 'lucide-react'
import { useT } from '@/i18n'

export function PlaceholderPage({ id, titleKey }: { id: string; titleKey: string }) {
  const t = useT()
  return (
    <section data-testid={`page-${id}`} className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{t(titleKey)}</h1>
      <div className="flex items-center gap-3 rounded-lg border border-dashed p-6 text-muted-foreground">
        <Construction className="size-5 shrink-0" aria-hidden />
        <p>{t('pages.placeholder')}</p>
      </div>
    </section>
  )
}
