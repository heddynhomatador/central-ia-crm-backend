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
const { ZproService, messageExternalKey } = await import('../src/services/zproService.js');
const { processFollowupJob } = await import('../src/services/followupWorker.js');
const {
  extractPayload, webhookIgnoreReason, zproWebhookRouter, maybeSendAiReply,
  maybeCreateExternalOpportunity, syncOpportunityFromTicketState,
  externalOpportunityCreateRetryAllowed, createExternalOpportunityForRoute,
} = await import('../src/routes/zproWebhook.js');

function mockDb(t, resolve = () => ({ data: [], error: null })) {
  const queries = [];
  t.mock.method(supabaseAdmin, 'from', (table) => {
    const query = { table, operation: 'select', payload: null, filters: [] };
    const chain = {};
    for (const operation of ['select', 'insert', 'update', 'delete']) {
      chain[operation] = (payload) => {
        if (operation !== 'select') Object.assign(query, { operation, payload });
        return chain;
      };
    }
    for (const method of ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'in', 'is', 'order', 'limit', 'single', 'maybeSingle']) {
      chain[method] = (...args) => { query.filters.push([method, ...args]); return chain; };
    }
    chain.then = (yes, no) => {
      queries.push(query);
      return Promise.resolve().then(() => resolve(query)).then(yes, no);
    };
    return chain;
  });
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  return queries;
}

const integration = { id: 'integration-a', tenant_id: 'tenant-a', auto_create_opportunity: true,
  pipeline_id: '22', initial_stage_id: '49', active: true, provider: 'zpro', base_url: 'https://zpro.test/v2/api/external/test' };
const lead = { id: 'lead-a', tenant_id: 'tenant-a', integration_id: 'integration-a', phone: '5511000000000',
  name: 'Cliente', external_ticket_id: '17104', status: 'ai_attending', metadata: {}, last_message_at: '2026-01-01T00:00:00Z' };
const parsed = extractPayload({ method: 'message', msg: { id: 'wamid-1', type: 'text', text: { body: 'Mais informacoes' } },
  ticket: { id: 17104, channel: 'waba', whatsappId: 45, status: 'pending', contact: { number: lead.phone } } });

test('status WABA e dados do ticket nao viram mensagem do cliente; texto e botoes entram', () => {
  for (const payload of [
    { method: 'status', msg: { status: 'delivered' } },
    { method: 'message_ack', msg: { id: 'wamid-status', body: 'Texto antigo' } },
    { method: 'message', statuses: [{ id: 'wamid-status', status: 'read' }] },
    { method: 'ticket_created' },
  ]) {
    const event = extractPayload({ ...payload, ticket: { channel: 'waba', lastMessage: 'Mais informacoes', contact: { number: lead.phone } } });
    assert.equal(webhookIgnoreReason(event), 'Evento WABA sem nova mensagem do cliente');
  }
  assert.equal(webhookIgnoreReason(parsed), null);
  for (const msg of [
    { type: 'button', button: { text: 'Mais informacoes' } },
    { type: 'interactive', interactive: { button_reply: { title: 'Quero regularizar' } } },
    { type: 'interactive', interactive: { list_reply: { title: 'Segunda via' } } },
    { type: 'audio', audio: { id: 'media-1' } },
  ]) {
    assert.equal(webhookIgnoreReason(extractPayload({ method: 'message', msg, ticket: { channel: 'waba', contact: { number: lead.phone } } })), null);
  }
  assert.equal(webhookIgnoreReason(extractPayload({ method: 'message', msg: { key: { id: 'baileys', fromMe: false },
    message: { conversation: 'Ola' } }, ticket: { channel: 'whatsapp', contact: { number: lead.phone } } })), null);
});

test('1000 eventos HTTP de campanha e recibos sao ignorados sem banco, IA ou criacao de oportunidades', async (t) => {
  const dbMock = t.mock.method(supabaseAdmin, 'from', () => { throw new Error('Nao deveria acessar banco'); });
  const rpcMock = t.mock.method(supabaseAdmin, 'rpc', () => { throw new Error('Nao deveria acessar credenciais'); });
  const logs = [];
  t.mock.method(console, 'log', (value) => logs.push(JSON.parse(value)));
  const app = express();
  app.use(express.json());
  app.use('/webhook', zproWebhookRouter);
  const server = http.createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  for (let offset = 0; offset < 1000; offset += 25) {
    await Promise.all(Array.from({ length: 25 }, async (_, index) => {
      const outgoing = index % 2 === 0;
      const response = await fetch(`http://127.0.0.1:${server.address().port}/webhook/test`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: outgoing ? 'message_sent_waba' : 'message_ack',
          msg: { id: `event-${offset + index}`, fromMe: outgoing, body: 'Template de campanha' },
          ticket: { id: 17104, channel: 'waba', contact: { number: lead.phone } } }),
      });
      assert.equal(response.status, 200);
      assert.ok((await response.json()).ignored);
    }));
  }
  assert.equal(dbMock.mock.callCount(), 0);
  assert.equal(rpcMock.mock.callCount(), 0);
  assert.equal(logs.length, 1000);
  assert.ok(logs.every((item) => item.status === 'ignored' && !item.payloadPreview && !item.rawBody && !item.parsed));
});

test('falha de sessao persiste cooldown depois de sincronizar dono e impede nova criacao na rota', async (t) => {
  let row = { id: 'opportunity-a', pipeline_id: '22', stage_id: '50', raw_data: {} };
  mockDb(t, (q) => {
    if (q.table === 'crm_ai_opportunities' && q.operation === 'update') row = { ...row, ...q.payload };
    return { data: q.table === 'crm_ai_opportunities' ? structuredClone(row) : [], error: null };
  });
  let createCount = 0;
  const zpro = {
    createOpportunity: async () => { createCount += 1; throw new Error('Z-PRO 400: ERR_API_REQUIRES_SESSION'); },
    listOpportunities: async () => { throw new Error('Nao listar depois de rejeicao por sessao'); },
  };
  const result = await maybeCreateExternalOpportunity({ zpro, integration, actions: [], parsed, lead, opportunity: row });
  assert.ok(result.error);
  const opportunity = await syncOpportunityFromTicketState({ getZpro: async () => zpro,
    integration, actions: [], parsed, lead, opportunity: result.opportunity });
  assert.ok(opportunity.raw_data.zpro_create_retry_after);
  assert.equal(opportunity.raw_data.zpro_create_failure_count, 1);
  assert.equal(externalOpportunityCreateRetryAllowed(opportunity), false);
  assert.equal(opportunity.raw_data.zpro_ticket_sync_ticket_id, '17104');
  assert.equal((await maybeCreateExternalOpportunity({ zpro, integration, actions: [], parsed, lead, opportunity })).deferred, true);
  await assert.rejects(createExternalOpportunityForRoute({ zpro, integration, parsed, lead, opportunity, pipelineId: '22', stageId: '50' }),
    { code: 'ZPRO_OPPORTUNITY_RETRY_DEFERRED' });
  assert.equal(createCount, 1);
});

test('criacao apos cooldown usa etapa atual e devolve estado vinculado para sincronizacao', async (t) => {
  let row = { id: 'opportunity-a', pipeline_id: '22', stage_id: '50', raw_data: { zpro_create_error: 'antigo', zpro_create_retry_after: '2026-01-01', zpro_create_failure_count: 1 } };
  mockDb(t, (q) => {
    if (q.table === 'crm_ai_opportunities' && q.operation === 'update') row = { ...row, ...q.payload };
    return { data: structuredClone(row), error: null };
  });
  const zpro = { createOpportunity: async (body) => {
    assert.equal(body.stageId, '50');
    assert.equal(body.validateNumber, false);
    return { endpoint: 'createOpportunity', data: { id: 901 } };
  } };
  const result = await maybeCreateExternalOpportunity({ zpro, integration, actions: [], parsed, lead, opportunity: row });
  assert.equal(result.opportunity.external_opportunity_id, '901');
  assert.equal(result.opportunity.raw_data.zpro_create_error, null);
  assert.equal(result.opportunity.raw_data.zpro_create_retry_after, null);
});

test('IA em modo live envia por ticket; falha da API e modo seguro aparecem separadamente', async (t) => {
  const queries = mockDb(t);
  const calls = [];
  let sendFails = false;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const target = String(url);
    calls.push({ url: target, body: JSON.parse(options.body) });
    if (target === 'https://api.openai.com/v1/chat/completions') {
      return Response.json({ choices: [{ message: { content: JSON.stringify({ action: 'reply', reply: 'Posso explicar como funciona.', confidence: 1 }) } }] });
    }
    assert.equal(target, `${integration.base_url}/sendMessageByTicket`);
    return sendFails ? Response.json({ error: 'ERR_API_REQUIRES_SESSION' }, { status: 400 }) : Response.json({ success: true });
  });
  const zpro = new ZproService({ baseUrl: integration.base_url, token: 'test-token' });
  const agent = { id: 'agent-a', enabled: true, settings: { safe_mode: false }, system_prompt: 'Responda objetivamente.' };
  const args = { zpro, integration, agent, actions: [], parsed, lead, leadMetadata: {}, opportunity: null };
  const sent = await maybeSendAiReply(args);
  assert.equal(sent.reply, 'Posso explicar como funciona.');
  assert.equal(sent.result.endpoint, 'sendMessageByTicket');
  const request = calls.find((call) => call.url.endsWith('/sendMessageByTicket'));
  assert.equal(request.body.ticketId, 17104);
  assert.equal(request.body.externalKey, messageExternalKey('ai_reply', integration.id, parsed.eventId));
  assert.equal(request.body.reopen, false);
  sendFails = true;
  const failure = await maybeSendAiReply({ ...args, parsed: { ...parsed, eventId: 'wamid-2' } });
  assert.equal(failure.reply, undefined);
  assert.equal(failure.failedStep, 'send_message');
  assert.equal(failure.errorCode, 'ZPRO_API_REQUIRES_SESSION');
  assert.ok(failure.perf.total_ms >= 0);
  assert.equal(queries.filter((q) => q.table === 'crm_ai_lead_events' && q.payload?.event_type === 'ai_response_sent').length, 1);
  assert.equal(queries.filter((q) => q.table === 'crm_ai_ticket_context' && q.payload?.event_type === 'ai_response_sent').length, 1);
  const before = calls.length;
  const skipped = await maybeSendAiReply({ ...args, agent: { ...agent, settings: { safe_mode: true } } });
  assert.equal(skipped.skippedReason, 'safe_mode_or_backend_not_live');
  assert.equal(calls.length, before);
});

test('follow-up envia no ticket agendado com chave estavel e sem criar outro atendimento', async (t) => {
  let job = { id: 'job-a', lead_id: lead.id, policy_id: 'policy-a', attempt: 1, external_ticket_id: '17104', status: 'pending', updated_at: '2026-09-15T00:00:00Z' };
  const policy = { id: 'policy-a', enabled: true, messages: ['Posso ajudar?'], delays_minutes: [1], max_attempts: 1, transfer_after_last: false };
  mockDb(t, (q) => {
    if (q.table === 'crm_ai_followup_jobs' && q.operation === 'update') job = { ...job, ...q.payload };
    const data = { crm_ai_followup_jobs: job, crm_ai_leads: lead, crm_ai_followup_policies: policy, crm_ai_integrations: integration }[q.table] || [];
    return { data: structuredClone(data), error: null };
  });
  t.mock.method(supabaseAdmin, 'rpc', async () => ({ data: 'test-token', error: null }));
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    if (String(url).endsWith('/showTicketById')) return Response.json({ status: 'pending', userId: null });
    assert.equal(String(url), `${integration.base_url}/sendMessageByTicket`);
    return Response.json({ success: true });
  });
  assert.equal(await processFollowupJob(job), true);
  assert.equal(job.status, 'sent');
  assert.deepEqual(calls[1].body, { ticketId: 17104, body: 'Posso ajudar?', externalKey: messageExternalKey('followup', integration.id, job.id), reopen: false, isClosed: false });
});
