import express from 'express';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logInfo } from '../lib/logging.js';
import { EngineStore, checked } from '../operations/store.js';
import { engineMode } from '../conversation/state.js';
import { normalizeInboundMessage } from '../inbound/normalizeInboundMessage.js';
import { zproWebhookRouter as legacyRouter, extractPayload, webhookIgnoreReason, normalizePayload, selectAgentForChannel } from './zproWebhookLegacy.js';

// Legacy exports remain available to compatibility tests and staged rollback.
export * from './zproWebhookLegacy.js';
export const zproWebhookRouter = express.Router();
const store = new EngineStore(supabaseAdmin);

zproWebhookRouter.post('/:webhookPublicId', async (req, res, next) => {
  try {
    const payload = normalizePayload(req);
    const parsed = extractPayload(payload);
    const ignored = webhookIgnoreReason(parsed);
    if (ignored) {
      logInfo('zpro.webhook.result', { status: 'ignored', reason: ignored, externalEventId: parsed.eventId, ticketId: parsed.ticketId });
      return res.json({ ok: true, ignored });
    }
    const integration = await checked(supabaseAdmin.from('crm_ai_integrations').select('*').eq('webhook_public_id', req.params.webhookPublicId).eq('active', true).maybeSingle());
    if (!integration) return res.status(404).json({ ok: false, error: 'Integracao ativa nao encontrada' });
    const agents = await checked(supabaseAdmin.from('crm_ai_agents').select('*').eq('tenant_id', integration.tenant_id).eq('enabled', true).order('created_at', { ascending: true }));
    const selected = selectAgentForChannel(agents, integration.id, parsed);
    if (selected.ignored) return res.json({ ok: true, ignored: selected.reason });
    const mode = engineMode(selected.agent);
    if (mode === 'legacy') return next();
    if (!parsed.ticketId) return res.status(422).json({ ok: false, error: 'Ticket obrigatorio no motor v2' });
    const envelope = normalizeInboundMessage(payload, { integration, agent: selected.agent }, parsed);
    const queuedEnvelope = { ...envelope, metadata: { ...envelope.metadata, engine_mode: mode } };
    logInfo('turn.received', { tenantId: integration.tenant_id, integrationId: integration.id, ticketId: parsed.ticketId, eventId: envelope.external_event_id });
    const result = await store.enqueue(queuedEnvelope);
    logInfo('turn.normalized', { turnId: result.id, duplicate: result.duplicate, mode });
    if (mode === 'shadow') return next();
    return res.status(200).json({ ok: true, queued: !result.duplicate, ...result });
  } catch (error) { next(error); }
});
zproWebhookRouter.use(legacyRouter);
