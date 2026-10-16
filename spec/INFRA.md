# INFRA — ambiente local de desenvolvimento e testes (leonas-crm)

> Atualizado em 2026-10-15. Máquina de desenvolvimento Windows. **Padrão: Postgres e Redis nativos, sem Docker.**
> O Docker Desktop está instalado (ver Histórico), mas o verify do CRM só usa Docker com `CRM_INFRA=docker`.

## Serviços

| Serviço | Onde | Conexão usada pelo CRM |
|---|---|---|
| PostgreSQL 16.4 (binários nativos) | `C:/Users/green/tools/pg` · dados em `C:/Users/green/tools/pgdata` | `postgres://wsm:wsm@127.0.0.1:5432/crm` |
| Redis 8.10 (build nativo) | `C:/Users/green/tools/redis` | `redis://127.0.0.1:6379/1` (**db 1**, para não colidir com o ai-manager no db 0) |

- O banco é **`crm`** (o ai-manager usa `wsm` no mesmo servidor). O usuário `wsm` é superusuário: os testes criam bancos descartáveis `crm_test_<rand>`.
- **Use `127.0.0.1`, não `localhost`:** no Windows o libpq tenta `::1` primeiro e perde ~2 s por conexão.
- `node spec/verify/infra-local.mjs` (idempotente) inicia o Postgres (`pg_ctl`) e o Redis se as portas 5432/6379 não responderem e cria o banco `crm` se faltar. Variáveis opcionais: `CRM_TOOLS`, `CRM_DB_NAME`, `PGPASSWORD` (padrão `wsm`).
- **Conflito de portas:** se o `docker compose` do ai-manager estiver de pé, ele ocupa 5432/6379. Nesse caso o `infra-local.mjs` não sobe os nativos e usa os containers (mesmas credenciais `wsm`), criando o banco `crm` neles. Não rode os dois ao mesmo tempo.
- Prefixos no Redis: `wsm:*` (wa-engine: filas `session:<id>`, stream `wsm:events`) e `crm:*` (jobs e realtime do CRM). Testes usam prefixo aleatório por suíte.

## Ferramentas

| Ferramenta | Uso | Observação |
|---|---|---|
| Node 22 LTS + pnpm 9.15.9 | todo o monorepo | vitest 5 exige Node ≥ 22.12 |
| Playwright 1.63 + Chromium | testes E2E (`*.e2e.ts`) | instalar uma vez: `pnpm exec playwright install chromium` |
| ffmpeg | conversão de áudio para PTT (Ogg/Opus) | **não** é usado nos testes (runner mockado); em dev, `FFMPEG_PATH` aponta para o executável |
| Disco | `STORAGE_DIR` (mídias) e worktrees das tarefas | o disco C: chegou a 0 bytes livres em 2026-10-15; confira o espaço livre antes de cada onda (cada worktree tem seu `node_modules`, com hardlinks do store do pnpm) |

## Variáveis para testes
O `spec/verify/verify.mjs` define estes padrões para os comandos que roda (sobrescrevíveis por env):
`DATABASE_URL=postgres://wsm:wsm@127.0.0.1:5432/crm`, `REDIS_URL=redis://127.0.0.1:6379/1`, `ANTIBAN_MODE=passthrough`, `WA_GATEWAY=fake`, `WA_TRANSPORT=fake`, `AI_MODE=fake`, `MAIL_TRANSPORT=memory`, `APP_NAME=CRM`, `VITEST_MAX_WORKERS=4`, `npm_config_workspace_concurrency=1`.

## Harness E2E
`node scripts/e2e/serve.mjs` (T17) sobe banco descartável migrado com seed, API com fakes (`E2E=1`) e web (`vite preview` com proxy `/api`). A config `tests/acceptance/playwright.config.ts` (T23) usa esse harness como `webServer`, com os projetos `desktop` (1366×768) e `mobile` (390×844).

## Histórico (herdado do ai-manager)
- 2026-09-24: Postgres e Redis nativos instalados em `C:/Users/green/tools`. Depois o humano instalou o Docker Desktop (engine 29.8, WSL2). No ai-manager, o verify passou a preferir o compose; no leonas-crm a decisão é usar os nativos por padrão.
- 2026-10-15: `infra-local.mjs` do CRM iniciou o Postgres nativo (porta 5432 estava livre) e criou o banco `crm`.
