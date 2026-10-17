# Meta: Pixel, Conversions API e rastreamento de conversões

Revisão 3 da SPEC (2026-10-17, "paridade de rastreamento com o Leona"). Este documento cobre a configuração, a validação no "Testar eventos" da Meta, as regras de envio, a comparação com o Leona e o que ainda depende de teste com conta real.

## Documentação oficial consultada (2026-10-17)

| Assunto | URL |
|---|---|
| Parâmetros do evento (`event_time` até 7 dias, `action_source`, `event_id`) | https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/server-event |
| Dados do cliente (normalização e hash de `em`, `ph`, `fn`, `ln`, `ct`, `st`, `zp`, `country`, `external_id`; o que não é hasheado) | https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters |
| `fbc` e `fbp` (formato `fb.1.<ms>.<fbclid>`, caixa do fbclid preservada) | https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/fbp-and-fbc |
| Conversions API for Business Messaging (onboarding, campos por canal, eventos suportados) | https://developers.facebook.com/docs/marketing-api/conversions-api/business-messaging |
| Envio, `test_event_code`, lote recusado inteiro se um evento for inválido | https://developers.facebook.com/docs/marketing-api/conversions-api/using-the-api |
| Resposta (`events_received`, `messages`, `fbtrace_id`) | https://developers.facebook.com/docs/marketing-api/reference/ads-pixel/events/ |
| Códigos de erro da Graph (parâmetro, permissão, limite, serviço) | https://developers.facebook.com/docs/graph-api/guides/error-handling |

O que a doc diz e decidiu o código:

- `event_time`: "can be up to 7 days before you send an event"; com um evento mais velho, a Meta recusa o lote inteiro. O CRM não envia esse evento: grava `discarded` com o motivo e nunca reenvia.
- `test_event_code`: vai no nível do corpo, ao lado de `data`. Os eventos de teste aparecem em Gerenciador de Eventos → pixel → Testar eventos.
- `country`: ISO 3166-1 alfa-2 minúsculo, hasheado, "include it even if all your data is from one country". O CRM tira o país do DDI do telefone (`libphonenumber-js` + tabela de DDIs: 55→br, 1→us, 351→pt…), senão usa o país padrão do pixel, senão `br`.
- `fn`/`ln`/`ct`/`st`: minúsculas e sem pontuação (o CRM também tira acentos; a doc recomenda a–z). `ct` e `st` sem espaços. `st` nos EUA é a sigla de 2 letras; no Brasil o CRM converte o nome do estado na UF ("São Paulo" → `sp`). `zp` sem espaço nem hífen (EUA: 5 dígitos). `ph` só dígitos, com DDI e sem zeros à esquerda.
- Business Messaging para WhatsApp: `action_source: business_messaging`, `messaging_channel: whatsapp` e `user_data` com `whatsapp_business_account_id` + `ctwa_clid`. A lista de eventos suportados traz `Purchase`, `LeadSubmitted`, `InitiateCheckout`, `AddToCart`, `ViewContent`, `QualifiedLead` e outros, mas não `Lead`. Por isso, nesse modo, Lead vai como `LeadSubmitted`. Os demais eventos do CRM (CompleteRegistration, Contact, Schedule, Subscribe) não estão na lista e vão sempre no modo padrão.
- A doc de WhatsApp exige WABA, as permissões `whatsapp_business_management` e `whatsapp_business_manage_events` e um dataset criado no WABA. `page_id` só aparece no exemplo de Messenger.

## Como configurar

Facebook → Pixel → Novo Pixel:

1. **Pixel ID** (só números) e **Access Token** da Conversions API (Gerenciador de Eventos → pixel → Configurações → Gerar token de acesso). O token fica cifrado no banco e nunca sai mascarado na listagem.
2. **Enviar vendas aprovadas automaticamente**: cada venda aprovada gera um `Purchase` (`event_id = sale-<id>`, `action_source: system_generated`).
3. **Lead automático na 1ª mensagem vinda de anúncio**: um `Lead` por contato (`event_id = ad-lead-<contato>`) quando a 1ª mensagem chega de um anúncio de clique para WhatsApp ou de um link rastreável com código.
4. **País padrão**: usado quando o DDI do telefone não identifica o país.
5. **Mensagem de anúncio (opcional)**:
   - **ID da conta do WhatsApp Business (WABA)**: o identificador que a doc pede. Use quando houver número oficial.
   - **ID da Página do Facebook**: o campo `page_id` do editor de pixel do Leona. A ajuda segue a dele ("não é necessária para a API oficial (WhatsApp Cloud); em conexões não oficiais pode ser exigida para eventos via WhatsApp").
   - O nó Pixel do fluxo também tem `page_id` e WABA id opcionais. Aceitam variável e sobrepõem os do pixel naquele evento, como no Leona.
6. **Código de teste (test_event_code)**: copie em Gerenciador de Eventos → pixel → Testar eventos. Com o código preenchido, todos os eventos daquele pixel vão para "Testar eventos", inclusive em produção. A tela mostra um aviso amarelo enquanto ele estiver ligado. O `META_CAPI_TEST_EVENT_CODE` do env continua valendo só fora de produção.

No fluxo, o nó **Pixel** envia Compra, Lead, InitiateCheckout, AddToCart, CompleteRegistration, Contact, Schedule ou Subscribe. Compra exige valor; nos outros, valor e moeda são opcionais. Valor e moeda aceitam variáveis (`{preco}`), e moeda vazia ou inválida vira BRL. As variáveis do anúncio de origem (`{ctwa_clid}`, `{source_url}`, `{source_id}`, `{media_url}`, `{thumbnail_url}`) estão no seletor de variáveis, no grupo "Anúncio de origem".

## Modos de envio

| Situação | Envio |
|---|---|
| Contato com atribuição `confirmed_native` (o cartão do anúncio trouxe `ctwa_clid`), pixel/nó com WABA id ou `page_id` e evento suportado | `business_messaging` + `messaging_channel: whatsapp` + `user_data { whatsapp_business_account_id \| page_id, ctwa_clid }` |
| Meta rejeita explicitamente o business_messaging (4xx com código de parâmetro 100 ou de permissão 3, 10 ou 200–299) | O MESMO evento (mesmo `event_id` e `event_time`) vai uma vez como `chat`. O log guarda a rejeição (motivo e `fbtrace_id`), e o pixel fica com `bm_status = rejected` e só testa business_messaging de novo depois de 24 h |
| Timeout, rede, 5xx ou códigos 1/2 (serviço) | `uncertain`: a Meta pode ter recebido. O modo NÃO troca. A fila `meta-capi` retenta o mesmo payload (mesmo modo, `event_id` e `event_time`) com backoff de 30 s, 60 s, 120 s… em até 5 tentativas |
| 429 ou códigos de limite (4, 17, 32, 341, 613, 80004) | `failed` retentável, no mesmo modo |
| Token inválido (102/190) e demais rejeições | `failed`, sem fallback (o outro modo falharia igual) |
| Sem ctwa_clid nativo, sem WABA/Página ou evento fora da lista | Modo padrão: `chat` (conversa) ou `system_generated` (venda) com `user_data` hasheado |
| `event_time` com mais de 7 dias | Não envia; fica `discarded` com o motivo |

O dedupe é do CRM: um `(pixel, event_id)` aceito nunca é reenviado. A doc de Business Messaging diz que a Meta não deduplica esses eventos.

## Atribuição: níveis de confiança

A atribuição de cada contato e de cada venda guarda `confidence` + `method`, nesta ordem de prioridade:

| Nível | Quando | O que libera |
|---|---|---|
| `confirmed_native` | A mensagem trouxe os metadados do anúncio (`ctwa_clid`/`source_id` do cartão) | `ctwa_clid`/`page_id`/WABA na CAPI (business_messaging); ROAS por anúncio |
| `confirmed_link` | Link rastreável com código, e o código veio na 1ª mensagem | `fbc`/`fbp`/IP/user agent do clique na CAPI; ROAS (com `ad_id` no link) |
| `probable` | Só proximidade de tempo (link sem código, opção ligada, um único clique na janela) | Nada de identificador de clique na CAPI; ROAS só separado, com filtro explícito |
| `none` | Sem evidência | Venda registrada normalmente, sem anúncio |

- Uma evidência melhor que chegue depois substitui a pior. O histórico fica em `contact_attribution.confidence_history`.
- "Origem indicada pelo anúncio" não quer dizer que o anúncio causou a venda. O `source_id` não prova causalidade. A UI usa esse rótulo, nunca "causa".
- "Aceito pela CAPI" (`events_received`) quer dizer que a Meta recebeu o evento. Não quer dizer que a Meta atribuiu a conversão a um anúncio: quem decide a atribuição é a Meta, com as regras e janelas dela.
- No Gerenciador (colunas <APP>/Meta), compras e receita do CRM contam só vendas confirmadas. As prováveis vêm separadas (`purchases_leona_probable`, `purchase_value_leona_probable(_display)`) e só entram no número com o filtro "Incluir vendas de atribuição provável" ligado, sempre com legenda.
- Dados do contato (`ph`, `em`, nome, cidade, UF, CEP, país, `external_id`) valem para qualquer evento, em qualquer nível.

## Links rastreáveis (opcional)

Recurso opcional para anúncios com destino site ou link. **Anúncio de clique para WhatsApp não passa por link nenhum**: ali a origem vem do cartão do anúncio na própria mensagem, e o rastreamento principal (ctwa_clid + business_messaging com fallback) não depende de link. Sem link criado, nada desse recurso roda.

- Facebook → Links rastreáveis → Novo link: nome, endereço (`slug`), conexão ou número, mensagem pronta, UTMs padrão e o modo do código.
- Endereço público: `https://<domínio do CRM>/api/w/<slug>`. A API responde **302 direto** para `https://wa.me/<número>?text=<mensagem>`, sem página intermediária e sem tela de carregamento. Página antes do WhatsApp só existe se o anunciante usar a própria landing page e apontar o botão para o link.
- No clique, o CRM grava `fbclid` → `fbc` (`fb.1.<ms do clique>.<fbclid>`), `fbp` (se vier na query como `fbp`/`_fbp`), `fbc` pronto (se a landing repassar o cookie), `utm_*`, `ad_id` (use `ad_id={{ad.id}}` nos parâmetros de URL do anúncio), IP, user agent e hora.
- Código na mensagem (por link):
  - `visible` (padrão): " (ref ABC234)" no fim;
  - `discreet`: o mesmo código em caracteres invisíveis (zero-width) no fim;
  - `off`: sem código.
- Com código, a 1ª mensagem que traz o código liga o clique ao contato como `confirmed_link`. O texto gravado no chat (e lido por fluxos e agentes) fica sem o código.
- Sem código, o clique é contado. Se a opção "provável" estiver ligada (desligada por padrão), o 1º contato NOVO da conexão dentro da janela (padrão 10 min, configurável) é ligado como `probable`. Com mais de um clique candidato na janela, nada é atribuído.
- Segurança: slug desconhecido ou inativo → 404 genérico (nada da empresa vaza). Rate limit de 60 cliques por minuto por IP. Respostas `no-store`, `no-referrer` e `noindex`.
- A tela mostra cliques, conversas confirmadas, prováveis (separadas) e vendas.
- Se quiser o endereço curto `/w/<slug>`, configure no proxy um redirecionamento de `/w/` para `/api/w/`. Isso não foi feito aqui: é configuração de servidor.

## Diagnóstico: Eventos enviados

Facebook → Eventos enviados (ou "Ver eventos" na linha do pixel). Para cada evento a tela mostra:

- status: aceito pela CAPI (`events_received`), rejeitado (motivo e `fbtrace_id`), incerto (em retentativa) ou descartado (motivo);
- modo usado (`business_messaging`, `chat`, `system_generated`) e se houve fallback;
- só os NOMES dos identificadores enviados (`ph`, `em`, `fbc`, `ctwa_clid`…), nunca os valores;
- uma pontuação de correspondência estimada pelo CRM: quantos identificadores fortes foram (`em`, `ph`, `external_id`, `fbc`, `fbp`, `ctwa_clid` e o par IP + user agent; 0 a 7). Não é a "Qualidade da correspondência" da Meta.

Há filtros por status, modo, evento e origem, com paginação. API: `GET /api/meta/pixels/:id/events?status=&mode=&event_name=&source=&page=&limit=`.

## Como validar no "Testar eventos" da Meta

1. No Gerenciador de Eventos, abra o pixel → **Testar eventos** → copie o código (ex.: `TEST12345`).
2. No CRM, edite o pixel e cole o código em **Código de teste**. O aviso amarelo confirma que o modo teste está ligado.
3. Gere um evento: rode um fluxo com o nó Pixel, registre uma venda aprovada (com envio automático) ou mande a 1ª mensagem de um anúncio (com Lead automático).
4. Em até alguns minutos o evento aparece em "Testar eventos", com o `event_id` do CRM. Compare com Facebook → Eventos enviados: o status deve ser "Aceito pela CAPI" e `events_received: 1`.
5. Com WABA/Página configurados e um contato vindo de anúncio de clique para WhatsApp, confira se o evento chegou como business_messaging ou se houve fallback para conversa (coluna Modo).
6. Remova o código de teste ao terminar. Com ele, nenhum evento daquele pixel conta como produção.

## Comparação com o Leona

| Recurso | Leona (pesquisa 11-facebook-ads.md) | Este CRM |
|---|---|---|
| Pixel com `pixel_id` + token CAPI, token mascarado | Sim | Sim (token cifrado) |
| Campo `page_id` no pixel e no nó | Sim (opcional) | Sim, mais o WABA id (o que a doc pede) |
| Eventos do nó Pixel | Compra e Lead | Compra, Lead, InitiateCheckout, AddToCart, CompleteRegistration, Contact, Schedule, Subscribe |
| Valor/moeda por variável, BRL padrão | Sim | Sim |
| Variáveis de anúncio no fluxo (`ctwa_clid`, `source_url`, `source_id`, `media_url`, `thumbnail_url`) | Sim | Sim |
| Venda herda `source_id` do contato (ROAS por anúncio) | Sim | Sim, com o nível de confiança |
| business_messaging com `ctwa_clid` | Indicado pela ajuda do `page_id`; payload real não verificado | Sim, campos da doc, Lead → LeadSubmitted |
| Fallback quando a Meta recusa | Não verificado | Rejeição explícita → mesmo evento como chat; incerto → retenta o mesmo modo |
| `country`/`st`/`zp`, normalização sem pontuação | Não verificado | Sim |
| Eventos com mais de 7 dias | Não verificado | Descartados com motivo |
| Código de teste por pixel | Não | Sim, com aviso visível |
| Lead automático na 1ª mensagem de anúncio | Não | Sim (opcional, 1 por contato) |
| Histórico/diagnóstico de eventos enviados | Não ("Não há tela de histórico de eventos") | Sim (status, modo, identificadores, pontuação) |
| Links rastreáveis com fbc/fbp/UTM | Não | Sim (opcional) |
| Níveis de confiança da atribuição | Não | Nativo > link > provável > nenhum; prováveis fora do ROAS por padrão |

## O que depende de teste com conta real

Nada aqui foi enviado para a Meta de verdade: todos os testes usam o `FakeMetaGraph` do repositório.

- **`page_id` sem WABA (modo do Leona):** a doc oficial atual de Business Messaging NÃO confirma `page_id` para WhatsApp. Ela pede `whatsapp_business_account_id`, e `page_id` só aparece para Messenger. O CRM envia `page_id` + `ctwa_clid` quando não há WABA, como o Leona sugere, e cai para `chat` se a Meta recusar. Se a Meta aceitar o evento mas não atribuir, só uma conta real mostra.
- **WABA + `ctwa_clid` de conexão não oficial (Baileys):** o `ctwa_clid` vem do `externalAdReply` da mensagem. A doc espera o do `referral` do webhook da Cloud API e um dataset criado no WABA com as permissões `whatsapp_business_manage_events`. Falta confirmar se a Meta aceita o clid vindo do Baileys.
- **Permissões e dataset:** se o token do pixel não for de um app com acesso à CAPI for Business Messaging, a Meta deve recusar (código 10/200) e o CRM cai para `chat`. A mensagem real de erro só aparece com conta real.
- **Código discreto (zero-width):** alguns aparelhos ou teclados podem remover caracteres invisíveis da mensagem pronta. Teste em Android e iPhone antes de usar.
- **Correspondência real:** a "Qualidade da correspondência" e a atribuição são da Meta. A pontuação do CRM é só uma estimativa.
- **Campo `partner_agent`:** a doc de Business Messaging recomenda `partner_agent` para parceiros. O CRM não envia (não há nome de parceiro atribuído pela Meta).
