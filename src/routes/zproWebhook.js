import express from 'express';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';

export const zproWebhookRouter = express.Router();

function onlyDigits(value = '') {
  return String(value || '').replace(/\D/g, '');
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
    method: String(payload.method || payload.event || 'message'),
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

zproWebhookRouter.post('/:webhookPublicId', async (req, res, next) => {
  try {
    const { webhookPublicId } = req.params;
    const payload = req.body || {};
    const parsed = extractPayload(payload);

    if (parsed.fromMe) {
      return res.json({
        ok: true,
        ignored: 'Mensagem enviada pelo sistema',
      });
    }

    if (!parsed.phone) {
      return res.json({
        ok: true,
        ignored: 'Payload sem telefone',
      });
    }

    const { data: integration, error: integrationError } = await supabaseAdmin
      .from('crm_ai_integrations')
      .select('*')
      .eq('webhook_public_id', webhookPublicId)
      .eq('active', true)
      .maybeSingle();

    if (integrationError) throw integrationError;

    if (!integration) {
      return res.status(404).json({
        ok: false,
        error: 'Integração não encontrada pelo webhook_public_id',
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

    return res.json({
      ok: true,
      mode: process.env.APP_MODE || 'shadow',
      lead_id: lead.id,
      message: 'Webhook processado e salvo no Supabase.',
    });

  } catch (err) {
    next(err);
  }
});