// De onde vêm as sessões WhatsApp de uma empresa (para pausar ao desativá-la). O módulo de conexões (T40)
// registra a fonte dele; testes e a API podem injetar uma fonte direto no serviço.

export type CompanySessionsSource = (companyId: string) => Promise<readonly string[]> | readonly string[]

const sources = new Set<CompanySessionsSource>()

/** Registra uma fonte; devolve a função que desfaz o registro. */
export function registerCompanySessionsSource(source: CompanySessionsSource): () => void {
  sources.add(source)
  return () => {
    sources.delete(source)
  }
}

/** Ids distintos de todas as fontes registradas + as extras. */
export async function companySessionIds(companyId: string, extra: readonly CompanySessionsSource[] = []): Promise<string[]> {
  const ids = new Set<string>()
  for (const source of [...sources, ...extra]) for (const id of await source(companyId)) ids.add(id)
  return [...ids]
}
