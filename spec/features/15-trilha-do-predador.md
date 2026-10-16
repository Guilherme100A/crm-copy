# 15 — Trilha do Predador

> Fonte: bundle `_bundle/pretty.js` (análise estática, clean-room). Não é um sistema de missões/onboarding: é uma **gamificação por faturamento acumulado** da conta (selos/níveis), exibida no Dashboard (`/welcome`). O resgate de prêmios é feito em site **externo**.

## 1. Visão geral

- Recurso de reconhecimento ("selos de faturamento") para a conta/empresa ativa.
- O nível é calculado **no front-end** a partir do faturamento acumulado vitalício da conta (`lifetime_revenue`), comparado a uma tabela fixa de 6 níveis embutida no bundle (`pretty.js:83221-83288`).
- Exibido como:
  1. **Selo (ícone)** ao lado da saudação do dashboard e na linha "Operação: <empresa> • Selo <ícone> • N leads acumulados" (`pretty.js:86035-86090`).
  2. **Botão/pill** no cabeçalho do dashboard com ícone + nome do nível atual (ou "Trilha do Predador" se ainda sem selo) (`pretty.js:83847-83872`, uso em `86112`).
  3. **Modal "Trilha do Predador: a jornada de escala"** com resumo, progresso e lista de níveis (`pretty.js:83352-83840`, componente montado em `86119`).
- Não existem missões, tarefas, XP, pontos ou critérios além de faturamento. Não há onboarding gamificado no bundle (buscado: "predator", "predador", "trail", "trilha", "mission", "achievement", "conquista") — [NÃO VERIFICADO] se existe no backend algo além disso.

## 2. Telas e rotas

| Tela | Rota | Observação | Ref |
|---|---|---|---|
| Dashboard (home) | `/welcome` (fonte: REA, index.js:71:60847) | Contém selo, pill e modal | `pretty.js:86357` |
| Modal Trilha do Predador | (sem rota; estado local) | Abre ao clicar no selo ou na pill | `pretty.js:86037-86125` |
| Resgate de prêmios | URL externa `https://<dominio-cliente>/trilha?email=<email>&id=<account_id>` | Abre em nova aba (`target=_blank`, `noopener`) | `pretty.js:83212-83220`, `83371` |

O domínio externo é um site de "área do cliente" da empresa (mesmo domínio usado para a página externa de assinatura, `pretty.js:83199`). Na reimplementação, tornar a URL configurável.

## 3. Modelo de dados / campos

### 3.1 Nível (tabela estática no front)

| Campo | Tipo | Obrigatório | Descrição | Ref |
|---|---|---|---|---|
| `name` | string | sim | Nome do nível (exibido também como tooltip do selo) | `83222+` |
| `minRevenue` | number (BRL) | sim | Faturamento acumulado mínimo para conquistar | `83224+` |
| `color`, `badgeBg`, `badgeBorder`, `badgeText` | classes CSS | sim | Paleta própria por nível (claro/escuro) | `83225-83229` |
| `icon` | componente de ícone | sim | Ícone distinto por nível | `83230` |
| `description` | string | sim | Texto descritivo do nível (pt-BR fixo, não traduzido) | `83231` |

### 3.2 Níveis (ordem crescente; limiares em BRL)

| # | Nome | Faturamento mínimo | Cor-tema |
|---|---|---|---|
| 1 | Instinto em Ação | R$ 50.000 | âmbar |
| 2 | Novo Predador | R$ 100.000 | ardósia/cinza |
| 3 | Ritmo de Caça | R$ 250.000 | amarelo |
| 4 | Força Instintiva | R$ 500.000 | verde-azulado |
| 5 | Topo da Cadeia | R$ 1.000.000 | rosa |
| 6 | Lenda Viva | R$ 2.000.000 | ciano |

(Os nomes dos níveis são rótulos de UI; as descrições longas são texto de marketing — reescrever com texto próprio.)

### 3.3 Entrada: faturamento acumulado (`lifetime_revenue`)

Vem no payload de `GET /dashboard/bootstrap` (`pretty.js:85588`, consumo em `85749`). Aceita dois formatos (`pretty.js:83290-83316`):

| Formato | Campos | Regra de leitura |
|---|---|---|
| Objeto rico | `revenue_brl` (number), `revenue_display` (number), `revenue_by_currency` (mapa moeda→valor), `display_currency` (string, default "BRL") | Se moeda de exibição = BRL e há `revenue_brl` → usa-o; senão `revenue_display`; senão `revenue_brl`; senão cai no mapa por moeda |
| Mapa simples | `{ "BRL": 123.45, "USD": 10 }` | Chaves normalizadas p/ maiúsculas; se existe BRL usa BRL, senão **soma** todos os valores (sem conversão) |
| Ausente/nulo | — | 0 / sem selo |

Também existe o endpoint `GET /account/lifetime_revenue` no serviço de contas (`pretty.js:34687`), sem uso encontrado no front [INFERIDO: retorna o mesmo objeto].

### 3.4 Outros dados exibidos no modal

| Dado | Origem | Ref |
|---|---|---|
| Nome da operação ativa | `user.current_account.name` → `active_account.name` → fallback "sua empresa" | `85720-85724` |
| Leads acumulados | `user.current_account.welcome_leads_count` (ou `active_account`) | `85725-85727` |
| E-mail e id da conta (para link externo) | `user.email`, `user.current_account.id` ou `accounts[0].id` | `83200-83203`, `83371` |

## 4. Estados e transições

Cálculos (`pretty.js:83317-83350`):
- **Nível atual**: último nível cujo `minRevenue <= faturamento` (lista percorrida em ordem; para no primeiro não atingido). Nulo se < R$ 50.000.
- **Próximo nível**: primeiro com `faturamento < minRevenue`; nulo se ≥ R$ 2.000.000.
- **Progresso**: `(faturamento − limiar do nível atual) ÷ (limiar do próximo − limiar atual) × 100`, limitado a 0–100; limiar atual = 0 quando sem nível. Se não há próximo → 100% e "Nível máximo alcançado".
- **Restante**: `max(0, próximo.minRevenue − faturamento)`.

Estados de UI do modal:
| Estado | Exibição |
|---|---|
| Carregando bootstrap | skeletons pulsantes em faturamento, selo, próximo marco, % |
| Faturamento indisponível (sem permissão ou nulo) | "Será implementado" nos campos |
| Sem selo | "Nenhum selo ainda" |
| Com selo | pill com ícone + nome do nível |
| Nível máximo | "Nível máximo alcançado" em próximo marco e no texto de progresso |
| Por nível na lista | Conquistado (fundo colorido, ícone de check "Conquistado", link "Solicitar premiação") / Não conquistado (cinza, ícone de cadeado + valor que falta) |

Selo no cabeçalho só aparece se o usuário pode ver vendas **e** já tem nível (`pretty.js:83843-83845`, `86005`).

## 5. Ações e regras de negócio

1. Clicar no selo (ícone) ou na pill do cabeçalho → abre o modal.
2. Botão "Resgatar prêmios" (banner do modal) → abre site externo com `email` e `id` da conta em query string.
3. Em cada nível conquistado, link "Solicitar premiação" → mesma URL externa.
4. Valores formatados em BRL (`pt-BR`, sem centavos nos limiares; com centavos no faturamento e restante) (`pretty.js:83351`). Contagem de leads formatada no locale do i18n (pt-BR/en-US/es-ES).
5. Nenhuma ação grava dados na Leona; nada de solicitação de prêmio via API (chave i18n "Solicitação de premiação em breve." existe mas não é usada).
6. O faturamento só é carregado quando o usuário tem `canViewSalesDashboard`; caso contrário o modal mostra nome e leads, e faturamento como "Será implementado".

## 6. Endpoints da API

| Método | Caminho | Uso | Ref |
|---|---|---|---|
| GET | `/dashboard/bootstrap` (fonte: REA, index.js:71:46923) | Retorna, entre outros, `lifetime_revenue`, `subscription`, `products`, `connections`, `ad_accounts`, `banners`, `announcements`, `dashboard_filter_groups` | `85588-85593`, `85741-85749` |
| GET | `/account/lifetime_revenue` (fonte: REA, index.js:24:25399) | Faturamento vitalício (não usado pela UI atual) | `34687-34692` |

O bootstrap é recarregado ao trocar de conta ativa (`pretty.js:85760+`).

## 7. Eventos realtime

Nenhum. O nível não é atualizado em tempo real; só ao recarregar o bootstrap do dashboard.

## 8. Permissões

- Ver faturamento/selo: permissão `dashboard.sales` ("Vendas") — exposta como `canViewSalesDashboard` (`pretty.js:36264`, `36331`). Owner tem tudo.
- Acesso à página `/welcome`: `dashboard.sales` **ou** `dashboard.support` (`pretty.js:40908`).

## 9. Integrações externas

- Site externo de resgate de prêmios (área do cliente) recebendo `email` e `id` da conta via query string. Sem assinatura/token — [INFERIDO] o site externo valida por conta própria.

## 10. Lacunas

- [NÃO VERIFICADO] Como o backend calcula `lifetime_revenue` (quais vendas contam: aprovadas? líquido ou bruto? reembolsos descontados? moedas convertidas?).
- [NÃO VERIFICADO] Quais prêmios existem por nível e o fluxo no site externo.
- [INFERIDO] Níveis e limiares são fixos no front; não há endpoint de configuração.
- [NÃO VERIFICADO] Se "Leads acumulados" (`welcome_leads_count`) é total de contatos ou de chats.
- [INFERIDO] Moedas sem BRL são somadas sem câmbio (comportamento do front com mapa simples) — provável bug/limitação; na reimplementação converter para BRL no backend.

## Observado no app (portal)

Passada somente leitura em 2026-10-15. Modal aberto pelo botão "Trilha do Predador" no Dashboard.

- **Cabeçalho:** título e subtítulo ("conquistas operacionais e faturamento acumulado"), mais um texto de apresentação temático.
- **Cards:** "OPERAÇÃO ATIVA", "LEADS ACUMULADOS" e "FATURAMENTO ACUMULADO".
- **Selo e próximo marco:**
  - "Selo Atual de Faturamento", ou "Nenhum selo ainda".
  - "Próximo Marco" com o valor-alvo.
  - Barra "Progresso para o próximo selo" (%) e "Faltam R$ X para <nível>".
- **Lista de níveis:** 6 níveis com limiares de R$ 50 mil, 100 mil, 250 mil, 500 mil, 1 milhão e 2 milhões. Cada nível mostra quanto falta e tem uma descrição curta. Os nomes temáticos são da marca: a reimplementação deve usar nomes próprios.
- **"Resgatar prêmios":** abre um popup para um portal de clientes externo, em outro subdomínio. Fora do escopo do app.
