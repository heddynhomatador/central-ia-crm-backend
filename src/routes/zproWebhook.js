import express from 'express';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
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

    await supabaseAdmin
      .from('crm_ai_lead_events')
      .insert({
        tenant_id: integration.tenant_id,
        lead_id: lead.id,
        event_type: parsed.isAudio ? 'audio_received' : 'message_received',
        external_event_id: parsed.eventId,
        summary: parsed.isAudio
          ? '[audio recebido]'
          : parsed.text || '[mensagem sem texto]',
        payload: {
          parsed,
          raw: payload,
        },
      });

    if (parsed.isAudio && Number(leadMetadata.audio_message_count || 0) >= 2) {
      await supabaseAdmin
        .from('crm_ai_lead_events')
        .insert({
          tenant_id: integration.tenant_id,
          lead_id: lead.id,
          event_type: 'audio_repeat_detected',
          summary: 'Contato enviou audio novamente; pronto para regra de transferencia humana.',
          payload: {
            audio_message_count: leadMetadata.audio_message_count,
            safe_mode: true,
          },
        });
    }

    await supabaseAdmin
      .from('crm_ai_lead_events')
      .insert({
        tenant_id: integration.tenant_id,
        lead_id: lead.id,
        event_type: 'ai_shadow_decision',
        summary: 'Decisao registrada em modo seguro. Nenhuma resposta enviada ao WhatsApp.',
        payload: buildShadowDecision(parsed, leadMetadata),
      });

    const { data: existingOpportunity } = await supabaseAdmin
      .from('crm_ai_opportunities')
      .select('*')
      .eq('tenant_id', integration.tenant_id)
      .eq('lead_id', lead.id)
      .maybeSingle();

    let createdOpportunity = false;

    if (!existingOpportunity && integration.auto_create_opportunity) {
      const { data: opportunity, error: opportunityError } = await supabaseAdmin
        .from('crm_ai_opportunities')
        .insert({
          tenant_id: integration.tenant_id,
          lead_id: lead.id,
          integration_id: integration.id,
          title: `${lead.name || 'Lead ' + lead.phone} - WhatsApp`,
          pipeline_id: integration.pipeline_id || null,
          stage_id: integration.initial_stage_id || 'novo_lead',
          status: 'open',
          value: 33.40,
        })
        .select('*')
        .single();

      if (opportunityError) throw opportunityError;
      createdOpportunity = true;

      await supabaseAdmin
        .from('crm_ai_lead_events')
        .insert({
          tenant_id: integration.tenant_id,
          lead_id: lead.id,
          event_type: 'opportunity_created',
          summary: 'Oportunidade criada automaticamente',
          payload: {
            opportunity_id: opportunity.id,
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
    });

    return res.json({
      ok: true,
      mode: process.env.APP_MODE || 'shadow',
      lead_id: lead.id,
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
