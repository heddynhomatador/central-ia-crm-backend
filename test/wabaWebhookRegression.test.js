import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import express from 'express';

process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
process.env.OPENAI_API_KEY = 'test-key';
process.env.APP_MODE = 'live';
const { supabaseAdmin } = await import('../src/lib/supabaseAdmin.js');
const { zproWebhookRouter } = await import('../src/routes/zproWebhook.js');

test('webhook completo responde com rota legada, isola erro 500 da oportunidade e nao duplica eventos', async (t) => {
  const httpFetch = globalThis.fetch;
  const base = 'https://zpro-regression.test/v2/api/external/official';
  const integration = { id: 'integration', tenant_id: 'tenant', active: true, provider: 'zpro', base_url: base,
    pipeline_id: '22', initial_stage_id: '50', auto_create_opportunity: true };
  const agent = { id: 'agent', enabled: true, system_prompt: 'Ajude o cliente.', settings: { safe_mode: false, integration_id: integration.id, channel_id: '45' } };
  let lead = { id: 'lead', tenant_id: 'tenant', integration_id: 'integration', status: 'new', phone: '5511000000000', metadata: {} };
  let opportunity = null;
  const eventIds = new Set();
  const logs = [];
  const calls = [];
  t.mock.method(console, 'log', (value) => logs.push(JSON.parse(value)));
  t.mock.method(console, 'warn', (value) => logs.push(JSON.parse(value)));
  t.mock.method(supabaseAdmin, 'rpc', async () => ({ data: 'test-token', error: null }));
  t.mock.method(supabaseAdmin, 'from', (table) => {
    let operation = 'select';
    let payload;
    const chain = {};
    for (const method of ['select', 'insert', 'update', 'delete']) {
      chain[method] = (value) => {
        if (method !== 'select') { operation = method; payload = value; }
        return chain;
      };
    }
    for (const method of ['eq', 'in', 'is', 'gt', 'gte', 'lt', 'order', 'limit', 'single', 'maybeSingle']) chain[method] = () => chain;
    chain.then = (resolve, reject) => Promise.resolve().then(() => {
      if (table === 'crm_ai_webhook_events' && operation === 'insert') {
        if (eventIds.has(payload.external_event_id)) return { data: null, error: { code: '23505' } };
        eventIds.add(payload.external_event_id);
      }
      if (table === 'crm_ai_leads' && operation === 'update') lead = { ...lead, ...payload };
      if (table === 'crm_ai_opportunities' && ['insert', 'update'].includes(operation)) opportunity = { id: 'opportunity', ...opportunity, ...payload };
      const data = { crm_ai_integrations: integration, crm_ai_agents: [agent], crm_ai_leads: lead,
        crm_ai_opportunities: opportunity }[table] ?? [];
      return { data: table === 'crm_ai_opportunities' ? opportunity : structuredClone(data), error: null };
    }).then(resolve, reject);
    return chain;
  });
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const target = String(url);
    calls.push(target);
    if (target === 'https://api.openai.com/v1/chat/completions') {
      return Response.json({ choices: [{ message: { content: JSON.stringify({ action: 'reply', reply: 'Posso ajudar com suas informacoes.', confidence: 1 }) } }] });
    }
    if (target === `${base}/sendMessageByTicket`) {
      return new Response('<pre>Cannot POST /v2/api/external/official/sendMessageByTicket</pre>', { status: 404 });
    }
    if (target === `${base}/showTicketById`) {
      return Response.json({ id: 17107, status: 'pending', userId: null, whatsappId: 45, contact: { number: '5511000000000' } });
    }
    if (target === base) {
      assert.equal(JSON.parse(options.body).validateNumber, false);
      return Response.json({ success: true });
    }
    if (target === `${base}/createOpportunity`) return Response.json({ success: false, error: 'ERR_CREATE_OPPORTUNITY' }, { status: 500 });
    if (target.startsWith(`${base}/listOpportunities`)) return Response.json({ opportunities: [] });
    throw new Error(`Requisicao nao esperada: ${target}`);
  });
  const app = express();
  app.use(express.json());
  app.use('/webhooks/zpro', zproWebhookRouter);
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  const server = http.createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const post = async (id) => {
    const response = await httpFetch(`http://127.0.0.1:${server.address().port}/webhooks/zpro/webhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'message',
        msg: { id, type: 'button', button: { text: 'Mais informacoes' } },
        ticket: { id: 17107, channel: 'waba', whatsappId: 45, status: 'pending', userId: null,
          contact: { id: 12273, number: '5511000000000', name: 'Cliente' } } }),
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body;
  };
  const result = await post('event-1');
  assert.equal(result.aiReplySent, true);
  assert.ok(calls.indexOf(base) < calls.indexOf(`${base}/createOpportunity`), 'resposta deve preceder criacao externa');
  assert.ok(opportunity.raw_data.zpro_create_retry_after);
  assert.match(opportunity.raw_data.zpro_create_error, /ERR_CREATE_OPPORTUNITY/);
  const beforeDuplicate = calls.length;
  assert.equal((await post('event-1')).ignored, 'Evento duplicado');
  assert.equal(calls.length, beforeDuplicate);
  assert.equal((await post('event-2')).aiReplySent, true);
  assert.equal(calls.filter((url) => url === base).length, 2);
  assert.equal(calls.filter((url) => url === `${base}/createOpportunity`).length, 1);
  assert.equal(calls.filter((url) => url === `${base}/sendMessageByTicket`).length, 1);
  const processed = logs.filter((row) => row.event === 'zpro.webhook.result' && row.status === 'processed');
  assert.equal(processed.length, 2);
  assert.ok(processed.every((row) => row.aiReplySent && row.aiSendCompatibility === 'verified_pending_ticket' && row.opportunityCreateError));
});
