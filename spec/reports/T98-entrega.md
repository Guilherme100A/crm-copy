STATUS: DONE

T98 — Extensão: perfil ai-manager do gateway e documentação · worktree `leonas-crm-wt/T98` (branch `task/T98`, base `965cd9b`) · tempo: ~16 min (00:08 → 00:24) + rodada 2 ~5 min (00:25 → 00:30).

## Arquivos alterados

Paths da tarefa:
- `packages/wa-gateway-rpc/src/profiles/ai-manager/profile.ts`: perfil `ai-manager`. Alvos de hoje + rotas aditivas A3/A7/A8 (`AI_MANAGER_CURRENT_ROUTES`, `AI_MANAGER_ADDITIVE_ROUTES`) e `withoutRoutes`.
- `packages/wa-gateway-rpc/src/profiles/ai-manager/detect.ts`: `detectAiManagerCapabilities` (sonda cada alvo aditivo uma vez com `args: []`; `UNKNOWN_METHOD` = ausente) e `createAiManagerGateway` (gateway com o perfil reduzido + `capabilityReport { supported, missing, missingChanges }`).
- `packages/wa-gateway-rpc/src/profiles/ai-manager/index.ts`: `registerGatewayProfile(aiManagerProfile)` + exports.
- `packages/wa-gateway-rpc/src/profiles/ai-manager/testing/simulator.ts`: servidor RPC simulado do ai-manager (`node:http`, porta 0).
  - Lista fechada de hoje, `UNKNOWN_METHOD` 400, erros serializados como no `serializeError`, `/internal/fake/*`.
  - Com `additive`: A1 (outbox no stream), A3, A7 e A8.
- `packages/wa-gateway-rpc/src/profiles/ai-manager/fixtures/public/**`: as 8 migrations + `meta/_journal.json` do ai-manager, copiadas com LF. O conteúdo é idêntico a `packages/db/drizzle/wa`.
- Testes: `profile.unit.test.ts`, `contract.unit.test.ts`, `migrations.db.unit.test.ts`, `docs.unit.test.ts`.
- `docs/extension/ai-manager.md`: o guia, com:
  - modos e a regra "um dono por socket";
  - as variáveis reais;
  - o mapa de métodos e a detecção;
  - o patch A1–A8 com o arquivo de destino de cada item;
  - banco (só o conjunto `crm`), migração standalone → extensão sem novo QR, e lacunas.

Liberado pelo Orquestrador (aditivo):
- `packages/wa-port/src/contract/suite.ts`:
  - `defineWaGatewayContract(name, factory, { only?, skip? })` por grupo;
  - `WA_GATEWAY_CONTRACT_GROUPS`, `WA_GATEWAY_CONTRACT_TESTS` (título → grupos), `isContractTestEnabled`;
  - teste fora do filtro → `it.skip`; título sem grupo → erro ao registrar.
  - Sem opções, nada muda. Alterei uma única linha existente: a assinatura de implementação da função, para receber o 3º parâmetro.

Liberado na rodada 2 (aditivo): `packages/wa-gateway-rpc/src/config.ts`. Com `WA_RPC_PROFILE=ai-manager`, `createWaGatewayFromEnv` monta `createLazyAiManagerGateway`; os outros perfis seguem com `createRpcGateway`. São +1 import e +2 linhas, e a chamada `const rpc = createRpcGateway({` virou `create({`.

Compartilhados (só aditivo):
- `packages/wa-gateway-rpc/src/index.ts`: +1 linha `export * from './profiles/ai-manager/index'`.
- `.env.example`: +1 linha de comentário sobre o modo extensão.
- `packages/wa-port/src/contract/suite.unit.test.ts`: +1 chamada com `only`.

## Verify: 0 (`node spec/verify/verify.mjs T98 --role operario --base 965cd9b`)

- typecheck, lint e test de `@crm/wa-port` e `@crm/wa-gateway-rpc`: ok.
- Todas as regras F-*: ok.
- Escopo: 22 arquivos, ok.

A 1ª execução reprovou num teste da T46, que não é meu: `contract.db.unit.test.ts > subscribe recebe os eventos que o próprio worker publica`. O `message.inbound` do wa-worker real não chegou em 10 s, com o verify da T100 rodando junto. Sozinho o arquivo passou (23/23) e a 2ª execução do verify passou.

## Notas

- **Decisão send/gates (Orquestrador):**
  - `send`/`sendGroup` do perfil apontam para `messages.send`/`messages.sendGroup`, que é a proposta **A8** (fora de A1–A7). Hoje esses alvos não existem, então são capacidade ausente.
  - O perfil NUNCA usa `messages.enqueue`: é a `MessageQueue` crua, sem os gates do SendPipeline. Um teste trava isso.
  - A idempotência por `clientMessageId` na A8 fica numa chave Redis (`SET NX` + TTL), sem coluna nova em `public.messages`.
- **Subconjunto da suíte (AC-T98-01):**
  - Contra o ai-manager de hoje, a suíte roda com `only: ['capabilities','sessions','cancel','groups']`: 7 testes rodam e 12 ficam em skip.
  - O "resto" é afirmado em `profile.unit.test.ts`: com detecção, cada método ausente (send, sendGroup, downloadMedia, presence, listContacts, recordConsent, optOut, react, deleteForEveryone) lança `CapabilityNotSupportedError` sem chamada de rede (o contador de chamadas do simulador não muda).
  - `markRead`/`profile` ficam fora do gateway. `missingChanges = ['A3','A7','A8']`.
  - Sem detecção, o worker responde `UNKNOWN_METHOD` e o erro é o mesmo, com `remote: true`.
  - O `cancel` que precisa de mensagem enfileirada depende de `send` e entra no resto.
- **AC-T98-02:** a suíte inteira (19 testes) passa contra o simulador com A1/A3/A7/A8. Os eventos saem do outbox do simulador num stream Redis único por arquivo. `presence`/`listContacts`/`sendGroup` são testados à parte.
- **Fixture (AC-T98-03):**
  - Cópia do `packages/db/drizzle` do ai-manager dentro dos Paths, aplicada via `runMigrations(db, { set: 'wa', folders: { wa: FIXTURE } })`, como o ai-manager faz (`drizzle.__drizzle_migrations`).
  - O snapshot de `public` (tabelas, colunas, constraints, índices, enums, sequências, funções, triggers, grants) e o controle de migrations do ai-manager ficam iguais depois de aplicar `crm` duas vezes.
  - Uma checagem de controle confirma que o snapshot detecta mudança.
  - O teste não lê `../ai-manager`.
- **Eventos sem A1:** o RPC não deixa detectar se o outbox existe. O guia documenta e o relatório de detecção cobre só os métodos RPC.
- **Variáveis:** o guia usa as reais (`WA_GATEWAY=rpc` + `WA_RPC_PROFILE=ai-manager`) e aponta que o AI-MANAGER-MAP §13.6 diz `WA_GATEWAY=ai-manager`. Também avisa que `REDIS_URL` precisa ser o mesmo db do ai-manager (padrão dele 0, do CRM 1).
- **Pendências para outras tarefas:**
  - ~~(T46/T29) boot sem detecção~~: resolvido na rodada 2 (ver abaixo).
  - (T40, as duas pontas) falta `sessions.setProxy`.
  - (T29) falta `meta.capabilities`.
  - Sem alvo no ai-manager e fora de A1–A8: `markRead`, `profile.*`, `react`, `deleteForEveryone`.
  - (T29, T14/T20) contexto citado no guia: reconciliação de `processing` após crash e `quoted`/`viewOnce`.
  - (T46, flaky) `contract.db.unit.test.ts` "subscribe recebe os eventos…" usa prazo de 10 s e oscilou uma vez sob carga.
- Sem migration nova. Nada a ligar no boot de produção além da pendência acima.

## Rodada 2 — boot com o perfil ai-manager

- **`createLazyAiManagerGateway(opts)`** (`profiles/ai-manager/detect.ts`):
  - a montagem é síncrona e começa com uma cópia mutável do perfil `ai-manager`;
  - a sonda roda uma vez, na 1ª chamada de um método aditivo (send, sendGroup, downloadMedia, presence, listContacts, recordConsent, optOut), e remove as rotas ausentes;
  - depois disso o método ausente falha com `CapabilityNotSupportedError` (`remote: false`) sem rede;
  - sessões, cancel e grupos não esperam a sonda;
  - se a sonda falha (worker fora, token recusado), o erro propaga e a próxima chamada sonda de novo;
  - `capabilityReport()` devolve o relatório.
- **`config.ts`:** `createWaGatewayFromEnv` continua síncrono, com a mesma assinatura usada por `apps/api/src/production.ts` e `apps/worker/src/boot/production-worker.ts`. O perfil `crm` não mudou.
- **Testes** (`profiles/ai-manager/env.unit.test.ts`, os dois perfis):
  - `crm`: `send` vai direto a `messages.enqueue`, sem sonda e sem `capabilityReport`;
  - `ai-manager`: nenhuma chamada de rede ao montar; `sessions.list` sem sonda; na 1ª chamada aditiva, 7 sondas e nunca `messages.enqueue`; as chamadas seguintes não usam a rede; com os aditivos simulados, o `send` funciona; a sonda que falha é refeita.
- **Ajuste no meu `profile.unit.test.ts`:** o `gatewayProfile` agora é uma cópia do perfil (`toEqual`, não `toBe`).
- **Guia:** `docs/extension/ai-manager.md` §3 descreve a detecção preguiçosa.
- **Verify:** 0 (`node spec/verify/verify.mjs T98 --role operario --base 965cd9b`). typecheck, lint e test de wa-port e wa-gateway-rpc ok, todas as regras F-* ok, escopo de 24 arquivos ok.
