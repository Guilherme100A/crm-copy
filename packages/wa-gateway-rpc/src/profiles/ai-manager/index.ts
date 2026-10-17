// Perfil `ai-manager` (SPEC T98): registrado ao importar o pacote, para `WA_RPC_PROFILE=ai-manager` valer em
// `loadWaGatewayConfig`/`createWaGatewayFromEnv`. Guia de extensão: docs/extension/ai-manager.md.
import { registerGatewayProfile } from '../../profiles'
import { aiManagerProfile } from './profile'

registerGatewayProfile(aiManagerProfile)

export * from './profile'
export * from './detect'
