import express from 'express';
import OpenAI from 'openai';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { ZproService } from '../services/zproService.js';
import {
  getRawBodyForLog,
  logError,
  logInfo,
  logWarn,
  sanitizeHeaders,
  sanitizeObject,
} from '../lib/logging.js';

export const zproWebhookRouter = express.Router();

let optionalLeadColumnsAvailable = true;
let optionalLeadColumnsNextRetryAt = 0;
let ticketContextTableAvailable = true;
let ticketContextNextRetryAt = 0;
let openaiClient = null;

function onlyDigits(value = '') {
  return String(value || '').replace(/\D/g, '');
}

function parseTimestamp(value) {
  if (!value) return null;

  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    const millis = numeric > 9999999999 ? numeric : numeric * 1000;
    return new Date(millis).toISOString();
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function pickFirst(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function pickValue(item = {}, paths = []) {
  for (const path of paths) {
    const value = String(path)
      .split('.')
      .reduce((acc, key) => (acc && typeof acc === 'object' ? acc[key] : undefined), item);

    if (value !== undefined && value !== null && value !== '') return value;
  }

  return null;
}

function normalizeId(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function getMessageType(message = {}, payload = {}) {
  const explicit = pickFirst(
    payload.messageType,
    payload.type,
    payload.mediaType,
    payload.msg?.messageType,
  );

  if (explicit) return String(explicit);

  const knownTypes = [
    'audioMessage',
    'conversation',
    'extendedTextMessage',
    'imageMessage',
    'videoMessage',
    'documentMessage',
    'stickerMessage',
    'locationMessage',
    'contactMessage',
  ];

  return knownTypes.find((key) => message?.[key]) || 'unknown';
}

function detectAudioMessage(message = {}, payload = {}) {
  const messageType = normalizeText(getMessageType(message, payload));
  return Boolean(
    message?.audioMessage ||
    message?.pttMessage ||
    messageType.includes('audio') ||
    messageType.includes('ptt') ||
    messageType.includes('voice')
  );
}

function getTagNames(contact = {}) {
  const tags = Array.isArray(contact.tags) ? contact.tags : [];
  return tags
    .map((tag) => pickFirst(tag.name, tag.tag, tag.label, tag.title, tag))
    .filter(Boolean)
    .map(String);
}

function classifyContactType({ text, contact }) {
  const tagText = normalizeText(getTagNames(contact).join(' '));
  const searchableText = normalizeText(`${tagText} ${text}`);

  if (
    /\b(cliente|pos venda|pos-venda|suporte|financeiro|boleto|pagamento|segunda via|remarcar|agendamento|consulta|cancelamento)\b/.test(searchableText)
  ) {
    return 'customer';
  }

  if (
    /\b(comprar|contratar|preco|preco|valor|orcamento|plano|promocao|promo|quero saber|tenho interesse|interesse)\b/.test(searchableText)
  ) {
    return 'lead';
  }

  return 'unknown';
}

function normalizePayload(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body;
  }

  const raw = Buffer.isBuffer(req.body)
    ? req.body.toString('utf8')
    : String(req.body || req.rawBody || '');

  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    return { body: raw };
  }
}

function extractPayload(payload = {}) {
  const msg = payload.msg || {};
  const key = msg.key || {};
  const ticket = payload.ticket || {};
  const contact = ticket.contact || {};
  const message = msg.message || {};
  const messageType = getMessageType(message, payload);

  const text = String(
    payload.body ||
    payload.text ||
    message.conversation ||
    message?.extendedTextMessage?.text ||
    message?.imageMessage?.caption ||
    message?.videoMessage?.caption ||
    ticket.lastMessage ||
    ''
  );

  const phone = onlyDigits(
    contact.number ||
    key.sender_pn ||
    payload.number ||
    payload.phone ||
    ''
  );

  const fromMe = Boolean(
    key.fromMe === true ||
    payload.fromMe === true
  );

  const eventId = String(
    key.id ||
    payload.id ||
    payload.eventId ||
    `${ticket.id || phone || 'unknown'}-${Date.now()}`
  );

  return {
    method: String(payload.method || payload.event || payload.type || 'message'),
    eventId,
    fromMe,
    text,
    phone,
    name: contact.name || msg.pushName || '',
    contactId: contact.id ? String(contact.id) : null,
    ticketId: ticket.id ? String(ticket.id) : null,
    ticketProtocol: ticket.protocol ? String(ticket.protocol) : null,
    ticketStatus: ticket.status ? String(ticket.status) : null,
    whatsappId: ticket.whatsappId ? String(ticket.whatsappId) : null,
    channelId: pickFirst(ticket.channelId, ticket.whatsappId, payload.channelId, payload.whatsappId)
      ? String(pickFirst(ticket.channelId, ticket.whatsappId, payload.channelId, payload.whatsappId))
      : null,
    whatsappName: ticket?.whatsapp?.name || '',
    channelName: ticket?.whatsapp?.name || ticket.channel || '',
    channelType: ticket.channel || ticket?.whatsapp?.type || '',
    queueId: ticket.queueId ? String(ticket.queueId) : null,
    assignedExternalUserId: ticket.userId ? String(ticket.userId) : null,
    assignedExternalUserName: ticket?.user?.name || '',
    messageType,
    isAudio: detectAudioMessage(message, payload),
    contactType: classifyContactType({ text, contact }),
    messageAt: parseTimestamp(msg.messageTimestamp),
    ticketCreatedAt: parseTimestamp(ticket.createdAt),
    ticketUpdatedAt: parseTimestamp(ticket.updatedAt),
    rawTenantId: ticket.tenantId ? String(ticket.tenantId) : null,
  };
}

function getAgentChannelId(agent = {}) {
  return pickFirst(
    agent.settings?.channel_id,
    agent.settings?.whatsapp_id,
    agent.settings?.channel?.id,
    agent.settings?.whatsapp?.id,
  );
}

function agentMatchesChannel(agent = {}, parsed = {}) {
  const expectedId = normalizeId(getAgentChannelId(agent));
  if (!expectedId) return false;

  const actualIds = [
    parsed.whatsappId,
    parsed.channelId,
    parsed.channelName,
    parsed.whatsappName,
  ].map(normalizeId);

  return actualIds.includes(expectedId);
}

async function resolveWebhookAgent(tenantId, parsed = {}) {
  const { data, error } = await supabaseAdmin
    .from('crm_ai_agents')
    .select('id, name, enabled, settings, system_prompt, model, temperature, welcome_message, handoff_message, created_at')
    .eq('tenant_id', tenantId)
    .eq('enabled', true)
    .order('created_at', { ascending: true });

  if (error) throw error;

  const agents = data || [];
  if (agents.length === 0) {
    return { agent: null, ignored: false, reason: null };
  }

  const channelAgents = agents.filter((agent) => getAgentChannelId(agent));
  const matchedAgent = channelAgents.find((agent) => agentMatchesChannel(agent, parsed));
  if (matchedAgent) {
    return { agent: matchedAgent, ignored: false, reason: null };
  }

  if (channelAgents.length > 0) {
    return {
      agent: null,
      ignored: true,
      reason: 'Nenhum agente ativo configurado para este canal',
    };
  }

  return { agent: agents[0], ignored: false, reason: null };
}

async function createZproService(integration) {
  const { data: token, error } = await supabaseAdmin.rpc('crm_ai_service_get_zpro_token', {
    p_integration_id: integration.id,
  });

  if (error) throw error;

  return new ZproService({
    baseUrl: integration.base_url,
    token,
  });
}

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!openaiClient) openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openaiClient;
}

async function loadAgentActions(agentId) {
  if (!agentId) return [];

  const { data, error } = await supabaseAdmin
    .from('crm_ai_actions')
    .select('action_key, enabled, config')
    .eq('agent_id', agentId);

  if (error) throw error;
  return data || [];
}

function actionEnabled(actions = [], actionKey) {
  return actions.some((action) => action.action_key === actionKey && action.enabled === true);
}

function canExecuteAction(actions = [], actionKey) {
  return actions.length === 0 || actionEnabled(actions, actionKey);
}

function contextTtlHours() {
  return Math.min(72, Math.max(1, Number(process.env.AI_CONTEXT_TTL_HOURS || 24)));
}

function contextExpiresAt() {
  return new Date(Date.now() + contextTtlHours() * 60 * 60 * 1000).toISOString();
}

async function purgeExpiredTicketContext(tenantId) {
  if (!ticketContextTableAvailable && Date.now() < ticketContextNextRetryAt) return;

  try {
    const { error } = await supabaseAdmin
      .from('crm_ai_ticket_context')
      .delete()
      .eq('tenant_id', tenantId)
      .lt('expires_at', new Date().toISOString());

    if (error) throw error;
    ticketContextTableAvailable = true;
    ticketContextNextRetryAt = 0;
  } catch (err) {
    ticketContextTableAvailable = false;
    ticketContextNextRetryAt = Date.now() + 10 * 60 * 1000;
    logWarn('zpro.webhook.context_purge_skipped', {
      tenantId,
      error: err.message || String(err),
    });
  }
}

async function rememberTicketContext({
  tenantId,
  integrationId,
  leadId,
  ticketId,
  role,
  content,
  eventType,
  externalEventId = null,
  metadata = {},
}) {
  const trimmed = String(content || '').trim();
  if (!trimmed) return;
  if (!ticketContextTableAvailable && Date.now() < ticketContextNextRetryAt) return;

  try {
    const { error } = await supabaseAdmin
      .from('crm_ai_ticket_context')
      .insert({
        tenant_id: tenantId,
        integration_id: integrationId,
        lead_id: leadId,
        external_ticket_id: ticketId || null,
        role,
        content: trimmed.slice(0, 4000),
        event_type: eventType,
        external_event_id: externalEventId,
        metadata,
        expires_at: contextExpiresAt(),
      });

    if (error) throw error;
    ticketContextTableAvailable = true;
    ticketContextNextRetryAt = 0;
  } catch (err) {
    ticketContextTableAvailable = false;
    ticketContextNextRetryAt = Date.now() + 10 * 60 * 1000;
    logWarn('zpro.webhook.context_insert_skipped', {
      tenantId,
      leadId,
      ticketId,
      error: err.message || String(err),
    });
  }
}

function eventToContextRow(event = {}) {
  const role = event.event_type === 'ai_response_sent' ? 'assistant' : 'user';
  return {
    role,
    content: event.summary || event.payload?.parsed?.text || '',
    created_at: event.created_at,
    event_type: event.event_type,
  };
}

async function loadFallbackContext({ tenantId, leadId }) {
  const since = new Date(Date.now() - contextTtlHours() * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabaseAdmin
    .from('crm_ai_lead_events')
    .select('event_type, summary, payload, created_at')
    .eq('tenant_id', tenantId)
    .eq('lead_id', leadId)
    .in('event_type', ['message_received', 'audio_received', 'ai_response_sent'])
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(18);

  if (error) {
    logWarn('zpro.webhook.context_fallback_failed', {
      tenantId,
      leadId,
      error: error.message || String(error),
    });
    return [];
  }

  return (data || [])
    .map(eventToContextRow)
    .filter((row) => row.content)
    .reverse();
}

async function loadTicketContext({ tenantId, leadId, ticketId }) {
  if (!ticketContextTableAvailable && Date.now() < ticketContextNextRetryAt) {
    return loadFallbackContext({ tenantId, leadId });
  }

  try {
    let query = supabaseAdmin
      .from('crm_ai_ticket_context')
      .select('role, content, event_type, created_at')
      .eq('tenant_id', tenantId)
      .eq('lead_id', leadId)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(18);

    if (ticketId) query = query.eq('external_ticket_id', ticketId);

    const { data, error } = await query;
    if (error) throw error;

    ticketContextTableAvailable = true;
    ticketContextNextRetryAt = 0;

    const rows = (data || []).reverse();
    return rows.length > 0 ? rows : loadFallbackContext({ tenantId, leadId });
  } catch (err) {
    ticketContextTableAvailable = false;
    ticketContextNextRetryAt = Date.now() + 10 * 60 * 1000;
    logWarn('zpro.webhook.context_load_skipped', {
      tenantId,
      leadId,
      ticketId,
      error: err.message || String(err),
    });
    return loadFallbackContext({ tenantId, leadId });
  }
}

function recentUserMessageCount(context = [], windowMinutes = 3) {
  const since = Date.now() - windowMinutes * 60 * 1000;
  return context.filter((row) => {
    if (row.role !== 'user') return false;
    const createdAt = new Date(row.created_at).getTime();
    return Number.isFinite(createdAt) && createdAt >= since;
  }).length;
}

async function loadStageRoutingRules(integration) {
  const [rules, pipelines, stages, queues] = await Promise.all([
    supabaseAdmin
      .from('crm_ai_stage_assignment_rules')
      .select('*')
      .eq('tenant_id', integration.tenant_id)
      .eq('integration_id', integration.id)
      .eq('active', true),
    supabaseAdmin
      .from('crm_ai_zpro_pipelines_cache')
      .select('external_pipeline_id, name')
      .eq('tenant_id', integration.tenant_id)
      .eq('integration_id', integration.id),
    supabaseAdmin
      .from('crm_ai_zpro_stages_cache')
      .select('external_pipeline_id, external_stage_id, name, position')
      .eq('tenant_id', integration.tenant_id)
      .eq('integration_id', integration.id),
    supabaseAdmin
      .from('crm_ai_zpro_queues_cache')
      .select('external_queue_id, name')
      .eq('tenant_id', integration.tenant_id)
      .eq('integration_id', integration.id),
  ]);

  for (const result of [rules, pipelines, stages, queues]) {
    if (result.error) throw result.error;
  }

  const pipelineNameById = new Map((pipelines.data || []).map((item) => [item.external_pipeline_id, item.name]));
  const queueNameById = new Map((queues.data || []).map((item) => [item.external_queue_id, item.name]));
  const stageNameByKey = new Map(
    (stages.data || []).map((item) => [
      `${item.external_pipeline_id}:${item.external_stage_id}`,
      item.name,
    ]),
  );

  return (rules.data || [])
    .map((rule) => ({
      ...rule,
      pipeline_name: pipelineNameById.get(rule.external_pipeline_id) || rule.external_pipeline_id,
      stage_name: stageNameByKey.get(`${rule.external_pipeline_id}:${rule.external_stage_id}`) || rule.external_stage_id,
      queue_name: rule.external_queue_id ? queueNameById.get(rule.external_queue_id) || rule.external_queue_id : '',
    }))
    .filter((rule) => String(rule.routing_instruction || '').trim());
}

function routingRulesPrompt(rules = []) {
  if (rules.length === 0) return 'Nao ha regras de roteamento por etapa configuradas.';

  return rules.map((rule, index) => [
    `${index + 1}. Funil: ${rule.pipeline_name} (${rule.external_pipeline_id})`,
    `Etapa: ${rule.stage_name} (${rule.external_stage_id})`,
    rule.queue_name ? `Fila: ${rule.queue_name} (${rule.external_queue_id})` : 'Fila: nao definida',
    `Quando usar: ${rule.routing_instruction}`,
    rule.close_ticket_on_match ? 'Ao usar esta regra, encerrar o ticket.' : 'Ao usar esta regra, transferir para humano e parar a IA.',
    rule.handoff_message ? `Mensagem sugerida: ${rule.handoff_message}` : '',
  ].filter(Boolean).join(' | ')).join('\n');
}

async function insertLeadEvent({ tenantId, leadId, eventType, externalEventId = null, summary = '', payload = {} }) {
  const { error } = await supabaseAdmin
    .from('crm_ai_lead_events')
    .insert({
      tenant_id: tenantId,
      lead_id: leadId,
      event_type: eventType,
      external_event_id: externalEventId,
      summary,
      payload,
    });

  if (error) {
    logWarn('zpro.webhook.lead_event_failed', {
      tenantId,
      leadId,
      eventType,
      error: error.message || String(error),
    });
  }
}

function shouldRunLiveAi(agent = null) {
  if (!agent?.enabled) return false;
  if (String(process.env.APP_MODE || 'live').toLowerCase() !== 'live') return false;
  if (agent.settings?.safe_mode === true) return false;
  return true;
}

function buildAiSystemPrompt(agent = {}, actions = [], routingRules = []) {
  const settings = agent.settings || {};
  const allowedActions = actions
    .filter((action) => action.enabled)
    .map((action) => action.action_key)
    .join(', ') || 'nenhuma';

  return [
    agent.system_prompt || 'Atenda leads do WhatsApp de forma objetiva e profissional.',
    settings.voice_tone ? `Tom de voz: ${settings.voice_tone}` : '',
    settings.allowed_actions_description ? `Pode fazer: ${settings.allowed_actions_description}` : '',
    settings.forbidden_actions_description ? `Nao pode fazer: ${settings.forbidden_actions_description}` : '',
    `Acoes habilitadas no sistema: ${allowedActions}.`,
    'Regras de roteamento por etapa:',
    routingRulesPrompt(routingRules),
    'Responda em portugues do Brasil.',
    'Seja breve, natural e util.',
    'Nao use emojis.',
    'Nao invente informacoes, valores, prazos ou promessas.',
    'Nao diga que e uma IA, a menos que o cliente pergunte diretamente.',
    'Use o historico da conversa para nao reiniciar o atendimento a cada mensagem.',
    'Se o cliente pedir humano, atendente, suporte humano, cancelamento, reclamacao, financeiro, ou se a regra de etapa combinar claramente, escolha uma acao de transferencia/movimento.',
    'Se a duvida simples foi resolvida e nao precisa humano, pode escolher close_ticket somente quando a acao estiver habilitada.',
    'Retorne exclusivamente um JSON valido com as chaves: reply, action, pipeline_id, stage_id, queue_id, user_id, reason, confidence.',
    'Valores aceitos em action: reply, handoff, move_stage, close_ticket, stop_ai.',
    'Use strings vazias quando nao houver pipeline_id, stage_id, queue_id ou user_id.',
  ].filter(Boolean).join('\n');
}

function parseAiDecision(raw = '') {
  const text = String(raw || '').trim();
  if (!text) {
    return {
      reply: '',
      action: 'reply',
      pipeline_id: '',
      stage_id: '',
      queue_id: '',
      user_id: '',
      reason: 'Resposta vazia do modelo',
      confidence: 0,
    };
  }

  const cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    return {
      reply: String(parsed.reply || parsed.message || parsed.mensagem || '').trim(),
      action: String(parsed.action || parsed.acao || 'reply').trim() || 'reply',
      pipeline_id: String(parsed.pipeline_id || parsed.pipelineId || '').trim(),
      stage_id: String(parsed.stage_id || parsed.stageId || '').trim(),
      queue_id: String(parsed.queue_id || parsed.queueId || '').trim(),
      user_id: String(parsed.user_id || parsed.userId || '').trim(),
      reason: String(parsed.reason || parsed.motivo || '').trim(),
      confidence: Number(parsed.confidence ?? parsed.confianca ?? 0.5),
    };
  } catch {
    return {
      reply: text,
      action: 'reply',
      pipeline_id: '',
      stage_id: '',
      queue_id: '',
      user_id: '',
      reason: 'Modelo retornou texto livre',
      confidence: 0.3,
    };
  }
}

function contextToPrompt(context = []) {
  if (context.length === 0) return 'Sem historico anterior.';

  return context
    .slice(-18)
    .map((row) => {
      const who = row.role === 'assistant' ? 'IA' : row.role === 'system' ? 'Sistema' : 'Cliente';
      return `${who}: ${String(row.content || '').slice(0, 800)}`;
    })
    .join('\n');
}

async function generateAiDecision({ agent, actions, parsed, lead, context, routingRules, spamRisk }) {
  const client = getOpenAIClient();
  if (!client) throw new Error('OPENAI_API_KEY ausente no backend');

  const request = {
    model: agent.model || process.env.DEFAULT_OPENAI_MODEL || 'gpt-4o-mini',
    temperature: Number(agent.temperature ?? 0.3),
    max_tokens: 420,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: buildAiSystemPrompt(agent, actions, routingRules),
      },
      {
        role: 'user',
        content: [
          `Nome do contato: ${lead.name || parsed.name || 'nao informado'}`,
          `Telefone: ${lead.phone || parsed.phone}`,
          `Canal: ${parsed.channelName || parsed.whatsappName || 'nao informado'}`,
          `Status do ticket no Z-PRO: ${parsed.ticketStatus || 'nao informado'}`,
          `Risco de muitas mensagens em pouco tempo: ${spamRisk ? 'sim' : 'nao'}`,
          'Historico recente:',
          contextToPrompt(context),
          `Mensagem recebida agora: ${parsed.text || '[sem texto]'}`,
        ].join('\n'),
      },
    ],
  };

  let completion;
  try {
    completion = await client.chat.completions.create(request);
  } catch (err) {
    if (!/response_format|json/i.test(err.message || '')) throw err;
    const fallbackRequest = { ...request };
    delete fallbackRequest.response_format;
    completion = await client.chat.completions.create(fallbackRequest);
  }

  return parseAiDecision(completion.choices?.[0]?.message?.content || '');
}

function audioReplyFor(agent = {}, leadMetadata = {}) {
  const policy = agent.settings?.audio_policy || {};
  const mode = policy.mode || 'ask_once_then_transfer';
  const message = policy.message || 'Por enquanto nao consigo ouvir audio por aqui. Pode me mandar por texto?';
  const audioCount = Number(leadMetadata.audio_message_count || 0);

  if (mode === 'transfer_to_human') {
    return {
      shouldReply: Boolean(agent.handoff_message || message),
      text: agent.handoff_message || message,
      shouldTransfer: true,
    };
  }

  if (mode === 'ask_once_then_transfer' && audioCount >= 2) {
    return {
      shouldReply: Boolean(agent.handoff_message || message),
      text: agent.handoff_message || message,
      shouldTransfer: true,
    };
  }

  return {
    shouldReply: true,
    text: message,
    shouldTransfer: false,
  };
}

async function maybeTransferAudioTicket({ zpro, agent, actions, parsed, lead, leadMetadata, integration }) {
  const policy = agent?.settings?.audio_policy || {};
  const queueId = policy.transfer_queue_id;
  if (!parsed.ticketId || !queueId || !canExecuteAction(actions, 'transfer_ticket')) return null;

  const audioDecision = audioReplyFor(agent, leadMetadata);
  if (!audioDecision.shouldTransfer) return null;

  try {
    const result = await zpro.updateTicketAssignment({
      ticketId: parsed.ticketId,
      queueId,
      status: 'pending',
    });

    await insertLeadEvent({
      tenantId: integration.tenant_id,
      leadId: lead.id,
      eventType: 'zpro_ticket_transferred',
      summary: 'Ticket transferido por regra de audio.',
      payload: {
        ticket_id: parsed.ticketId,
        queue_id: queueId,
        endpoint: result.endpoint,
        data: result.data,
      },
    });

    return {
      ...result,
      externalOpportunityId,
    };
  } catch (err) {
    await insertLeadEvent({
      tenantId: integration.tenant_id,
      leadId: lead.id,
      eventType: 'zpro_ticket_transfer_failed',
      summary: 'Falha ao transferir ticket por regra de audio.',
      payload: {
        ticket_id: parsed.ticketId,
        queue_id: queueId,
        error: err.message || String(err),
        attempts: err.attempts,
      },
    });
    return null;
  }
}

function humanRequestDetected(text = '') {
  return /\b(humano|atendente|pessoa|alguem|falar com|me liga|ligar|suporte humano|consultor|vendedor|gerente)\b/i
    .test(normalizeText(text));
}

function aiStateStopped(metadata = {}, parsed = {}) {
  const state = metadata.ai_state || {};
  if (!state.stopped) return false;
  if (state.ticket_id && parsed.ticketId && String(state.ticket_id) !== String(parsed.ticketId)) return false;
  return true;
}

function ticketAutomationBlockReason(parsed = {}, metadata = {}) {
  const status = normalizeId(parsed.ticketStatus);
  if (status === 'open') return 'ticket_open_human';
  if (status === 'closed') return 'ticket_closed';
  if (aiStateStopped(metadata, parsed)) return metadata.ai_state?.reason || 'ai_stopped_for_ticket';
  return null;
}

function defaultHandoffMessage(agent = {}) {
  return agent.handoff_message ||
    'Vou encaminhar seu atendimento para nossa equipe. Eles vao continuar com voce.';
}

function getOpportunityExternalId(opportunity = {}) {
  return pickFirst(
    opportunity.external_opportunity_id,
    opportunity.raw_data?.external_opportunity_id,
    getExternalOpportunityId(opportunity.raw_data?.zpro_create_response || {}),
  );
}

function findRoutingRule(decision = {}, routingRules = []) {
  const pipelineId = normalizeId(decision.pipeline_id);
  const stageId = normalizeId(decision.stage_id);
  if (!pipelineId && !stageId) return null;

  return routingRules.find((rule) => {
    const pipelineMatches = !pipelineId || normalizeId(rule.external_pipeline_id) === pipelineId;
    const stageMatches = !stageId || normalizeId(rule.external_stage_id) === stageId;
    return pipelineMatches && stageMatches;
  }) || null;
}

async function selectRuleUser(rule = null) {
  if (!rule || !Array.isArray(rule.user_order) || rule.user_order.length === 0) return null;

  const index = Math.max(0, Number(rule.round_robin_cursor || 0)) % rule.user_order.length;
  const userId = String(rule.user_order[index] || '').trim();
  if (!userId) return null;

  await supabaseAdmin
    .from('crm_ai_stage_assignment_rules')
    .update({
      round_robin_cursor: (index + 1) % rule.user_order.length,
      updated_at: new Date().toISOString(),
    })
    .eq('id', rule.id);

  return userId;
}

async function markLeadAiStopped({ lead, parsed, reason, status = 'human_handoff', extra = {} }) {
  const metadata = {
    ...(lead.metadata || {}),
    ai_state: {
      ...(lead.metadata?.ai_state || {}),
      stopped: true,
      reason,
      ticket_id: parsed.ticketId || lead.external_ticket_id || null,
      stopped_at: new Date().toISOString(),
      ...extra,
    },
  };

  const { data, error } = await supabaseAdmin
    .from('crm_ai_leads')
    .update({
      status,
      metadata,
      updated_at: new Date().toISOString(),
    })
    .eq('id', lead.id)
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

async function updateLocalOpportunityStage({ opportunity, pipelineId, stageId, rawPatch = {} }) {
  if (!opportunity?.id) return opportunity;

  const payload = {
    pipeline_id: pipelineId || opportunity.pipeline_id,
    stage_id: stageId || opportunity.stage_id,
    raw_data: {
      ...(opportunity.raw_data || {}),
      ...rawPatch,
    },
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabaseAdmin
    .from('crm_ai_opportunities')
    .update(payload)
    .eq('id', opportunity.id)
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

async function ensureLocalOpportunityForAction({ integration, lead, opportunity, pipelineId, stageId }) {
  if (opportunity?.id) return opportunity;
  if (!pipelineId && !stageId) return opportunity;

  const { data, error } = await supabaseAdmin
    .from('crm_ai_opportunities')
    .insert({
      tenant_id: integration.tenant_id,
      lead_id: lead.id,
      integration_id: integration.id,
      title: `${lead.name || 'Lead ' + lead.phone} - WhatsApp`,
      pipeline_id: pipelineId || integration.pipeline_id || null,
      stage_id: stageId || integration.initial_stage_id || 'novo_lead',
      status: 'open',
      value: 0,
      raw_data: {
        created_by_ai_route: true,
        created_by_ai_route_at: new Date().toISOString(),
      },
    })
    .select('*')
    .single();

  if (error) throw error;

  await insertLeadEvent({
    tenantId: integration.tenant_id,
    leadId: lead.id,
    eventType: 'opportunity_created',
    summary: 'Oportunidade criada por regra da IA',
    payload: {
      opportunity_id: data.id,
      pipeline_id: data.pipeline_id,
      stage_id: data.stage_id,
    },
  });

  return data;
}

async function recordAiActionFailure({ integration, lead, action, step, err, extra = {} }) {
  await insertLeadEvent({
    tenantId: integration.tenant_id,
    leadId: lead.id,
    eventType: 'ai_action_failed',
    summary: `Falha na acao ${action}: ${step}`,
    payload: {
      step,
      error: err.message || String(err),
      attempts: err.attempts,
      ...extra,
    },
  });

  logWarn('zpro.webhook.ai_action_failed', {
    integrationId: integration.id,
    tenantId: integration.tenant_id,
    leadId: lead.id,
    action,
    step,
    error: err.message || String(err),
  });
}

async function createExternalOpportunityForRoute({
  zpro,
  integration,
  parsed,
  lead,
  opportunity,
  pipelineId,
  stageId,
  userId,
  reason,
}) {
  const result = await zpro.createOpportunity({
    number: lead.phone || parsed.phone,
    contactName: lead.name || parsed.name || lead.phone || parsed.phone,
    name: opportunity?.title || `${lead.name || 'Lead ' + lead.phone} - WhatsApp`,
    value: opportunity?.value ?? 0,
    status: 'open',
    pipelineId,
    stageId,
    responsibleId: userId || parsed.assignedExternalUserId || undefined,
    description: reason || parsed.text || 'Oportunidade criada por regra da IA.',
    validateNumber: true,
  });

  const externalOpportunityId = getExternalOpportunityId(result.data);
  if (opportunity?.id) {
    const rawData = {
      ...(opportunity.raw_data || {}),
      zpro_route_create_attempted_at: new Date().toISOString(),
      zpro_route_create_endpoint: result.endpoint,
      zpro_route_create_response: sanitizeObject(result.data),
    };
    const updatePayload = {
      raw_data: rawData,
      updated_at: new Date().toISOString(),
    };
    if (externalOpportunityId) {
      updatePayload.external_opportunity_id = String(externalOpportunityId);
    }

    await supabaseAdmin
      .from('crm_ai_opportunities')
      .update(updatePayload)
      .eq('id', opportunity.id);
  }

  await insertLeadEvent({
    tenantId: integration.tenant_id,
    leadId: lead.id,
    eventType: 'zpro_opportunity_created',
    summary: 'Oportunidade criada no Z-PRO por regra da IA.',
    payload: {
      endpoint: result.endpoint,
      external_opportunity_id: externalOpportunityId,
      pipeline_id: pipelineId,
      stage_id: stageId,
      data: sanitizeObject(result.data),
    },
  });

  return {
    result,
    externalOpportunityId,
  };
}

async function executeAiDecision({ zpro, integration, agent, actions, parsed, lead, opportunity, decision, routingRules }) {
  let action = String(decision?.action || 'reply').toLowerCase();
  const rule = findRoutingRule(decision, routingRules);
  if (rule?.close_ticket_on_match) action = 'close_ticket';
  if (rule?.stop_ai_after_match !== false && action === 'move_stage') action = 'handoff';

  if (!['handoff', 'move_stage', 'close_ticket', 'stop_ai'].includes(action)) {
    return { executed: false, action };
  }

  const targetPipelineId = decision.pipeline_id || rule?.external_pipeline_id || opportunity?.pipeline_id || integration.pipeline_id || '';
  const targetStageId = decision.stage_id || rule?.external_stage_id || opportunity?.stage_id || integration.initial_stage_id || '';
  const targetQueueId = decision.queue_id || rule?.external_queue_id || integration.sales_queue_id || parsed.queueId || '';
  const targetUserId = decision.user_id || await selectRuleUser(rule);
  const result = {
    executed: false,
    action,
    rule_id: rule?.id || null,
    pipeline_id: targetPipelineId || null,
    stage_id: targetStageId || null,
    queue_id: targetQueueId || null,
    user_id: targetUserId || null,
    opportunity: null,
    opportunity_error: null,
    ticket: null,
    ticket_error: null,
    local_ai_stopped: false,
  };

  if (action === 'handoff' || action === 'close_ticket' || action === 'stop_ai') {
    lead = await markLeadAiStopped({
      lead,
      parsed,
      reason: action === 'close_ticket' ? 'ticket_closed_by_ai' : 'human_handoff_by_ai',
      status: action === 'close_ticket' ? 'closed' : 'human_handoff',
      extra: {
        action,
        rule_id: rule?.id || null,
        pipeline_id: targetPipelineId || null,
        stage_id: targetStageId || null,
        queue_id: targetQueueId || null,
        user_id: targetUserId || null,
      },
    });
    result.local_ai_stopped = true;
  }

  if (action === 'move_stage' || action === 'handoff') {
    const canMove = canExecuteAction(actions, 'update_opportunity');

    try {
      opportunity = await ensureLocalOpportunityForAction({
        integration,
        lead,
        opportunity,
        pipelineId: targetPipelineId,
        stageId: targetStageId,
      });

      let externalOpportunityId = getOpportunityExternalId(opportunity);
      let createdExternalAtTarget = false;
      if (!externalOpportunityId && canExecuteAction(actions, 'create_opportunity') && targetPipelineId && targetStageId) {
        const created = await createExternalOpportunityForRoute({
          zpro,
          integration,
          parsed,
          lead,
          opportunity,
          pipelineId: targetPipelineId,
          stageId: targetStageId,
          userId: targetUserId,
          reason: decision.reason,
        });
        externalOpportunityId = created.externalOpportunityId;
        result.opportunity = created.result;
        createdExternalAtTarget = true;
      }

      if (!createdExternalAtTarget && canMove && externalOpportunityId && targetPipelineId && targetStageId) {
        result.opportunity = await zpro.moveOpportunity({
          opportunityId: externalOpportunityId,
          name: opportunity?.title,
          value: opportunity?.value,
          status: 'open',
          pipelineId: targetPipelineId,
          stageId: targetStageId,
          responsibleId: targetUserId || undefined,
          description: decision.reason || undefined,
        });
      }

      if (targetPipelineId || targetStageId) {
        opportunity = await updateLocalOpportunityStage({
          opportunity,
          pipelineId: targetPipelineId,
          stageId: targetStageId,
          rawPatch: {
            ai_last_route_at: new Date().toISOString(),
            ai_last_route_reason: decision.reason || '',
            ai_last_route_rule_id: rule?.id || null,
            ai_last_route_external_result: sanitizeObject(result.opportunity?.data || {}),
          },
        });
      }
    } catch (err) {
      result.opportunity_error = err.message || String(err);
      await recordAiActionFailure({
        integration,
        lead,
        action,
        step: 'opportunity_route',
        err,
        extra: {
          pipeline_id: targetPipelineId || null,
          stage_id: targetStageId || null,
        },
      });
    }
  }

  if (action === 'handoff' || action === 'close_ticket' || action === 'stop_ai') {
    const ticketStatus = action === 'close_ticket' ? 'closed' : 'open';
    const actionKey = action === 'close_ticket' ? 'close_ticket' : 'transfer_ticket';

    if (parsed.ticketId && canExecuteAction(actions, actionKey)) {
      try {
        result.ticket = await zpro.updateTicketAssignment({
          ticketId: parsed.ticketId,
          queueId: action === 'close_ticket' ? null : targetQueueId || null,
          userId: action === 'close_ticket' ? null : targetUserId || null,
          status: ticketStatus,
          chatgptStatus: false,
          typebotStatus: false,
          dialogflowStatus: false,
          difyStatus: false,
          n8nStatus: false,
        });
      } catch (err) {
        result.ticket_error = err.message || String(err);
        await recordAiActionFailure({
          integration,
          lead,
          action,
          step: 'ticket_update',
          err,
          extra: {
            ticket_id: parsed.ticketId,
            queue_id: action === 'close_ticket' ? null : targetQueueId || null,
            user_id: action === 'close_ticket' ? null : targetUserId || null,
            status: ticketStatus,
          },
        });
      }
    } else if (parsed.ticketId) {
      result.ticket_error = `Acao ${actionKey} desabilitada`;
    } else {
      result.ticket_error = 'Payload sem ticketId';
    }
  }

  result.executed = Boolean(result.local_ai_stopped || result.opportunity || result.ticket || action === 'stop_ai');

  await insertLeadEvent({
    tenantId: integration.tenant_id,
    leadId: lead.id,
    eventType: 'ai_action_executed',
    summary: `Acao da IA: ${action}`,
    payload: sanitizeObject({
      decision,
      result,
    }),
  });

  await rememberTicketContext({
    tenantId: integration.tenant_id,
    integrationId: integration.id,
    leadId: lead.id,
    ticketId: parsed.ticketId,
    role: 'system',
    content: `Acao executada: ${action}. Motivo: ${decision.reason || 'sem motivo informado'}`,
    eventType: 'ai_action_executed',
    metadata: sanitizeObject(result),
  });

  return result;
}

async function maybeSendAiReply({ zpro, integration, agent, actions, parsed, lead, leadMetadata, opportunity }) {
  if (!shouldRunLiveAi(agent)) {
    await insertLeadEvent({
      tenantId: integration.tenant_id,
      leadId: lead.id,
      eventType: 'ai_response_skipped',
      summary: 'IA nao respondeu porque o modo seguro esta ativo ou o backend nao esta em live.',
      payload: {
        app_mode: process.env.APP_MODE || 'live',
        safe_mode: agent?.settings?.safe_mode,
        agent_id: agent?.id || null,
      },
    });
    return null;
  }

  const blockReason = ticketAutomationBlockReason(parsed, leadMetadata);
  if (blockReason) {
    await markLeadAiStopped({
      lead,
      parsed,
      reason: blockReason,
      status: blockReason === 'ticket_closed' ? 'closed' : 'human_handoff',
    });
    await insertLeadEvent({
      tenantId: integration.tenant_id,
      leadId: lead.id,
      eventType: 'ai_response_skipped',
      summary: 'IA nao respondeu porque o ticket nao esta pendente para automacao.',
      payload: {
        ticket_status: parsed.ticketStatus,
        reason: blockReason,
      },
    });
    return null;
  }

  try {
    const context = await loadTicketContext({
      tenantId: integration.tenant_id,
      leadId: lead.id,
      ticketId: parsed.ticketId,
    });
    const settings = agent.settings || {};
    const spamPolicy = settings.spam_policy || {};
    const spamWindowMinutes = Number(spamPolicy.window_minutes || 3);
    const spamMaxMessages = Number(spamPolicy.max_messages || 5);
    const spamRisk = recentUserMessageCount(context, spamWindowMinutes) >= spamMaxMessages;
    const routingRules = await loadStageRoutingRules(integration);
    let reply = '';
    let decision = null;
    if (parsed.isAudio) {
      const audioDecision = audioReplyFor(agent, leadMetadata);
      reply = audioDecision.shouldReply ? audioDecision.text : '';
      await maybeTransferAudioTicket({ zpro, agent, actions, parsed, lead, leadMetadata, integration });
      decision = {
        reply,
        action: audioDecision.shouldTransfer ? 'handoff' : 'reply',
        reason: parsed.isAudio ? 'audio recebido' : '',
      };
    } else if (spamRisk) {
      decision = {
        reply: defaultHandoffMessage(agent),
        action: 'handoff',
        pipeline_id: '',
        stage_id: '',
        queue_id: integration.sales_queue_id || '',
        user_id: '',
        reason: 'Muitas mensagens em pouco tempo',
        confidence: 1,
      };
      reply = decision.reply;
    } else if (humanRequestDetected(parsed.text)) {
      decision = {
        reply: defaultHandoffMessage(agent),
        action: 'handoff',
        pipeline_id: '',
        stage_id: '',
        queue_id: integration.sales_queue_id || '',
        user_id: '',
        reason: 'Cliente pediu atendimento humano ou assunto sensivel',
        confidence: 1,
      };
      reply = decision.reply;
    } else {
      decision = await generateAiDecision({ agent, actions, parsed, lead, context, routingRules, spamRisk });
      reply = decision.reply;
    }

    const decisionRule = findRoutingRule(decision || {}, routingRules);
    if (decisionRule && decision?.action && decision.action !== 'reply') {
      if (decisionRule.handoff_message) reply = decisionRule.handoff_message;
      if (!reply) reply = defaultHandoffMessage(agent);
      decision.reply = reply;
    }

    if (!reply) return null;

    const result = await zpro.sendMessage({
      number: lead.phone || parsed.phone,
      body: reply,
    });

    await insertLeadEvent({
      tenantId: integration.tenant_id,
      leadId: lead.id,
      eventType: 'ai_response_sent',
      summary: reply,
      payload: {
        agent_id: agent.id,
        endpoint: result.endpoint || 'base',
        data: result,
      },
    });

    await rememberTicketContext({
      tenantId: integration.tenant_id,
      integrationId: integration.id,
      leadId: lead.id,
      ticketId: parsed.ticketId,
      role: 'assistant',
      content: reply,
      eventType: 'ai_response_sent',
      metadata: {
        agent_id: agent.id,
        decision,
      },
    });

    let actionResult = null;
    if (decision && decision.action && decision.action !== 'reply') {
      try {
        actionResult = await executeAiDecision({
          zpro,
          integration,
          agent,
          actions,
          parsed,
          lead,
          opportunity,
          decision,
          routingRules,
        });
      } catch (actionError) {
        await insertLeadEvent({
          tenantId: integration.tenant_id,
          leadId: lead.id,
          eventType: 'ai_action_failed',
          summary: 'Falha ao executar acao decidida pela IA.',
          payload: {
            decision,
            error: actionError.message || String(actionError),
            attempts: actionError.attempts,
          },
        });

        logWarn('zpro.webhook.ai_action_failed', {
          integrationId: integration.id,
          tenantId: integration.tenant_id,
          leadId: lead.id,
          action: decision.action,
          error: actionError.message || String(actionError),
        });
      }
    }

    return { reply, result, decision, actionResult };
  } catch (err) {
    await insertLeadEvent({
      tenantId: integration.tenant_id,
      leadId: lead.id,
      eventType: 'ai_response_failed',
      summary: 'Falha ao gerar ou enviar resposta da IA.',
      payload: {
        agent_id: agent?.id || null,
        error: err.message || String(err),
        attempts: err.attempts,
      },
    });

    logWarn('zpro.webhook.ai_response_failed', {
      integrationId: integration.id,
      tenantId: integration.tenant_id,
      leadId: lead.id,
      error: err.message || String(err),
    });

    return null;
  }
}

function getExternalOpportunityId(data = {}) {
  return pickValue(data, [
    'id',
    'opportunityId',
    'opportunity_id',
    'data.id',
    'data.opportunityId',
    'data.opportunity_id',
    'opportunity.id',
  ]);
}

async function maybeCreateExternalOpportunity({ zpro, integration, actions, parsed, lead, opportunity }) {
  if (!integration.auto_create_opportunity) return null;
  if (!integration.pipeline_id || !integration.initial_stage_id) return null;
  if (actions.length > 0 && !actionEnabled(actions, 'create_opportunity')) return null;

  try {
    const result = await zpro.createOpportunity({
      number: lead.phone || parsed.phone,
      contactName: lead.name || parsed.name || lead.phone || parsed.phone,
      name: opportunity?.title || `${lead.name || 'Lead ' + lead.phone} - WhatsApp`,
      value: opportunity?.value ?? 0,
      status: 'open',
      pipelineId: integration.pipeline_id,
      stageId: integration.initial_stage_id,
      responsibleId: parsed.assignedExternalUserId || undefined,
      description: parsed.text || 'Oportunidade criada automaticamente pela Central IA CRM.',
      validateNumber: true,
    });

    const externalOpportunityId = getExternalOpportunityId(result.data);
    if (opportunity?.id) {
      const rawData = {
        ...(opportunity.raw_data || {}),
        zpro_create_attempted_at: new Date().toISOString(),
        zpro_create_endpoint: result.endpoint,
        zpro_create_response: sanitizeObject(result.data),
      };
      const updatePayload = {
        raw_data: rawData,
        updated_at: new Date().toISOString(),
      };
      if (externalOpportunityId) {
        updatePayload.external_opportunity_id = String(externalOpportunityId);
      }

      await supabaseAdmin
        .from('crm_ai_opportunities')
        .update(updatePayload)
        .eq('id', opportunity.id);
    }

    await insertLeadEvent({
      tenantId: integration.tenant_id,
      leadId: lead.id,
      eventType: 'zpro_opportunity_created',
      summary: 'Oportunidade criada no Z-PRO.',
      payload: {
        endpoint: result.endpoint,
        external_opportunity_id: externalOpportunityId,
        data: sanitizeObject(result.data),
      },
    });

    return result;
  } catch (err) {
    await insertLeadEvent({
      tenantId: integration.tenant_id,
      leadId: lead.id,
      eventType: 'zpro_opportunity_create_failed',
      summary: 'Falha ao criar oportunidade no Z-PRO.',
      payload: {
        error: err.message || String(err),
        attempts: err.attempts,
        pipeline_id: integration.pipeline_id,
        stage_id: integration.initial_stage_id,
      },
    });

    logWarn('zpro.webhook.opportunity_create_failed', {
      integrationId: integration.id,
      tenantId: integration.tenant_id,
      leadId: lead.id,
      error: err.message || String(err),
    });

    return null;
  }
}

function buildLeadMetadata(parsed, previous = {}, agent = null) {
  const audioCount = Number(previous?.audio_message_count || 0) + (parsed.isAudio ? 1 : 0);
  const now = new Date().toISOString();
  const previousAiState = previous?.ai_state || {};
  const ticketChanged = previousAiState.ticket_id && parsed.ticketId && String(previousAiState.ticket_id) !== String(parsed.ticketId);
  let aiState = ticketChanged ? {} : previousAiState;
  const ticketStatus = normalizeId(parsed.ticketStatus);

  if (ticketStatus === 'open' || ticketStatus === 'closed') {
    aiState = {
      ...aiState,
      stopped: true,
      reason: ticketStatus === 'closed' ? 'ticket_closed' : 'ticket_open_human',
      ticket_id: parsed.ticketId || previousAiState.ticket_id || null,
      stopped_at: aiState.stopped_at || now,
    };
  }

  return {
    ...previous,
    zpro: {
      ...(previous?.zpro || {}),
      ticket_id: parsed.ticketId,
      ticket_protocol: parsed.ticketProtocol,
      ticket_status: parsed.ticketStatus,
      contact_id: parsed.contactId,
      whatsapp_id: parsed.whatsappId,
      channel_id: parsed.channelId,
      whatsapp_name: parsed.whatsappName,
      channel_name: parsed.channelName,
      channel_type: parsed.channelType,
      queue_id: parsed.queueId,
      assigned_external_user_id: parsed.assignedExternalUserId,
      assigned_external_user_name: parsed.assignedExternalUserName,
      tenant_id: parsed.rawTenantId,
      last_event_id: parsed.eventId,
      last_message_type: parsed.messageType,
      last_message_at: parsed.messageAt,
      ticket_created_at: parsed.ticketCreatedAt,
      ticket_updated_at: parsed.ticketUpdatedAt,
    },
    ai_agent_id: agent?.id || previous?.ai_agent_id || null,
    ai_agent_name: agent?.name || previous?.ai_agent_name || null,
    ai_state: aiState,
    whatsapp_id: parsed.whatsappId,
    ticket_status: parsed.ticketStatus,
    channel_name: parsed.channelName,
    channel_type: parsed.channelType,
    queue_id: parsed.queueId,
    assigned_external_user_id: parsed.assignedExternalUserId,
    assigned_external_user_name: parsed.assignedExternalUserName,
    contact_type: previous?.contact_type && previous.contact_type !== 'unknown'
      ? previous.contact_type
      : parsed.contactType,
    audio_message_count: audioCount,
    last_audio_at: parsed.isAudio ? new Date().toISOString() : previous?.last_audio_at,
    last_message_type: parsed.messageType,
    last_inbound_event_id: parsed.eventId,
  };
}

async function syncOptionalLeadColumns(lead, parsed, metadata) {
  if (!optionalLeadColumnsAvailable && Date.now() < optionalLeadColumnsNextRetryAt) return;

  try {
    const { error } = await supabaseAdmin
      .from('crm_ai_leads')
      .update({
        contact_type: metadata.contact_type || 'unknown',
        audio_message_count: metadata.audio_message_count || 0,
        last_audio_at: metadata.last_audio_at || null,
      })
      .eq('id', lead.id);

    if (error) throw error;
    optionalLeadColumnsAvailable = true;
    optionalLeadColumnsNextRetryAt = 0;
  } catch (err) {
    optionalLeadColumnsAvailable = false;
    optionalLeadColumnsNextRetryAt = Date.now() + 10 * 60 * 1000;
    logWarn('zpro.webhook.optional_columns_skipped', {
      leadId: lead.id,
      reason: 'Colunas opcionais de enriquecimento ainda nao existem. Rode a migration incremental para habilitar.',
      error: err.message || String(err),
    });
  }
}

function buildShadowDecision(parsed, metadata) {
  if (parsed.isAudio && Number(metadata.audio_message_count || 0) >= 2) {
    return {
      acao: 'transferir',
      mensagem: '',
      tipo_contato: metadata.contact_type || 'unknown',
      motivo_transferencia: 'audio',
      fila_destino: null,
      funil_destino: null,
      etapa_destino: null,
      confianca: 0.6,
      modo_seguro: true,
      observacao: 'Sugestao apenas registrada. Nenhuma acao foi executada no Z-PRO.',
    };
  }

  return {
    acao: 'ignorar',
    mensagem: '',
    tipo_contato: metadata.contact_type || 'unknown',
    motivo_transferencia: null,
    fila_destino: null,
    funil_destino: null,
    etapa_destino: null,
    confianca: 0.2,
    modo_seguro: true,
    observacao: 'Modo seguro ativo. IA ainda nao responde nem executa acoes.',
  };
}

async function findIntegrationByWebhookPublicId(webhookPublicId, { activeOnly = false } = {}) {
  let query = supabaseAdmin
    .from('crm_ai_integrations')
    .select('*')
    .eq('webhook_public_id', webhookPublicId);

  if (activeOnly) query = query.eq('active', true);

  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data;
}

function logWebhookReceived(req, webhookPublicId, payload) {
  logInfo('zpro.webhook.received', {
    requestId: req.requestId,
    method: req.method,
    route: req.originalUrl,
    webhookPublicId,
    headers: sanitizeHeaders(req.headers),
    rawBody: getRawBodyForLog(req),
    payloadPreview: sanitizeObject(payload),
  });
}

function logWebhookResult(req, webhookPublicId, result) {
  logInfo('zpro.webhook.result', {
    requestId: req.requestId,
    method: req.method,
    route: req.originalUrl,
    webhookPublicId,
    ...result,
  });
}

zproWebhookRouter.get('/:webhookPublicId/ping', async (req, res, next) => {
  try {
    const { webhookPublicId } = req.params;
    const integration = await findIntegrationByWebhookPublicId(webhookPublicId);

    logInfo('zpro.webhook.ping', {
      requestId: req.requestId,
      webhookPublicId,
      integrationFound: Boolean(integration),
      integrationActive: Boolean(integration?.active),
    });

    return res.json({
      ok: true,
      webhookPublicId,
      integrationFound: Boolean(integration),
      integrationActive: Boolean(integration?.active),
    });
  } catch (err) {
    next(err);
  }
});

zproWebhookRouter.post('/:webhookPublicId', async (req, res, next) => {
  try {
    const { webhookPublicId } = req.params;
    const payload = normalizePayload(req);
    const parsed = extractPayload(payload);

    logWebhookReceived(req, webhookPublicId, payload);

    if (parsed.fromMe) {
      logWebhookResult(req, webhookPublicId, {
        status: 'ignored',
        reason: 'Mensagem enviada pelo sistema',
        parsed,
      });

      return res.json({
        ok: true,
        ignored: 'Mensagem enviada pelo sistema',
      });
    }

    if (!parsed.phone) {
      logWebhookResult(req, webhookPublicId, {
        status: 'ignored',
        reason: 'Payload sem telefone',
        parsed,
      });

      return res.json({
        ok: true,
        ignored: 'Payload sem telefone',
      });
    }

    const integration = await findIntegrationByWebhookPublicId(webhookPublicId, {
      activeOnly: true,
    });

    if (!integration) {
      const inactiveOrMissingIntegration = await findIntegrationByWebhookPublicId(webhookPublicId);

      logWarn('zpro.webhook.integration_not_found', {
        requestId: req.requestId,
        webhookPublicId,
        integrationFound: Boolean(inactiveOrMissingIntegration),
        integrationActive: Boolean(inactiveOrMissingIntegration?.active),
        parsed,
      });

      return res.status(404).json({
        ok: false,
        error: 'Integracao ativa nao encontrada pelo webhook_public_id',
        integrationFound: Boolean(inactiveOrMissingIntegration),
        integrationActive: Boolean(inactiveOrMissingIntegration?.active),
      });
    }

    logInfo('zpro.webhook.integration_found', {
      requestId: req.requestId,
      webhookPublicId,
      integrationId: integration.id,
      tenantId: integration.tenant_id,
      active: integration.active,
    });

    await purgeExpiredTicketContext(integration.tenant_id);

    const agentResolution = await resolveWebhookAgent(integration.tenant_id, parsed);

    if (agentResolution.ignored) {
      logWebhookResult(req, webhookPublicId, {
        status: 'ignored',
        reason: agentResolution.reason,
        integrationId: integration.id,
        tenantId: integration.tenant_id,
        channelId: parsed.channelId,
        whatsappId: parsed.whatsappId,
        channelName: parsed.channelName,
      });

      return res.json({
        ok: true,
        ignored: agentResolution.reason,
      });
    }

    const { error: webhookError } = await supabaseAdmin
      .from('crm_ai_webhook_events')
      .insert({
        tenant_id: integration.tenant_id,
        integration_id: integration.id,
        external_event_id: parsed.eventId,
        event_type: parsed.method,
        payload,
        processing_status: 'processed',
        attempts: 1,
        processed_at: new Date().toISOString(),
      });

    if (webhookError && webhookError.code !== '23505') {
      throw webhookError;
    }

    if (webhookError?.code === '23505') {
      logWebhookResult(req, webhookPublicId, {
        status: 'ignored',
        reason: 'Evento duplicado',
        integrationId: integration.id,
        tenantId: integration.tenant_id,
        externalEventId: parsed.eventId,
      });

      return res.json({
        ok: true,
        ignored: 'Evento duplicado',
      });
    }

    const actions = await loadAgentActions(agentResolution.agent?.id);
    let zpro = null;
    async function getZpro() {
      if (!zpro) zpro = await createZproService(integration);
      return zpro;
    }

    let lead = null;

    if (parsed.ticketId) {
      const { data } = await supabaseAdmin
        .from('crm_ai_leads')
        .select('*')
        .eq('integration_id', integration.id)
        .eq('external_ticket_id', parsed.ticketId)
        .maybeSingle();

      lead = data;
    }

    if (!lead) {
      const { data } = await supabaseAdmin
        .from('crm_ai_leads')
        .select('*')
        .eq('tenant_id', integration.tenant_id)
        .eq('phone', parsed.phone)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      lead = data;
    }

    if (!lead) {
      const metadata = buildLeadMetadata(parsed, {}, agentResolution.agent);

      const { data, error } = await supabaseAdmin
        .from('crm_ai_leads')
        .insert({
          tenant_id: integration.tenant_id,
          integration_id: integration.id,
          name: parsed.name || null,
          phone: parsed.phone,
          source: 'whatsapp',
          external_contact_id: parsed.contactId,
          external_ticket_id: parsed.ticketId,
          assigned_external_user_id: parsed.assignedExternalUserId,
          status: 'ai_attending',
          first_message_at: new Date().toISOString(),
          last_message_at: new Date().toISOString(),
          metadata,
        })
        .select('*')
        .single();

      if (error) throw error;
      lead = data;
    } else {
      const metadata = buildLeadMetadata(parsed, lead.metadata || {}, agentResolution.agent);

      const { data, error } = await supabaseAdmin
        .from('crm_ai_leads')
        .update({
          name: parsed.name || lead.name,
          external_contact_id: parsed.contactId || lead.external_contact_id,
          external_ticket_id: parsed.ticketId || lead.external_ticket_id,
          assigned_external_user_id: parsed.assignedExternalUserId || lead.assigned_external_user_id,
          last_message_at: new Date().toISOString(),
          metadata,
          updated_at: new Date().toISOString(),
        })
        .eq('id', lead.id)
        .select('*')
        .single();

      if (error) throw error;
      lead = data;
    }

    const leadMetadata = lead.metadata || buildLeadMetadata(parsed, {}, agentResolution.agent);
    await syncOptionalLeadColumns(lead, parsed, leadMetadata);

    await insertLeadEvent({
      tenantId: integration.tenant_id,
      leadId: lead.id,
      eventType: parsed.isAudio ? 'audio_received' : 'message_received',
      externalEventId: parsed.eventId,
      summary: parsed.isAudio
        ? '[audio recebido]'
        : parsed.text || '[mensagem sem texto]',
      payload: {
        parsed,
        raw: payload,
      },
    });

    await rememberTicketContext({
      tenantId: integration.tenant_id,
      integrationId: integration.id,
      leadId: lead.id,
      ticketId: parsed.ticketId,
      role: 'user',
      content: parsed.isAudio ? '[audio recebido]' : parsed.text || '[mensagem sem texto]',
      eventType: parsed.isAudio ? 'audio_received' : 'message_received',
      externalEventId: parsed.eventId,
      metadata: {
        ticket_status: parsed.ticketStatus,
        channel_id: parsed.channelId,
        whatsapp_id: parsed.whatsappId,
      },
    });

    if (parsed.isAudio && Number(leadMetadata.audio_message_count || 0) >= 2) {
      await insertLeadEvent({
        tenantId: integration.tenant_id,
        leadId: lead.id,
        eventType: 'audio_repeat_detected',
        summary: 'Contato enviou audio novamente; pronto para regra de transferencia humana.',
        payload: {
          audio_message_count: leadMetadata.audio_message_count,
          safe_mode: agentResolution.agent?.settings?.safe_mode !== false,
        },
      });
    }

    await insertLeadEvent({
      tenantId: integration.tenant_id,
      leadId: lead.id,
      eventType: 'ai_shadow_decision',
      summary: 'Decisao registrada para auditoria.',
      payload: buildShadowDecision(parsed, leadMetadata),
    });

    const { data: existingOpportunity } = await supabaseAdmin
      .from('crm_ai_opportunities')
      .select('*')
      .eq('tenant_id', integration.tenant_id)
      .eq('lead_id', lead.id)
      .maybeSingle();

    let createdOpportunity = false;
    let opportunity = existingOpportunity || null;

    if (!existingOpportunity && integration.auto_create_opportunity) {
      const { data: localOpportunity, error: opportunityError } = await supabaseAdmin
        .from('crm_ai_opportunities')
        .insert({
          tenant_id: integration.tenant_id,
          lead_id: lead.id,
          integration_id: integration.id,
          title: `${lead.name || 'Lead ' + lead.phone} - WhatsApp`,
          pipeline_id: integration.pipeline_id || null,
          stage_id: integration.initial_stage_id || 'novo_lead',
          status: 'open',
          value: 0,
        })
        .select('*')
        .single();

      if (opportunityError) throw opportunityError;
      createdOpportunity = true;
      opportunity = localOpportunity;

      await insertLeadEvent({
        tenantId: integration.tenant_id,
        leadId: lead.id,
        eventType: 'opportunity_created',
        summary: 'Oportunidade criada automaticamente',
        payload: {
          opportunity_id: opportunity.id,
          pipeline_id: opportunity.pipeline_id,
          stage_id: opportunity.stage_id,
        },
      });
    }

    if (
      opportunity &&
      !opportunity.external_opportunity_id &&
      !opportunity.raw_data?.zpro_create_attempted_at
    ) {
      try {
        const createdExternalOpportunity = await maybeCreateExternalOpportunity({
          zpro: await getZpro(),
          integration,
          actions,
          parsed,
          lead,
          opportunity,
        });
        if (createdExternalOpportunity?.externalOpportunityId) {
          opportunity = {
            ...opportunity,
            external_opportunity_id: String(createdExternalOpportunity.externalOpportunityId),
          };
        }
      } catch (err) {
        await insertLeadEvent({
          tenantId: integration.tenant_id,
          leadId: lead.id,
          eventType: 'zpro_opportunity_create_failed',
          summary: 'Falha ao preparar cliente Z-PRO para criar oportunidade.',
          payload: {
            error: err.message || String(err),
          },
        });
      }
    }

    let aiResult = null;
    try {
      aiResult = await maybeSendAiReply({
        zpro: shouldRunLiveAi(agentResolution.agent) ? await getZpro() : null,
        integration,
        agent: agentResolution.agent,
        actions,
        parsed,
        lead,
        leadMetadata,
        opportunity,
      });
    } catch (err) {
      await insertLeadEvent({
        tenantId: integration.tenant_id,
        leadId: lead.id,
        eventType: 'ai_response_failed',
        summary: 'Falha ao preparar cliente Z-PRO para resposta da IA.',
        payload: {
          error: err.message || String(err),
        },
      });
    }

    logWebhookResult(req, webhookPublicId, {
      status: 'processed',
      integrationId: integration.id,
      tenantId: integration.tenant_id,
      leadId: lead.id,
      agentId: agentResolution.agent?.id || null,
      agentName: agentResolution.agent?.name || null,
      externalEventId: parsed.eventId,
      phone: parsed.phone,
      ticketId: parsed.ticketId,
      contactType: leadMetadata.contact_type,
      isAudio: parsed.isAudio,
      audioMessageCount: leadMetadata.audio_message_count,
      createdOpportunity,
      aiReplySent: Boolean(aiResult?.reply),
      aiAction: aiResult?.decision?.action || null,
      aiActionExecuted: Boolean(aiResult?.actionResult?.executed),
      aiLocalStopped: Boolean(aiResult?.actionResult?.local_ai_stopped),
      aiTicketError: aiResult?.actionResult?.ticket_error || null,
      aiOpportunityError: aiResult?.actionResult?.opportunity_error || null,
    });

    return res.json({
      ok: true,
      mode: process.env.APP_MODE || 'live',
      lead_id: lead.id,
      createdOpportunity,
      aiReplySent: Boolean(aiResult?.reply),
      aiAction: aiResult?.decision?.action || null,
      aiActionExecuted: Boolean(aiResult?.actionResult?.executed),
      aiLocalStopped: Boolean(aiResult?.actionResult?.local_ai_stopped),
      message: 'Webhook processado e salvo no Supabase.',
    });
  } catch (err) {
    logError('zpro.webhook.result', {
      requestId: req.requestId,
      method: req.method,
      route: req.originalUrl,
      status: 'failed',
      error: err.message || String(err),
    });
    next(err);
  }
});
