// Jobs `contacts_export` (fila `exports`) e `contacts_bulk_delete` (fila `imports`) da T66: rodam nos workers da
// T27 (`registerExportsJob`); aqui só se registram os kinds no processo.
import { ensureContactsBulkKinds } from '@crm/core'

export { CONTACTS_BULK_DELETE_KIND, CONTACTS_EXPORT_KIND, configureContactsBulk } from '@crm/core'

export function registerContactsBulkJobs(): void {
  ensureContactsBulkKinds()
}
