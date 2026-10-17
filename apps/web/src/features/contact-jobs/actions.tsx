// Pontos de entrada dos jobs na página de contatos (T77 só importa): "Exportações recentes" (`contacts.view`) e
// "Importar CSV" (`contacts.edit`, que também é exigida para ler o status da importação).
import { useQuery } from '@tanstack/react-query'
import { FileUp, History } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import { hasAny, profileQuery, sessionFrom } from '@/lib/session'
import { ImportCsvDialog } from './import-dialog'
import { RecentExportsDialog } from './recent-exports'

export function useContactJobActions(): {
  recentExportsButton: ReactNode
  importButton: ReactNode
  dialogs: ReactNode
} {
  const t = useT('contact-jobs')
  const profile = useQuery(profileQuery()).data
  const session = profile ? sessionFrom(profile) : null
  const canEdit = !!session && hasAny(session, ['contacts.edit'])
  const [open, setOpen] = useState<'exports' | 'import' | null>(null)

  const recentExportsButton = (
    <Button variant="outline" size="sm" data-testid="contacts-exports-recent" onClick={() => setOpen('exports')}>
      <History aria-hidden /> {t('entry.recentExports')}
    </Button>
  )
  const importButton = canEdit ? (
    <Button variant="outline" size="sm" data-testid="contacts-import-csv" onClick={() => setOpen('import')}>
      <FileUp aria-hidden /> {t('entry.importCsv')}
    </Button>
  ) : null
  const dialogs = (
    <>
      <RecentExportsDialog open={open === 'exports'} onClose={() => setOpen(null)} />
      {canEdit ? <ImportCsvDialog open={open === 'import'} onClose={() => setOpen(null)} /> : null}
    </>
  )
  return { recentExportsButton, importButton, dialogs }
}
