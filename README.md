# Central IA CRM Backend Render

Backend Express da Central IA CRM para receber eventos do Z-PRO, salvar no Supabase e manter chaves sensiveis fora do frontend.

## Variaveis de ambiente

```env
APP_MODE=live
PORT=3000
SUPABASE_URL=https://SEU-PROJETO.supabase.co
SUPABASE_SERVICE_ROLE_KEY=COLE_SERVICE_ROLE_AQUI
OPENAI_API_KEY=COLE_OPENAI_KEY_AQUI
DEFAULT_OPENAI_MODEL=gpt-4o-mini
ADMIN_API_KEY=troque-essa-chave
```

Nunca coloque `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, token do Z-PRO ou `ADMIN_API_KEY` no frontend.

## Rodar local

No PowerShell:

```powershell
npm.cmd install
copy .env.example .env
npm.cmd run dev
```

Teste local:

```powershell
Invoke-RestMethod http://localhost:3000/health
```

## Render

Build Command:

```bash
npm install
```

Start Command:

```bash
npm start
```

Configure as variaveis de ambiente no painel do Render antes de publicar.

## Webhook Z-PRO

URL para configurar no Z-PRO:

```text
https://SEU-SERVICO.onrender.com/webhooks/zpro/WEBHOOK_PUBLIC_ID
```

`WEBHOOK_PUBLIC_ID` vem da coluna `crm_ai_integrations.webhook_public_id`.

## Diagnostico do webhook real

### 1. Verificar se o backend esta vivo

```powershell
Invoke-RestMethod https://SEU-SERVICO.onrender.com/health
```

### 2. Verificar se o webhook_public_id encontra integracao

```powershell
Invoke-RestMethod https://SEU-SERVICO.onrender.com/webhooks/zpro/WEBHOOK_PUBLIC_ID/ping
```

Resposta esperada:

```json
{
  "ok": true,
  "webhookPublicId": "WEBHOOK_PUBLIC_ID",
  "integrationFound": true,
  "integrationActive": true
}
```

Se `integrationFound` for `false`, a URL no Z-PRO esta usando um `webhook_public_id` que nao existe no Supabase.

Se `integrationActive` for `false`, a integracao existe mas esta inativa.

### 3. Listar integracoes sem expor token

Protegido por `ADMIN_API_KEY`:

```powershell
Invoke-RestMethod `
  -Uri https://SEU-SERVICO.onrender.com/api/debug/integrations `
  -Headers @{ "x-admin-api-key" = "SUA_ADMIN_API_KEY" }
```

Essa rota retorna configuracoes publicas da integracao, incluindo `webhook_public_id`, `active` e `has_token`. Ela nao retorna token.

### 4. Enviar webhook fake

```powershell
$payload = @{
  body = "Ola, quero saber mais"
  phone = "5511999999999"
  eventId = "teste-render-001"
  event = "message"
} | ConvertTo-Json

Invoke-RestMethod `
  -Uri https://SEU-SERVICO.onrender.com/webhooks/zpro/WEBHOOK_PUBLIC_ID `
  -Method Post `
  -ContentType "application/json" `
  -Body $payload
```

No Render, os logs agora mostram:

- metodo;
- rota;
- `webhookPublicId`;
- headers sem tokens;
- corpo recebido com campos sensiveis redigidos;
- resultado do processamento.

Eventos importantes nos logs:

- `zpro.webhook.received`
- `zpro.webhook.ping`
- `zpro.webhook.integration_found`
- `zpro.webhook.integration_not_found`
- `zpro.webhook.result`

## Modo seguro do webhook

Esta versao continua sem responder WhatsApp real automaticamente.

Quando um evento real chega, o backend:

- salva o payload bruto em `crm_ai_webhook_events`;
- cria/atualiza o lead;
- registra `message_received` ou `audio_received`;
- registra uma decisao `ai_shadow_decision` apenas para auditoria;
- nao chama OpenAI;
- nao envia mensagem ao Z-PRO;
- nao transfere ticket no Z-PRO.

O evento `ai_shadow_decision` ja usa o formato esperado para a futura IA:

```json
{
  "acao": "ignorar",
  "mensagem": "",
  "tipo_contato": "unknown",
  "motivo_transferencia": null,
  "fila_destino": null,
  "funil_destino": null,
  "etapa_destino": null,
  "confianca": 0.2,
  "modo_seguro": true
}
```

Se o contato enviar audio pela segunda vez, a decisao registrada fica como sugestao de transferencia por motivo `audio`, mas nenhuma acao e executada.

## Migration incremental recomendada

Rode no Supabase SQL Editor:

```text
migrations/20260810_leads_contact_type_audio.sql
```

Ela adiciona em `crm_ai_leads`:

- `contact_type`: `lead`, `customer` ou `unknown`;
- `audio_message_count`;
- `last_audio_at`;
- indices para relatorios/filtros.

O backend tambem salva esses dados em `metadata`, entao o webhook nao quebra se o deploy acontecer antes da migration. Depois que a migration for aplicada, ele passa a preencher as colunas explicitamente.

## Rotas administrativas Z-PRO

O backend aceita `ADMIN_API_KEY` ou JWT Supabase, conforme a rota.

Salvar configuracao e token pelo painel:

```http
POST /api/integrations/zpro
```

Salvar apenas token:

```http
POST /api/integrations/:integrationId/zpro/token
```

Testar conexao:

```http
POST /api/integrations/zpro/test
POST /api/integrations/:integrationId/zpro/test
```

Consultar/sincronizar recursos preparados:

```http
GET /api/integrations/zpro/users?integrationId=ID
GET /api/integrations/zpro/queues?integrationId=ID
GET /api/integrations/zpro/channels?integrationId=ID
GET /api/integrations/zpro/pipelines?integrationId=ID
GET /api/integrations/zpro/stages?integrationId=ID
GET /api/integrations/zpro/tickets?integrationId=ID
GET /api/integrations/zpro/opportunities?integrationId=ID
```

Por enquanto, somente `queues` usa a chamada que ja existia no codigo (`listQueues`). Os demais retornam erro amigavel ate a rota oficial do Z-PRO ser confirmada.

## Checklist rapido

- `GET /health` responde.
- `GET /webhooks/zpro/:webhookPublicId/ping` retorna `integrationFound`.
- `GET /api/debug/integrations` funciona com `x-admin-api-key`.
- Webhook fake cria registro em `crm_ai_webhook_events`.
- Webhook fake cria/atualiza `crm_ai_leads`.
- Webhook fake cria `crm_ai_lead_events`.
- Oportunidade automatica respeita `auto_create_opportunity`.
- Logs do Render mostram se o Z-PRO chamou a URL real.
