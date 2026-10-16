// Job `contacts_import` (T67): roda na fila `imports` da T27 (`registerExportsJob`). Aqui só se registra o kind no
// processo e se configuram as dependências (arquivo enviado e gateway para consentimento/opt-out).
import { configureContactsImportKind, type ContactsImportDeps } from '@crm/core'

export { CONTACTS_IMPORT_KIND } from '@crm/core'

/** Dependências do import no worker: `files` (mesmo diretório da API; padrão STORAGE_DIR/exports) e `waGateway`. */
export function configureContactsImport(deps: ContactsImportDeps): void {
  configureContactsImportKind(deps)
}

/** Garante o kind registrado no processo (sem gateway, o consentimento não é repassado ao engine). */
export function registerContactsImportJob(): void {
  configureContactsImportKind({})
}
