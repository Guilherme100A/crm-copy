// Seeds por módulo (SPEC 2.4, compartilhado e ADITIVO): cada tarefa acrescenta o seu módulo nesta lista,
// num arquivo próprio em `seed/modules/<módulo>.ts`. A ordem de execução vem de `order` (default 100) e do nome,
// nunca da posição aqui: `runSeeds` ordena de forma determinística.
import type { SeedModule } from '../index.js'
import { aiPricesSeed } from './ai-prices.js'
import { supportUserSeed } from './support-user.js'

export const SEED_MODULES: SeedModule[] = [aiPricesSeed, supportUserSeed]
