# 00 — Índice de features (clone Leona)

Gerado em 2026-10-15 pelo scout de features. Toda a coleta foi somente leitura (ver "Incidentes" abaixo).

## Fontes
- **REA** (`rea-agents` 6.5.0, `analyze-javascript-application`) sobre o bundle público `_bundle/index.js`.
  - Resultado completo: `_rea/bundle-analysis.json`.
  - Resumo com 371 endpoints, rotas e storage: `_rea/rea-endpoints.md`.
  - Nos specs, o que veio do REA está marcado "(fonte: REA)".
  - O REA só registra caminhos literais. Endpoints com id no caminho (`/x/${id}/y`) vieram do grep.
  - `analyze-web-bundle` não roda sobre pasta local: exige endpoint CDP. `recover-javascript-sources` exige o Wakaru, que não está instalado.
- **grep** sobre o bundle formatado (`_bundle/pretty.js`), citado como `pretty.js:N`.
- **Passada ao vivo no portal**, só navegação e leitura, registrada na seção "Observado no app (portal)" de cada spec. Nenhum dado real de cliente foi copiado.

## Convenções
- **[INFERIDO]**: deduzido do código, sem confirmação visual.
- **[NÃO VERIFICADO]**: não confirmado.
- **[REQUER WABA]**: depende da API oficial do WhatsApp Business (Cloud API). O clone usa só Baileys, então esses itens ficam fora ou ganham um equivalente.
- **[INSTÁVEL NO BAILEYS]**: existe nos dois mundos, mas no Baileys é instável ou diferente.
- Cada spec com essas marcas tem a seção `## Compatibilidade Baileys (clone)`, com o equivalente sugerido.

## Módulos

| # | Módulo | Arquivo | Features (aprox.) | Portal |
|---|---|---|---|---|
| 01 | Autenticação, perfil, multiempresa (troca de conta), convites | [01-auth-conta-multiempresa.md](01-auth-conta-multiempresa.md) | 38 | ✅ parcial |
| 02 | Dashboard (abas Vendas e Atendimento, filtros, despesas, vendas, NF) | [02-dashboard.md](02-dashboard.md) | 42 | ✅ |
| 03 | Chats ao vivo (etapas, filtros, agendamento, painel, transferência, notas, etiquetas) | [03-chats.md](03-chats.md) | 62 | ✅ |
| 04 | Kanban / CRMs | [04-kanban-crm.md](04-kanban-crm.md) | 30 | ✅ (conta sem quadros) |
| 05 | Contatos (CSV, importar do WhatsApp, filtros, campos) | [05-contatos.md](05-contatos.md) | 38 | ✅ |
| 06 | Fluxos (builder: 27 tipos de nó, 37 tipos de ação, pastas, import/export, gatilhos) | [06-fluxos.md](06-fluxos.md) | 140 | ✅ lista |
| 07 | Agentes de IA (vozes, modelos, criar com IA, ferramentas) e Leona AI | [07-agentes-ia.md](07-agentes-ia.md) | 55 | ✅ lista |
| 08 | Conexões (uazapi, Meta Cloud, QR, status, proxy, slots) | [08-conexoes.md](08-conexoes.md) | 45 | ✅ |
| 09 | Webhooks de entrada e credenciais MCP | [09-webhooks-entrada.md](09-webhooks-entrada.md) | 35 | ✅ |
| 10 | Disparos em massa (cota, janela, intervalos) | [10-disparos-em-massa.md](10-disparos-em-massa.md) | 25 | ✅ |
| 11 | Facebook Ads (gerenciador, Pixel/CAPI, perfis e contas, atribuição, UTMify) | [11-facebook-ads.md](11-facebook-ads.md) | 48 | ✅ |
| 12 | Cobranças, assinatura por instância, faturas, reembolsos, tokens Leona | [12-cobrancas-assinaturas-tokens.md](12-cobrancas-assinaturas-tokens.md) | 62 | ✅ |
| 13 | Programa de afiliação (link externo e captura `?ref=`) | [13-afiliacao.md](13-afiliacao.md) | ~10 | ✅ |
| 14 | Notificações (sino, navegador, sons, anúncios, banners) | [14-notificacoes.md](14-notificacoes.md) | 15 | ✅ |
| 15 | Trilha do Predador (gamificação por faturamento) | [15-trilha-do-predador.md](15-trilha-do-predador.md) | ~12 | ✅ |
| 16 | Configurações: hub, Empresa (Dados Corporativos, Departamentos, Horários), Equipe e permissões, Convites, Acesso de suporte, Uso da Leona AI | [16-configuracoes-empresa-equipe.md](16-configuracoes-empresa-equipe.md) | 46 | ✅ |
| 17 | Configurações: Respostas Rápidas, Templates WhatsApp, Variáveis Globais, Campos Personalizados, Etiquetas, Fluxos Padrões, Traduções de fluxo | [17-configuracoes-conteudo.md](17-configuracoes-conteudo.md) | 55 | ✅ |
| 18 | Shell e navegação (sidebar, mobile, redirects, guardas, atalhos), Tutoriais, widget de Suporte | [18-shell-navegacao-tutoriais-suporte.md](18-shell-navegacao-tutoriais-suporte.md) | 38 | ✅ |
| 19 | Integrações (gateways de pagamento, emissores de NF, produtos, UTM, MCP) | [19-integracoes.md](19-integracoes.md) | 48 | ✅ |
| 20 | Admin interno (backoffice da plataforma) | [20-admin-interno.md](20-admin-interno.md) | 45 | ❌ sem acesso (papel de cliente) |
| 21 | Realtime (9 canais ActionCable) e plataforma (HTTP, i18n, tema, telemetria) | [21-realtime-e-plataforma.md](21-realtime-e-plataforma.md) | 14 | n/a |

**Total aproximado: ~903 features em 21 specs.** Marcas: ~110 [REQUER WABA] e ~32 [INSTÁVEL NO BAILEYS], contando as tabelas de compatibilidade.

## O que o clone (só Baileys) NÃO terá sem WABA
1. Conexão pela API Oficial (`meta_cloud`): Embedded Signup, coexistência, registro com PIN, IDs de WABA e número.
2. Gestão de Templates WhatsApp (HSM): criação, categorias, aprovação, status e nota de qualidade.
3. Envio de template no chat, nos nós de fluxo e como 1ª mensagem de disparo em massa. Também as ramificações por resultado do template: botão, timeout, falha de entrega.
4. Janela de 24 h (condição `message_window`). No clone, a janela fica sempre aberta.
5. Card PIX oficial (ORDER_DETAILS), botão "copiar código" e templates de autenticação com OTP.
6. Status `restricted` e alertas de qualidade vindos da Meta, além dos webhooks oficiais da Meta.
7. Referral oficial do Click-to-WhatsApp. No Baileys vem só parcial, via `externalAdReply`.

Equivalentes sugeridos:
- template → mensagem livre ou resposta rápida;
- lista e botões → menu numerado em texto;
- carrossel → imagens com legenda;
- PIX → copia-e-cola em texto + QR em imagem.

## Lacunas principais (detalhe na seção "Lacunas" de cada spec)
1. **Regras que ficam no backend:** motor de execução dos fluxos (ordem, concorrência, pausa), fórmulas dos KPIs (ticket, conversão, lucro, rateio de despesas), horário de atendimento, prompts de sistema dos agentes de IA, preços e pacotes de tokens, payload enviado à CAPI da Meta.
2. **Funcionalidades só em texto ou placeholder** ("Será implementado"/"em breve"), confirmadas ao vivo:
   - contadores "ativos" e "leads" em Contatos;
   - CRUD de Etiquetas;
   - conta de anúncios no Pixel;
   - automações de coluna no Kanban;
   - consumo mensal dos webhooks.
3. **Payloads parciais:** `panel_context`, `NotificationChannel`, `content` de mensagens ricas, resposta de `structure_bundle`, retorno das execuções de fluxo.
4. **Permissões:** a lista real de `/account_permissions/definitions` por papel não foi confirmada. Kanban e Contatos não escondem botões por permissão; a validação parece ficar no backend [INFERIDO].
5. **Sem acesso nesta conta:** `/admin`, o interior do editor de fluxos e os modais de criação de agente de IA e de pixel. Estes não foram abertos, porque podem criar registros ou consumir tokens.

## Incidentes durante a coleta (conta de produção)
- **Fluxo criado sem querer.** O clique em "Novo fluxo" **criou um fluxo** vazio na hora ("Novo Fluxo 1", id 152588, status ATIVO, 1 bloco). Não há modal de confirmação: o comportamento está documentado no 06. O incidente foi reportado ao usuário. O fluxo **não foi excluído nem pausado**, porque isso aguarda decisão do usuário.
- **`evaluate` usado para clicar.** Um `evaluate` foi usado uma vez para clicar no botão que abre o modal "Nova venda", contra a regra de usar `evaluate` só para leitura. Nada foi salvo.
- **Modal de proxy aberto por engano.** Um clique de espiar abriu por engano o modal "Configuração de Proxy" de uma conexão. Foi fechado sem salvar e o estado foi conferido como inalterado.
