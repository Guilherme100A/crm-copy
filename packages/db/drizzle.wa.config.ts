import { defineConfig } from 'drizzle-kit'

// Migrations das tabelas `public.*` do WhatsApp (iguais às do ai-manager; tabelas no T06).
// Gerar: pnpm --filter @crm/db db:generate:wa --name <txx>_<slug>
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/wa/index.ts',
  out: './drizzle/wa',
  schemaFilter: ['public'],
  migrations: { schema: 'drizzle', table: '__drizzle_migrations' },
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://wsm:wsm@127.0.0.1:5432/crm' },
})
