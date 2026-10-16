import { customType } from 'drizzle-orm/pg-core'

// bytea <-> Buffer (node-postgres já devolve Buffer para bytea).
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea'
  },
})
