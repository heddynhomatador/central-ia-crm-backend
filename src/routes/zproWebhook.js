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

function onlyDigits(value = '') {
  return String(value || '').replace(/\D/g, '');
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

  const text = String(
    payload.body ||
    payload.text ||
    message.conversation ||
    message?.extendedTextMessage?.text ||
    message?.imageMessage?.caption ||
    message?.videoMessage?.caption ||
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
    whatsappId: ticket.whatsappId ? String(ticket.whatsappId) : null,
    channelName: ticket?.whatsapp?.name || '',
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
          status: 'ai_attending',
          first_message_at: new Date().toISOString(),
          last_message_at: new Date().toISOString(),
          metadata: {
            whatsapp_id: parsed.whatsappId,
            channel_name: parsed.channelName,
          },
        })
        .select('*')
        .single();

      if (error) throw error;
      lead = data;
    } else {
      const { data, error } = await supabaseAdmin
        .from('crm_ai_leads')
        .update({
          name: parsed.name || lead.name,
          external_contact_id: parsed.contactId || lead.external_contact_id,
          external_ticket_id: parsed.ticketId || lead.external_ticket_id,
          last_message_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', lead.id)
        .select('*')
        .single();

      if (error) throw error;
      lead = data;
    }

    await supabaseAdmin
      .from('crm_ai_lead_events')
      .insert({
        tenant_id: integration.tenant_id,
        lead_id: lead.id,
        event_type: 'message_received',
        external_event_id: parsed.eventId,
        summary: parsed.text || '[mensagem sem texto]',
        payload: {
          parsed,
          raw: payload,
        },
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
      externalEventId: parsed.eventId,
      phone: parsed.phone,
      ticketId: parsed.ticketId,
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
