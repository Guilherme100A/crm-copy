# 13 — Afiliação (programa de parceiros)

> Fonte: bundle `_bundle/pretty.js` (análise estática, clean-room). **Não existe módulo de afiliação dentro do app**: não há telas de link de indicação, comissões, saques ou métricas. O app apenas (a) leva o usuário a um portal externo de parceiros e (b) captura o código de indicação no cadastro e o repassa ao backend, que integra com uma plataforma de afiliados de terceiros (Rewardful).

## 1. Visão geral

| Peça | Onde | Ref |
|---|---|---|
| Entrada "Programa de afiliação" no menu do usuário (cabeçalho) | link direto, nova aba | `pretty.js:45415`, `45556-45571` |
| Botão "Afiliação" no rodapé da sidebar (expandida e recolhida) | abre modal de confirmação → nova aba | `pretty.js:46126-46137`, `46099-46103` |
| Modal de confirmação | "Programa de afiliação" / "Você será levado para um site externo…" / Continuar / Cancelar | `pretty.js:46281-46293`, i18n `15096-15100` (pt), `15223-15228` (en), `15350-15354` (es) |
| Portal externo de parceiros | `https://<portal-parceiros>/register` | `pretty.js:45415`, `45918`, `46030` |
| Captura de indicação no cadastro | query `?ref=` ou `?via=` na página `/register` → campo `rewardful_referral` no `POST /auth/register` | `pretty.js:47780-47807`, rota `48068` |
| Script de rastreio de terceiros | `r.wdfl.co` (Rewardful `rw.js`) listado como recurso externo isento de verificação SRI | `pretty.js:242` |

## 2. Telas e rotas

| Tela | Rota | Ref |
|---|---|---|
| Cadastro (com captura de indicação) — rota `/register` (fonte: REA, index.js:24:304007) | `/register?ref=<codigo>` ou `/register?via=<codigo>` | `48068`, `47783` |
| Portal de parceiros (externo) | `https://<portal-parceiros>/register` | `45415` |

Nenhuma rota interna `/affiliate`, `/partners`, `/referrals` existe (buscado: affiliat, afiliad, referral, partner, parceiro, indica, commission, comiss, payout, saque, withdraw).

## 3. Modelo de dados / campos

### Cadastro (`POST /auth/register`) — campos relevantes (`pretty.js:47785-47807`)

| Campo | Tipo | Obrigatório | Validação | Ref |
|---|---|---|---|---|
| `user.name` | string | sim | — | `47799` |
| `user.email` | string | sim | — | `47800` |
| `user.personal_whatsapp` | string | não | omitido se vazio | `47801` |
| `user.password` | string | sim | mín. 6 caracteres | `47790-47793` |
| `user.password_confirmation` | string | sim | igual à senha ("As senhas não coincidem") | `47786-47789` |
| `user.role` | string fixa `"client"` | sim | — | `47804` |
| `rewardful_referral` | string (raiz do payload) | não | enviado só se `ref` ou `via` presente na URL | `47807` |

Prioridade: `ref` tem precedência sobre `via` (`w.get("ref") || w.get("via")`).

## 4. Estados e transições

- Modal de confirmação: fechado → aberto (clique em "Afiliação") → Continuar (abre nova aba e fecha) | Cancelar (fecha).
- No menu de usuário do cabeçalho não há modal: o link abre direto.
- Cadastro: sucesso → redireciona para `/login` com mensagem e e-mail pré-preenchido; erro → mostra lista de erros do backend.

## 5. Ações e regras de negócio

1. Qualquer usuário logado vê a entrada de afiliação (sem checagem de permissão).
2. Indicação é atribuída **no cadastro** via parâmetro de URL; o backend recebe `rewardful_referral` e [INFERIDO] registra a conversão na plataforma de afiliados (Rewardful usa o "referral id" para vincular o cliente ao afiliado e calcular comissão sobre as assinaturas Stripe).
3. O script `rw.js` de terceiros é carregado pelo `index.html` [INFERIDO — o HTML não está no bundle; o domínio aparece apenas na lista de exceções do SRI]. Ele grava cookie de visita do afiliado; o front lê só a query string.
4. Comissões, link de afiliado, saques e métricas ficam inteiramente no portal externo.

## 6. Endpoints da API

| Método | Caminho | Payload | Ref |
|---|---|---|---|
| POST | `/auth/register` (fonte: REA, index.js:24:21029 e index.js:24:298407 — duas chamadas) | `{ user: {name, email, personal_whatsapp?, password, password_confirmation, role:"client"}, rewardful_referral? }` | `47808` |

Nenhum endpoint de afiliados/comissões no front.

## 7. Eventos realtime

Nenhum.

## 8. Permissões

Nenhuma (visível a todos os usuários autenticados). Cadastro é público.

## 9. Integrações externas

- **Rewardful** (plataforma de afiliados SaaS, script em `r.wdfl.co`) — rastreio de cliques e atribuição de indicação; [INFERIDO] integrada ao Stripe para comissões recorrentes (o app usa Stripe como um dos tipos de assinatura — ver módulo 12).
- **Portal de parceiros** próprio (subdomínio "parceiros") — cadastro de afiliados, link, comissões, saques.

Sugestão de reimplementação: manter a mesma interface (query `ref`/`via` → campo opcional no cadastro) e plugar qualquer provedor de afiliados (Rewardful, FirstPromoter, interno).

## 10. Lacunas

- [NÃO VERIFICADO] Estrutura de comissões (percentual, recorrência, duração), regras de saque, métricas — nada disso está no app.
- [NÃO VERIFICADO] Se o backend também guarda o código de indicação no usuário/conta para relatórios internos.
- [INFERIDO] Carregamento do `rw.js` no `index.html` (não incluso no bundle analisado).
- [NÃO VERIFICADO] Se existe atribuição de indicação em fluxos de login social/convite (só o cadastro por e-mail lê `ref`/`via`).
- O filtro de contatos "Origem: Indicação" (`referral`, `pretty.js:155537`) é um valor de origem de contato do CRM, **não** relacionado ao programa de afiliados.

## Observado no app (portal)

Passada somente leitura em 2026-10-15. Nada foi salvo.

- O botão "Afiliação" no rodapé da sidebar abre o modal "Programa de afiliação", com o aviso de que o usuário será levado a um site externo e os botões Cancelar / Continuar. Confirma o bundle: não há tela interna de afiliação.
- O dashboard mostra um banner promocional, que pode ser fechado, com link para o portal externo de parceiros (`/register`).
