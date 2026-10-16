# @crm/wa-gateway-rpc

Implementação de produção do `WaGateway` (`@crm/wa-port`), igual para o wa-worker do próprio CRM e para o worker
do ai-manager: comandos via `POST /internal/rpc` (Bearer `INTERNAL_TOKEN`) e eventos pelo Redis Stream
`wsm:events`.

```ts
import { createRpcGateway } from '@crm/wa-gateway-rpc'

const wa = createRpcGateway({ url: process.env.WA_RPC_URL!, token: process.env.INTERNAL_TOKEN!, profile: 'crm', redis })
await wa.refreshCapabilities() // opcional: consulta o worker; sem a consulta valem as do perfil
const off = wa.subscribe((event) => { /* WaEvent v1 */ })
await wa.close()
```

- **Perfis** (`profiles.ts`): mapa método do `WaGateway` → `target.method`. `crm` é completo. O perfil `ai-manager`
  fica em `src/profiles/ai-manager/**` (T98) e entra com `registerGatewayProfile`. Rota ausente = capacidade
  ausente: o método obrigatório lança `CapabilityNotSupportedError` sem chamar a rede; os opcionais da porta
  (`markRead`, `profile`) nem aparecem no gateway.
- **Erros**: `SendRejectedError`, `WaGatewayError` e `TransportNotConnectedError` voltam com as classes da porta
  (mesmo `code`/`status`). Worker fora do ar, timeout, token recusado ou resposta inválida →
  `WorkerUnavailableError` (`code: WORKER_UNAVAILABLE`, `status: 503`, `reason`).
- **Timeouts**: 30 s por chamada (`timeoutMs`, `WA_RPC_TIMEOUT_MS`); `sessions.requestPairingCode` usa 60 s
  (`pairingTimeoutMs`).
- **Eventos**: `subscribe` é fan-out ao vivo (XREAD, sem consumer group, a partir da assinatura). O consumo durável
  do CRM é o `StreamConsumer` do worker (grupo `crm`).
- **Montagem**: `createWaGatewayFromEnv(env)` lê `WA_GATEWAY=rpc|fake`, `WA_RPC_URL`, `INTERNAL_TOKEN`,
  `WA_RPC_PROFILE`, `WA_EVENTS_STREAM`, `REDIS_URL`. Usado por `apps/api/src/server.ts` e `apps/worker/src/main.ts`.
- **Testes**: `@crm/wa-gateway-rpc/testing` exporta `createWorkerContractHarness` para rodar a suíte de contrato da
  porta contra o wa-worker com `WA_TRANSPORT=fake` (em processo via `FakeControl`, ou processo filho via stream e
  BlobStore compartilhados).

## Fora do escopo (pendências)

- `sessions.setProxy` (ou update de proxy) não existe na porta, no RPC do wa-worker nem no engine. Hoje o proxy fica
  cifrado no CRM (T40) e a conexão só é marcada `requires_restart`. Precisa de método novo nos três (wa-port, T29,
  engine) e de uma rota no perfil `crm`.
- `capabilities` → `meta.capabilities`: o wa-worker ainda não expõe esse alvo, então o gateway usa as capacidades
  do perfil (todas `false`).
