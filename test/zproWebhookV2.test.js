import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';

process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.APP_MODE = 'live';

const { supabaseAdmin } = await import('../src/lib/supabaseAdmin.js');
const { zproWebhookRouter } = await import('../src/routes/zproWebhook.js');

function queryResult(data) {
  return {
    select() { return this; },
    eq() { return this; },
    order() { return this; },
    maybeSingle() { return this; },
    then(resolve, reject) { return Promise.resolve({ data, error: null }).then(resolve, reject); },
  };
}

test('webhook v2 responde 200 para evento novo e duplicado sem enfileirar duplicidade', async (t) => {
  const integration = {
    id: 'integration-v2',
    tenant_id: 'tenant-v2',
    active: true,
    provider: 'zpro',
    webhook_public_id: 'public-v2',
  };
  const agent = {
    id: 'agent-v2',
    tenant_id: 'tenant-v2',
    enabled: true,
    settings: {
      conversation_engine: 'v2',
      integration_id: 'integration-v2',
      channel_id: '45',
    },
  };
  const seen = new Set();
  let rpcCalls = 0;

  t.mock.method(supabaseAdmin, 'from', (table) => {
    if (table === 'crm_ai_integrations') return queryResult(integration);
    if (table === 'crm_ai_agents') return queryResult([agent]);
    throw new Error(`Tabela inesperada no teste: ${table}`);
  });
  t.mock.method(supabaseAdmin, 'rpc', async (name, args) => {
    assert.equal(name, 'crm_ai_enqueue_turn');
    rpcCalls += 1;
    const duplicate = seen.has(args.p_event);
    seen.add(args.p_event);
    return {
      data: {
        id: duplicate ? 'turn-existing' : 'turn-new',
        duplicate,
        status: 'received',
      },
      error: null,
    };
  });
  t.mock.method(console, 'log', () => {});

  const app = express();
  app.use(express.json());
  app.use('/webhooks/zpro', zproWebhookRouter);
  const server = http.createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));

  const payload = {
    method: 'message',
    msg: {
      id: 'wamid-v2-1',
      body: 'Quero saber o valor',
      key: { id: 'wamid-v2-1', fromMe: false },
    },
    ticket: {
      id: 17107,
      status: 'pending',
      channel: 'whatsapp',
      whatsappId: 45,
      contact: { number: '5511999999999', name: 'Cliente' },
    },
  };
  const url = `http://127.0.0.1:${server.address().port}/webhooks/zpro/public-v2`;

  const first = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const second = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal((await first.json()).queued, true);
  assert.equal((await second.json()).queued, false);
  assert.equal(rpcCalls, 2);
  assert.equal(seen.size, 1);
});
