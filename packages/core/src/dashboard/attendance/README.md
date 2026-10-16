# KPIs do dashboard de atendimento (T65)

As fórmulas abaixo seguem o 02 §3.3 e os itens 15, 19 e 37–42 do 02 §5. O cálculo puro fica em `calc.ts` e a consulta em `service.ts`. A rota é `GET /api/dashboard/attendance` e exige `dashboard.support`.

## Período, fuso e cache

O padrão é o mesmo da T55 (veja `docs/kpis.md`):

- `start_date` e `end_date` usam o formato `YYYY-MM-DD` e são inclusivos, no fuso da empresa (`companies.time_zone`). Sem as datas, vale o dia de hoje.
- O atendimento é limitado a **92 dias**. Um intervalo maior, `end < start` ou uma data inválida devolvem 422 (`details.fields[].path`).
- O filtro `connection_ids` age sobre `chats.connection_id`.
- O período anterior tem a mesma quantidade de dias e termina no dia anterior ao início. Ele sai em modo resumo: só os 5 KPIs (`previous`) e as tendências (`trends`), calculadas com a mesma regra da T55.
- A granularidade é `hour` (24 buckets `YYYY-MM-DDTHH:00`) quando o período tem 1 dia, e `day` (um bucket `YYYY-MM-DD` por dia) nos demais casos. Os buckets vazios aparecem com zero.
- O bloco fica no cache do Redis por 5 minutos. A chave combina empresa, datas, fuso e conexões. `force_refresh=1` recalcula. A resposta traz `cached` e `computed_at`.

## Base

A base é o conjunto de chats com `opened_at` em `[início 00:00, fim + 1 dia 00:00)` no fuso, mais o filtro de conexão. Cada chat conta uma vez.

A **resposta humana** de um chat é a primeira `crm.messages` dele com `sender_type = 'user'` e `coalesce(sent_at, created_at) ≥ opened_at`. Mensagens de bot, agente de IA, fluxo e sistema não contam (AC-T65-02).

## Fórmulas

| KPI | Fórmula |
|---|---|
| `new_leads` | quantidade de chats da base |
| `attended_leads` | chats da base com resposta humana |
| `unanswered_chats` | `new_leads − attended_leads`. Tendência invertida: subir é ruim |
| `resolved_leads` | chats da base com `status = 'resolved'` |
| `response_time_seconds` | `round(média(resposta humana − opened_at))` só dos atendidos; `null` se não houver nenhum. Tendência invertida |
| `first_reply_since` | data (no fuso) da primeira mensagem `sender_type = 'user'` da empresa, considerando todo o histórico; `null` se não houver nenhuma |

## Detalhes

As somas batem porque todos os detalhes saem da mesma base (AC-T65-04).

- **`attendance_over_time[{bucket_start, count}]`:** chats por bucket de abertura. Σ `count` = `new_leads`.
- **`response_time_over_time[{bucket_start, average_seconds, count}]`:** média por bucket dos atendidos; `null` quando o bucket não tem atendido.
- **`attendance_by_weekday_hour[{weekday, hour, count}]`:** as 168 células do mapa de calor, com `weekday` 0 (domingo) a 6 e `hour` de 0 a 23, no fuso. Σ = `new_leads`.
  - `peak` é a maior célula; em empate, vence o menor `weekday` e depois a menor hora. Sem chats, `peak` é `null`.
  - `peaks` traz todas as células empatadas no máximo.
- **`leads_by_status_chart[{connection_id, connection_name, new_leads, attended_leads, resolved_leads}]`:** os mesmos KPIs por conexão. Só aparecem conexões com chats na base. A soma de cada coluna dá o total correspondente.
- **`leads_by_user[{user_id, user_name, answered_chats, attending_chats, resolved_chats, average_response_seconds}]`:**
  - `answered_chats` são os chats da base em que o usuário escreveu a resposta humana; `average_response_seconds` é a média deles. Σ `answered_chats` = `attended_leads`.
  - `attending_chats` e `resolved_chats` são os chats da base atribuídos a ele **agora** (`assigned_user_id`), com status `attending` ou `resolved`.
  - Aparecem só usuários com alguma contagem > 0, ordenados por nome. Um autor removido aparece com `user_id = null` e o nome "Usuário removido".
- **`attendance_by_department[{department_id, department_name, color, chat_count}]`:** chats por departamento; `null` significa "Sem departamento" (`color` `null`). Σ `chat_count` = `new_leads`.
