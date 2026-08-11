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
    .select('id, name, enabled, settings, created_at')
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

function buildAiSystemPrompt(agent = {}, actions = []) {
  const settings = agent.settings || {};
  const allowedActions = actions
    .filter((action) => action.enabled)
    .map((action) => action.action_key)
    .join(', ') || 'nenhuma';

  return [
    agent.system_prompt || 'Atenda leads do WhatsApp de forma objetiva e profissional.',
    settings.goal ? `Objetivo do atendimento: ${settings.goal}` : '',
    settings.voice_tone ? `Tom de voz: ${settings.voice_tone}` : '',
    settings.allowed_actions_description ? `Pode fazer: ${settings.allowed_actions_description}` : '',
    settings.forbidden_actions_description ? `Nao pode fazer: ${settings.forbidden_actions_description}` : '',
    `Acoes habilitadas no sistema: ${allowedActions}.`,
    'Responda em portugues do Brasil.',
    'Seja breve, natural e util.',
    'Nao invente informacoes, valores, prazos ou promessas.',
    'Nao diga que e uma IA, a menos que o cliente pergunte diretamente.',
    'Se faltar contexto, faca uma pergunta simples para avancar o atendimento.',
  ].filter(Boolean).join('\n');
}

async function generateAiReply({ agent, actions, parsed, lead }) {
  const client = getOpenAIClient();
  if (!client) throw new Error('OPENAI_API_KEY ausente no backend');

  const completion = await client.chat.completions.create({
    model: agent.model || process.env.DEFAULT_OPENAI_MODEL || 'gpt-4o-mini',
    temperature: Number(agent.temperature ?? 0.3),
    max_tokens: 260,
    messages: [
      {
        role: 'system',
        content: buildAiSystemPrompt(agent, actions),
      },
      {
        role: 'user',
        content: [
          `Nome do contato: ${lead.name || parsed.name || 'nao informado'}`,
          `Telefone: ${lead.phone || parsed.phone}`,
          `Mensagem recebida: ${parsed.text || '[sem texto]'}`,
          `Canal: ${parsed.channelName || parsed.whatsappName || 'nao informado'}`,
        ].join('\n'),
      },
    ],
  });

  return String(completion.choices?.[0]?.message?.content || '').trim();
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
  if (!parsed.ticketId || !queueId || !actionEnabled(actions, 'transfer_ticket')) return null;

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

    return result;
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

async function maybeSendAiReply({ zpro, integration, agent, actions, parsed, lead, leadMetadata }) {
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

  try {
    let reply = '';
    if (parsed.isAudio) {
      const audioDecision = audioReplyFor(agent, leadMetadata);
      reply = audioDecision.shouldReply ? audioDecision.text : '';
      await maybeTransferAudioTicket({ zpro, agent, actions, parsed, lead, leadMetadata, integration });
    } else {
      reply = await generateAiReply({ agent, actions, parsed, lead });
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

    return { reply, result };
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

  return {
    ...previous,
    zpro: {
      ...(previous?.zpro || {}),
      ticket_id: parsed.ticketId,
      ticket_protocol: parsed.ticketProtocol,
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
    whatsapp_id: parsed.whatsappId,
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
        await maybeCreateExternalOpportunity({
          zpro: await getZpro(),
          integration,
          actions,
          parsed,
          lead,
          opportunity,
        });
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
    });

    return res.json({
      ok: true,
      mode: process.env.APP_MODE || 'live',
      lead_id: lead.id,
      createdOpportunity,
      aiReplySent: Boolean(aiResult?.reply),
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
