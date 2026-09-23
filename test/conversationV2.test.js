import assert from 'node:assert/strict';
import test, { before, after, afterEach } from 'node:test';
import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { engineDatabase, seedScope, makeDue } from '../test-support/engineDb.js';
import { EngineStore } from '../src/operations/store.js';
import { CommandExecutor } from '../src/operations/commandExecutor.js';
import { processTurn } from '../src/conversation/processTurn.js';
import { validateTurnDecision } from '../src/conversation/policyValidator.js';
import { decisionMessages, generateTurnDecision } from '../src/conversation/decisionEngine.js';
import { initialState, followupEligible } from '../src/conversation/state.js';
import { normalizeInboundMessage } from '../src/inbound/normalizeInboundMessage.js';
import { appointmentOptionsReply } from '../src/appointments/appointmentRenderer.js';
import { slotFor, schedulePolicy, availableSlots } from '../src/appointments/appointmentService.js';
import { syncOpportunity, exactOpportunityMatch } from '../src/crm/opportunityService.js';
import { validAssignees } from '../src/crm/resources.js';
import { validateFollowupPolicy } from '../src/followup/policyConfig.js';

process.env.APP_MODE = 'live';
let db, store;
before(async () => { db = await engineDatabase(); store = new EngineStore(db); });
after(async () => { await db.pg.close(); });
afterEach(async () => {
  await db.pg.exec("update crm_ai_turns set status='processed'; update crm_ai_conversations set lease_owner=null,lease_until=null; update crm_ai_followup_runs set status='cancelled'");
});
function decision(text, patch = {}) {
  return { intent: 'product_question', topic: 'produto', reply: 'O produto atende essa necessidade.', confidence: 0.99,
    conversation: { next_state: 'information' }, appointment: { action: 'none', date: '', time: '', period: '', slot_id: '', confirmed: false },
    crm: { action: 'none', rule_id: '' }, handoff: { required: false, reason: '' }, close: false,
    followup: { eligible: true }, evidence: [text], ...patch };
}
function resources(e) {
  return { agent: { id: e.agent_id, tenant_id: e.tenant_id, enabled: true, settings: { conversation_engine: 'v2', integration_id: e.integration_id,
    schedule_policy: { enabled: true, timezone: 'America/Sao_Paulo', duration_minutes: 60, buffer_minutes: 15, advance_notice_minutes: 0, horizon_days: 21,
      business_hours: Object.fromEntries(Array.from({ length: 7 }, (_, i) => [String(i), [['09:00', '18:00']]])) } } },
    integration: { id: e.integration_id, tenant_id: e.tenant_id, active: true, sales_queue_id: '3', pipeline_id: '1', initial_stage_id: '2' },
    actions: ['create_opportunity', 'transfer_ticket', 'schedule_followup', 'schedule_appointment', 'update_opportunity', 'close_ticket']
      .map((action_key) => ({ action_key, enabled: true })), rules: [],
    references: { pipelines: [{ external_pipeline_id: '1' }], stages: [{ external_pipeline_id: '1', external_stage_id: '2' }],
      queues: [{ external_queue_id: '3', active: true }], users: [{ external_user_id: '4', active: true }] },
    followupPolicy: null, opportunity: null, capabilities: {} };
}
async function prepare(text, previous = initialState()) {
  const e = await seedScope(db); e.current_message.text = text;
  await store.enqueue(e); await makeDue(db);
  const batch = await store.claim();
  batch.conversation.state = previous;
  await db.pg.query('update crm_ai_conversations set state=$1 where id=$2', [JSON.stringify(previous), batch.conversation.id]);
  const r = resources(e); const sent = []; const calls = [];
  let ticket = { id: e.ticket_id, status: 'pending', whatsappId: 1, userId: null, queueId: 3, contact: { number: e.metadata.phone } };
  const zpro = {
    async showTicket() { return { data: ticket }; },
    async sendMessage(p) { sent.push(p); return { data: { success: true } }; },
    async listAppointments() { return { data: [] }; },
    async createAppointment(p) { calls.push(['appointment', p]); return { data: { id: 89 } }; },
    async updateTicketAssignment(p) { calls.push(['ticket', p]); ticket = { ...ticket, ...p, id: e.ticket_id }; return { data: ticket }; },
  };
  const run = async (d, modelHook = null) => processTurn({ batch, store, resourcesLoader: async () => r, zproFactory: async () => zpro,
    model: async (input) => { calls.push(['model', input]); if (modelHook) await modelHook(); return d; } });
  return { e, batch, r, zpro, sent, calls, run, current: () => store.current(batch.conversation) };
}
function futureSlot() {
  return slotFor(DateTime.now().setZone('America/Sao_Paulo').plus({ days: 2 }).toISODate(), '14:15',
    { timezone: 'America/Sao_Paulo', duration_minutes: 60 });
}
function pending() { return { ...initialState(), status: 'appointment_pending', appointment: { status: 'awaiting_slot', options: [futureSlot()] } }; }

test('1: preco interrompe agenda pendente; decisor sempre recebe mensagem atual', async () => {
  const f = await prepare('Qual o valor?', pending());
  await f.run(decision(f.e.current_message.text, { intent: 'pricing_question', reply: 'O valor depende do plano.' }));
  assert.deepEqual(f.sent.map((p) => p.body), ['O valor depende do plano.']);
  assert.equal((await f.current()).state.appointment.status, 'paused');
  assert.equal(f.calls.filter(([kind]) => kind === 'model').length, 1);
  assert.equal(f.calls.some(([kind]) => kind === 'appointment'), false);
});
test('2: escolha 14h15 reserva horario antes de confirmar ao cliente', async () => {
  const f = await prepare('14h15', pending()), slot = futureSlot();
  await f.run(decision('14h15', { intent: 'appointment_slot_selection', appointment: { action: 'select_slot', date: '', time: '', period: '', slot_id: slot.id, confirmed: true } }));
  assert.equal(f.calls.filter(([k]) => k === 'appointment').length, 1);
  assert.match(f.sent[0].body, /confirmado/);
  assert.equal((await f.current()).state.appointment.external_id, '89');
});
test('3: recusar reuniao nao encerra nem transfere; 5: negacao de humano continua conversa', async () => {
  for (const [text, intent] of [['Não quero agendar reunião, só queria saber como funciona.', 'appointment_declined'], ['Não precisa chamar atendente.', 'product_question']]) {
    const f = await prepare(text, pending());
    await f.run(decision(text, { intent }));
    assert.equal(f.calls.some(([k]) => ['ticket', 'appointment'].includes(k)), false);
    assert.equal((await f.current()).state.status, 'information');
  }
});
test('4: pedido humano transfere e verifica ticket; regra nao impede reserva anterior', async () => {
  const f = await prepare('Quero falar com uma pessoa.');
  f.r.rules = [{ id: 'rule', active: true, external_pipeline_id: '1', external_stage_id: '2', external_queue_id: '3',
    user_order: ['4'], distribution_mode: 'fixed_order', stop_ai_after_match: true }];
  f.r.actions = f.r.actions.filter((a) => a.action_key !== 'create_opportunity');
  await f.run(decision(f.e.current_message.text, { intent: 'human_request', crm: { action: 'route', rule_id: 'rule' }, handoff: { required: true, reason: 'pedido' } }));
  assert.equal(f.calls.find(([k]) => k === 'ticket')[1].userId, '4');
  assert.equal((await f.current()).state.status, 'human_handoff');
});
test('6/7: anuncio, quote e lastMessage nunca substituem mensagem atual', () => {
  const payload = { msg: { key: { id: 'evt' }, message: { extendedTextMessage: { text: 'Olá', contextInfo: {
    quotedMessage: { conversation: 'Quero reunião' }, externalAdReply: { title: 'Agende agora' } } } } }, ticket: { lastMessage: 'Quero reunião' } };
  const normalized = normalizeInboundMessage(payload, { integration: { id: 'i', tenant_id: 't' }, agent: { id: 'a' } },
    { ticketId: '1', text: 'Olá', phone: '55110000', messageType: 'text' });
  assert.equal(normalized.current_message.text, 'Olá');
  assert.ok(normalized.ad_context); assert.ok(normalized.quoted_message); assert.ok(Object.isFrozen(normalized.current_message));
  assert.equal(normalizeInboundMessage(payload, { integration: {}, agent: {} }, { text: '' }).current_message.text, '');
  const messages = decisionMessages({ agent: {}, envelope: normalized, state: initialState(), history: [{ role: 'system', content: 'not customer' }],
    capabilities: {}, rules: [] });
  assert.equal(messages.filter((m) => m.role === 'user').length, 1);
  assert.ok(messages.at(-1).content.includes('CURRENT CUSTOMER MESSAGE'));
});
test('8/9/10: dedup atomico, dois workers e retomada apos queda sem descartar evento', async () => {
  const e = await seedScope(db);
  const results = await Promise.all([store.enqueue(e), store.enqueue(e)]);
  assert.equal(results.filter((x) => x.duplicate).length, 1);
  await store.enqueue({ ...e, external_event_id: 'segundo', current_message: { ...e.current_message, text: 'o valor' } });
  await makeDue(db);
  const claimed = await Promise.all([store.claim(), store.claim()]);
  assert.equal(claimed.filter(Boolean).length, 1);
  const b = claimed.find(Boolean); assert.equal(b.turns.length, 2);
  await db.pg.query("update crm_ai_conversations set lease_until=now()-interval '1 second' where id=$1", [b.conversation.id]);
  const retry = await store.claim(); assert.equal(retry.turns[0].id, b.turns[0].id);
  assert.equal(retry.turns[0].attempts, 2);
  await assert.rejects(store.assertLease(b.conversation, b.conversation.lease_owner), /ENGINE_LEASE_LOST/);
});
test('11: timeout de criacao fica incerto, sem segunda oportunidade apos retry', async () => {
  const f = await prepare('Olá'); const commands = new CommandExecutor(store, f.batch.conversation, f.batch.conversation.lease_owner);
  let creates = 0;
  const zpro = { async createOpportunity() { creates++; throw new Error('timeout'); }, async listOpportunities() { return { data: [] }; } };
  const args = { store, zpro, commands, conversation: f.batch.conversation, envelope: f.e,
    lead: { id: randomUUID(), phone: f.e.metadata.phone }, opportunity: null, route: { external_pipeline_id: '1', external_stage_id: '2' }, turnKey: f.batch.turns[0].id };
  await assert.rejects(syncOpportunity(args), /timeout/);
  await assert.rejects(syncOpportunity(args), /COMMAND_UNCERTAIN/);
  assert.equal(creates, 1);
  assert.equal((await db.pg.query('select * from crm_ai_opportunities where tenant_id=$1', [f.e.tenant_id])).rows.length, 0);
});
test('pergunta comercial preserva resposta mesmo se createOpportunity falhar em background', async () => {
  const f = await prepare('Qual o valor do CRM?');
  f.r.integration.auto_create_opportunity = true;
  f.zpro.createOpportunity = async () => { throw Object.assign(new Error('zpro offline'), { status: 500 }); };
  f.zpro.listOpportunities = async () => ({ data: [] });
  await f.run(decision(f.e.current_message.text, { intent: 'pricing_question', reply: 'Os valores dependem da sua operação.' }));
  assert.deepEqual(f.sent.map((p) => p.body), ['Os valores dependem da sua operação.']);
  const state = (await f.current()).state;
  assert.equal(state.status, 'information');
  assert.equal(state.followup_eligible, false);
  assert.ok(state.failed_background_action);
});
test('12: falha ao mover nao atualiza etapa local', async () => {
  const f = await prepare('Mudar'); const id = randomUUID();
  await db.pg.query("insert into crm_ai_opportunities(id,tenant_id,integration_id,external_ticket_id,external_opportunity_id,pipeline_id,stage_id) values($1,$2,$3,$4,'50','1','1')",
    [id, f.e.tenant_id, f.e.integration_id, f.e.ticket_id]);
  const opportunity = (await db.pg.query('select * from crm_ai_opportunities where id=$1', [id])).rows[0];
  await assert.rejects(syncOpportunity({ store, zpro: { async moveOpportunity() { throw Object.assign(new Error('rejected'), { zproStatus: 400 }); } },
    commands: new CommandExecutor(store, f.batch.conversation, f.batch.conversation.lease_owner), conversation: f.batch.conversation,
    envelope: f.e, lead: { id: randomUUID(), phone: f.e.metadata.phone }, opportunity, route: { external_pipeline_id: '1', external_stage_id: '2' }, turnKey: 'move' }), /rejected/);
  assert.equal((await db.pg.query('select stage_id from crm_ai_opportunities where id=$1', [id])).rows[0].stage_id, '1');
});
test('pergunta comercial preserva resposta mesmo se moveOpportunity falhar em background', async () => {
  const f = await prepare('Qual o valor do CRM?');
  f.r.opportunity = { id: randomUUID(), external_opportunity_id: '99', pipeline_id: '1', stage_id: '1',
    assigned_external_user_id: null, status: 'open', value: 0 };
  f.r.rules = [{ id: 'info', active: true, external_pipeline_id: '1', external_stage_id: '2',
    external_queue_id: null, user_order: [], distribution_mode: 'manual' }];
  f.zpro.moveOpportunity = async () => { throw Object.assign(new Error('move failed'), { status: 500 }); };
  f.zpro.listOpportunities = async () => ({ data: [] });
  await f.run(decision(f.e.current_message.text, { intent: 'pricing_question', reply: 'Os valores dependem da sua operação.',
    crm: { action: 'route', rule_id: 'info' } }));
  assert.deepEqual(f.sent.map((p) => p.body), ['Os valores dependem da sua operação.']);
  const state = (await f.current()).state;
  assert.equal(state.status, 'information');
  assert.ok(state.failed_background_action);
});
test('handoff explicito com falha de transferencia nao afirma que transferiu', async () => {
  const f = await prepare('Quero falar com uma pessoa.');
  f.r.rules = [{ id: 'rule', active: true, external_pipeline_id: '1', external_stage_id: '2', external_queue_id: '3',
    user_order: ['4'], distribution_mode: 'fixed_order', stop_ai_after_match: true }];
  f.r.actions = f.r.actions.filter((a) => a.action_key !== 'create_opportunity');
  f.zpro.updateTicketAssignment = async () => { throw Object.assign(new Error('transfer failed'), { status: 400 }); };
  await f.run(decision(f.e.current_message.text, { intent: 'human_request', crm: { action: 'route', rule_id: 'rule' },
    handoff: { required: true, reason: 'pedido humano' }, reply: 'Vou te encaminhar agora.' }));
  assert.equal(f.sent.length, 1);
  assert.doesNotMatch(f.sent[0].body, /encaminhado|transferido/i);
  assert.match(f.sent[0].body, /Não consegui concluir/i);
  assert.equal((await f.current()).state.status, 'failed_action');
});
test('13: resposta cancela follow-up mesmo depois do claim; workers nao compartilham job', async () => {
  const f = await prepare('Olá'); await store.finish(f.batch, initialState(), []);
  await db.pg.query("insert into crm_ai_followup_runs(tenant_id,conversation_id,cycle,turn_version,policy_id,attempt,run_at) values($1,$2,1,1,$3,1,now())",
    [f.e.tenant_id, f.batch.conversation.id, randomUUID()]);
  const claims = await Promise.all([store.rpc('crm_ai_claim_followup', { p_owner: randomUUID() }), store.rpc('crm_ai_claim_followup', { p_owner: randomUUID() })]);
  assert.equal(claims.filter(Boolean).length, 1);
  const b = claims.find(Boolean);
  await store.enqueue({ ...f.e, external_event_id: randomUUID(), current_message: { text: 'Respondi' } });
  assert.equal(await store.rpc('crm_ai_followup_send_allowed', { p_conversation: b.conversation.id, p_owner: b.conversation.lease_owner, p_job: b.job.id }), false);
});
test('14/18: novo ticket e outro tenant nao herdam estado, mesmo telefone e ids externos', async () => {
  const f = await prepare('Olá', pending()); await store.finish(f.batch, pending(), []);
  await store.enqueue({ ...f.e, ticket_id: 'novo', external_event_id: randomUUID() });
  const other = await seedScope(db, f.e.ticket_id, f.e.metadata.phone); await store.enqueue(other); await makeDue(db);
  const claims = await Promise.all([store.claim(), store.claim()]);
  assert.equal(claims.filter(Boolean).length, 2);
  assert.ok(claims.every((b) => b.conversation.state.appointment.status === 'idle'));
  assert.notEqual(claims[0].conversation.id, claims[1].conversation.id);
  await assert.rejects(store.enqueue({ ...other, tenant_id: f.e.tenant_id, external_event_id: randomUUID() }), /ENGINE_SCOPE_INVALID/);
});
test('15/16: acao ausente ou desativada bloqueia agenda e CRM', async () => {
  const e = await seedScope(db); const r = resources(e);
  for (const actions of [[], [{ action_key: 'schedule_appointment', enabled: false }]]) {
    const validated = validateTurnDecision({ ...r, actions, envelope: e, state: initialState(), ticket: { id: e.ticket_id, status: 'pending' },
      decision: decision('Olá', { intent: 'appointment_request', appointment: { action: 'offer' }, handoff: { required: true } }) });
    assert.equal(validated.decision.appointment.action, 'pause'); assert.equal(validated.decision.handoff.required, false);
  }
});
test('17: modos de distribuicao atomicos e idempotentes por atribuicao', async () => {
  const e = await seedScope(db);
  const choose = (mode, key, loads = {}) => store.rpc('crm_ai_next_distribution', { p_tenant: e.tenant_id, p_integration: e.integration_id,
    p_rule: 'r', p_users: ['4', '5'], p_mode: mode, p_loads: loads, p_assignment: key });
  assert.equal(await choose('manual', 'm'), null);
  assert.equal(await choose('fixed_order', 'f'), '4');
  assert.equal(await choose('balanced_rotation', 'a'), '4');
  assert.equal(await choose('balanced_rotation', 'a'), '4');
  assert.equal(await choose('balanced_rotation', 'b'), '5');
  assert.equal(await choose('least_load', 'c', { 4: 20, 5: 1 }), '5');
});
test('claim ignora conversa em backoff e processa outra conversa due', async () => {
  const first = await seedScope(db, 'A');
  await store.enqueue(first); await makeDue(db);
  const batchA = await store.claim();
  await store.finish(batchA, initialState(), [], 'BACKOFF');
  const newerA = { ...first, external_event_id: randomUUID(), current_message: { text: 'turno novo' } };
  await store.enqueue(newerA);
  const second = await seedScope(db, 'B');
  await store.enqueue(second);
  await db.pg.query("update crm_ai_turns set available_at=now()-interval '1 second' where external_event_id in ($1,$2)",
    [newerA.external_event_id, second.external_event_id]);

  const claimed = await store.claim();
  assert.equal(claimed.conversation.ticket_id, 'B');
  assert.equal(claimed.turns[0].external_event_id, second.external_event_id);

  await store.finish(claimed, initialState(), []);
  await db.pg.query("update crm_ai_turns set available_at=now()-interval '1 second' where conversation_id=$1 and version=1",
    [batchA.conversation.id]);
  const retryA = await store.claim();
  assert.equal(retryA.conversation.ticket_id, 'A');
  assert.equal(retryA.turns[0].version, 1);
});
test('reserva concorrente de dois tickets no mesmo horario tem um vencedor', async () => {
  const first = await prepare('a'); const e = { ...first.e, ticket_id: 'outro', external_event_id: randomUUID() };
  await store.enqueue(e); await makeDue(db); const second = await store.claim();
  const slot = futureSlot();
  const results = await Promise.all([first.batch, second].map((b) =>
    store.reserveSlot(b.conversation, b.conversation.lease_owner, 'slot', slot.start_at, slot.end_at)));
  assert.equal(results.filter(Boolean).length, 1);
});
test('mensagem mais recente invalida efeitos e resposta ainda nao enviados', async () => {
  const f = await prepare('Pode marcar', pending());
  await f.run(decision('Pode marcar', { intent: 'appointment_request', appointment: { action: 'offer' } }),
    () => store.enqueue({ ...f.e, external_event_id: randomUUID(), current_message: { text: 'Qual o valor?' } }));
  assert.equal(f.sent.length, 0); assert.equal(f.calls.filter(([k]) => k === 'appointment').length, 0);
});
test('follow-up bloqueado em agenda, handoff, fechado, falha e atendimento humano', () => {
  for (const status of ['appointment_pending', 'appointment_confirmed', 'human_handoff', 'closed', 'failed_action']) {
    assert.equal(followupEligible({ status, followup_eligible: true }, { status: 'pending' }), false);
  }
  assert.equal(followupEligible({ status: 'information', followup_eligible: true }, { status: 'open', userId: '4' }), false);
});
test('render de horarios usa linhas separadas e uma pergunta; datas por extenso ficam canonicas', () => {
  const slot = futureSlot(), text = appointmentOptionsReply([slot], 'afternoon');
  assert.match(text, /\n\n• 14h15\n\n/);
  assert.equal((text.match(/\?/g) || []).length, 1);
  assert.equal(slotFor('2026-09-31', '09:00', { timezone: 'America/Sao_Paulo', duration_minutes: 60 }), null);
});
test('modelo unico usa JSON estrito, temperatura zero, papeis e IDs limitados', async () => {
  const e = await seedScope(db), r = resources(e); let count = 0;
  const client = { chat: { completions: { async create(payload) {
    count++; assert.equal(payload.temperature, 0); assert.equal(payload.response_format.json_schema.strict, true);
    assert.deepEqual(payload.response_format.json_schema.schema.properties.crm.properties.rule_id.enum, ['']);
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(decision('Olá')) } }] };
  } } } };
  await generateTurnDecision({ agent: { ...r.agent, temperature: 2 }, envelope: e, state: initialState(), history: [], capabilities: {}, rules: [] }, client);
  assert.equal(count, 1);
});
test('baixa confianca e evidencia de anuncio nao autorizam movimentacao', async () => {
  const e = await seedScope(db), r = resources(e);
  const v = validateTurnDecision({ ...r, envelope: e, state: initialState(), ticket: { id: e.ticket_id, status: 'pending' },
    decision: decision('agende agora', { confidence: 0.4, intent: 'appointment_request', appointment: { action: 'offer' } }) });
  assert.ok(v.blocked.includes('insufficient_evidence')); assert.equal(v.decision.appointment.action, 'pause');
});
test('usuario de outra fila e politica incompleta nao sao aceitos', async () => {
  const e = await seedScope(db), r = resources(e);
  r.references.users[0].raw_data = { queues: [{ id: 90 }] };
  assert.throws(() => validAssignees({ user_order: ['4'], external_queue_id: '3' }, r.references), /OUTSIDE_QUEUE/);
  assert.throws(() => validateFollowupPolicy({ enabled: true, max_attempts: 3, messages: ['oi'], delays_minutes: [1],
    transfer_after_last: false, reset_attempts_on_reply: false, transfer_user_order: [] }, r.references), /Preencha/);
  assert.equal(exactOpportunityMatch({ phone: e.metadata.phone }, { ticket_id: e.ticket_id }, 'marker'), false);
});
test('indisponibilidade nao inventa horarios e respeita data e periodo pedidos', async () => {
  const f = await prepare('sexta a tarde'), policy = schedulePolicy(f.r.agent), date = futureSlot().date;
  const options = await availableSlots({ zpro: f.zpro, store, conversation: f.batch.conversation, policy, date, period: 'afternoon' });
  assert.ok(options.length > 0); assert.ok(options.every((s) => s.date === date && s.time >= '12:00'));
});
test('shadow calcula comparacao sem enviar, criar lead ou alterar CRM', async () => {
  const f = await prepare('Qual o valor?'); f.r.agent.settings.conversation_engine = 'shadow';
  await f.run(decision(f.e.current_message.text, { intent: 'pricing_question' }));
  assert.equal(f.sent.length, 0);
  assert.equal((await db.pg.query('select * from crm_ai_leads where tenant_id=$1', [f.e.tenant_id])).rows.length, 0);
});
