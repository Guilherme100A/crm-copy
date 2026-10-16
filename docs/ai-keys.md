# Chaves de provedores de IA (BYOK, T38)

A empresa cadastra as próprias chaves em `/api/ai-keys`. Provedores: `anthropic`, `openai`, `google`, `openrouter`, `elevenlabs`, `groq`.
O segredo fica cifrado (AES-256-GCM, `CREDENTIALS_KEY`, AAD `ai-key/<companyId>/<id>`). A API nunca devolve o segredo nem o escreve em log: mostra só `configured: true` e a dica `…abcd`.

## Qual chave vale

- Quando a empresa tem várias chaves **ativas** do mesmo provedor, vale a de `updated_at` mais recente. Criar uma chave ou editá-la (nome, segredo, `active`) atualiza `updated_at`; o `POST /:id/test` não atualiza.
- A listagem marca com `in_use: true` a chave que está valendo para cada provedor (a UI da T59 mostra isso).
- Sem chave da empresa, vale a da plataforma, lida a cada chamada: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `OPENROUTER_API_KEY`, `ELEVENLABS_API_KEY`, `GROQ_API_KEY`.
- Sem nenhuma das duas, lança `ProviderNotConfiguredError` (`code: 'provider_not_configured'`).
- Os agentes (T39) guardam só `{ provider, model }` e usam a chave que está valendo para o provedor.
- Os blocos de IA dos fluxos apontam para uma chave específica (`ai_integration_id`) e a leem com `AiKeysService.credentialsForKey(companyId, keyId)`.
- Para excluir uma chave em uso, seja por agente (é a chave que vale para o provedor do agente) ou por bloco de fluxo, é preciso `?force=1`. Sem ele, a resposta é `409 CONFLICT` com `details.agents` e `details.flows`.

## API (`settings.integrations.*`)

| Método | Caminho | Permissão | Resposta |
|---|---|---|---|
| GET | `/api/ai-keys` | view | `{ items }` |
| POST | `/api/ai-keys` `{ provider, name, secret, active? }` | edit | `201 { key }` |
| GET | `/api/ai-keys/:id` | view | `{ key }` |
| PATCH/PUT | `/api/ai-keys/:id` `{ name?, secret?, active? }` (segredo vazio = manter; trocar `provider` = 422) | edit | `{ key }` |
| DELETE | `/api/ai-keys/:id[?force=1]` | delete | `{ ok: true }` ou 409 |
| POST | `/api/ai-keys/:id/test` | edit | `{ ok, latency_ms, error? }` (sempre 200; `error` sem a chave) |
| GET | `/api/ai-keys/:id/models` (só `openrouter`) | view | `{ items: [{ id: 'fornecedor/modelo', name, context_length }] }` |
| GET | `/api/ai-keys/:id/voices` (só `elevenlabs`) | view | `{ items: [{ id, name, category, preview_url }] }` |

As URLs base dos provedores podem ser trocadas por env (`<PROVEDOR>_API_URL`), por exemplo para apontar a servidores fake nos testes.

## Como montar os provedores por empresa (T46, T42)

Tudo vem de `@crm/core`:

```ts
import { AiKeysService, createCompanyLlmProvider, resolveTts, resolveStt } from '@crm/core'

const keys = new AiKeysService({ db })            // cipher padrão de CREDENTIALS_KEY; env = process.env
const llm = createCompanyLlmProvider({ keys })     // um LlmProvider para todas as empresas: a chave é resolvida a cada generate pelo tenantId
const tts = await resolveTts(companyId, { keys })  // ElevenLabsTts com a chave da empresa ou da plataforma
const stt = await resolveStt(companyId, { keys })  // GroqStt idem
```

- **API:** `aiKeysDefaults(deps)` (em `routes/ai-keys`) roda antes das rotas de agentes e põe `deps.aiKeys` e `deps.aiProviderKeys = deps.aiKeys`. A checagem "provedor configurado" da T39 passa a considerar a chave da empresa. Nos testes, injete `deps.aiKeyProbe` (teste da chave) e `deps.aiKeysFetch` (modelos e vozes).
- **Worker (T46):** no boot, com `AI_MODE=real`, monte `const keys = new AiKeysService({ db })` e chame `configureAiAgent({ ..., llm: createCompanyLlmProvider({ keys }) })`. A T68 recebe um único `tts`/`stt`, então envolva com um provider que resolve a chave por chamada, ou use a chave da plataforma enquanto o runtime não receber o `companyId` na voz. Com `AI_MODE=fake`, continue com `FakeLlm`/`FakeTts`/`FakeStt`.
- **Nós de IA dos fluxos (T42):** com `api_key_source: 'integration'`, use `keys.credentialsForKey(companyId, config.ai_integration_id)` e monte o modelo com `buildLanguageModel` (`@crm/ai`). Caso contrário, use o `llm` acima, que aplica a chave que vale para o provedor.
