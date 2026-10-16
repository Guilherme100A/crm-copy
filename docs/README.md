# Documentação técnica

Monorepo pnpm 9 (workspaces `apps/*` e `packages/*`), Node 22 LTS (`engines >= 22.12`), TypeScript strict, ESM.
A spec executável está em `spec/SPEC.md`; arquitetura e contratos globais na seção 3.

## Workspaces

| Caminho                   | Pacote                | Papel                                                  |
| ------------------------- | --------------------- | ------------------------------------------------------ |
| `apps/api`                | `@crm/api`            | API HTTP (Hono)                                        |
| `apps/worker`             | `@crm/worker`         | jobs BullMQ do CRM + consumidor do stream `wsm:events` |
| `apps/wa-worker`          | `@crm/wa-worker`      | dono dos sockets WhatsApp (wa-engine) + RPC interno    |
| `apps/web`                | `@crm/web`            | SPA React                                              |
| `packages/shared`         | `@crm/shared`         | contratos isomórficos (zod)                            |
| `packages/db`             | `@crm/db`             | Drizzle: schema, client, migrações                     |
| `packages/node-kit`       | `@crm/node-kit`       | logger, cripto, config, Redis/BullMQ, storage, e-mail  |
| `packages/wa-port`        | `@crm/wa-port`        | fronteira WhatsApp: `WaGateway`, `WaEvent v1`, fakes   |
| `packages/wa-engine`      | `@crm/wa-engine`      | transporte, sessão, fila, antiban, envio               |
| `packages/wa-gateway-rpc` | `@crm/wa-gateway-rpc` | `WaGateway` via RPC + stream                           |
| `packages/ai`             | `@crm/ai`             | portas LLM/TTS/STT, adapters, fakes                    |
| `packages/core`           | `@crm/core`           | domínio do CRM                                         |

## Comandos

```sh
pnpm install
pnpm -r build       # tsup (ESM) por pacote
pnpm -r typecheck   # tsc --noEmit
pnpm -r lint        # ESLint 10 (flat config da raiz)
pnpm -r test        # vitest run (*.unit.test.ts)
pnpm format         # prettier
```

Resolução entre pacotes: `exports` com condição `development` → `src/index.ts` (dev/teste sem build) e `default` → `dist/index.js`.

## Fronteiras de import (ESLint `no-restricted-imports`)

- Baileys (`@whiskeysockets/baileys`, `baileys-antiban`) só em `packages/wa-engine`.
- `@crm/wa-engine` nunca em `packages/core`, `packages/shared`, `apps/api`, `apps/worker`, `apps/web` (use `@crm/wa-port`).
- SDKs de IA (`ai`, `@ai-sdk/*`, `@anthropic-ai/sdk`, `openai`, `@google/genai`, `@elevenlabs/*`, `groq-sdk`) só nos adapters
  `packages/ai/src/{aisdk,elevenlabs,groq}/**`.

## Ambiente

Copie `.env.example` para `.env`. Infra local (Postgres 5432, Redis 6379 db 1): `spec/INFRA.md`.
O nome exibido do produto vem sempre de `APP_NAME`.
