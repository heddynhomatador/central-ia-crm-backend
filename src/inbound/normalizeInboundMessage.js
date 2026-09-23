import { createHash } from 'node:crypto';

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

// The compatibility parser supplies message transport fields, never intent.
export function normalizeInboundMessage(payload, scope, parsed) {
  const msg = payload.msg || {};
  const message = msg.message || payload.message || {};
  const context = message.extendedTextMessage?.contextInfo || msg.contextInfo || {};
  const eventId = msg.key?.id || msg.id || msg.messageId || msg.wamid || payload.eventId || payload.id;
  const timestamp = msg.messageTimestamp || msg.timestamp || payload.messageTimestamp || payload.timestamp;
  if (!eventId && !timestamp) throw Object.assign(new Error('Webhook sem identidade estavel'), { code: 'INBOUND_IDENTITY_MISSING' });
  const stableId = eventId || createHash('sha256').update(JSON.stringify([
    scope.integration.id, parsed.ticketId, timestamp, parsed.messageType, parsed.text,
  ])).digest('hex');
  return freeze({
    integration_id: scope.integration.id,
    tenant_id: scope.integration.tenant_id,
    agent_id: scope.agent.id,
    ticket_id: String(parsed.ticketId || ''),
    contact_id: parsed.contactId,
    external_event_id: String(stableId),
    current_message: {
      text: String(parsed.text || '').slice(0, 16000), type: parsed.messageType,
      timestamp: parsed.messageAt, from_customer: !parsed.fromMe,
    },
    quoted_message: context.quotedMessage ? { content: context.quotedMessage, source: 'quoted_message' } : null,
    ad_context: context.externalAdReply || msg.referral || payload.referral || null,
    metadata: { channel_id: parsed.channelId || parsed.whatsappId, channel_type: parsed.channelType,
      phone: parsed.phone, contact_name: parsed.name, event_type: parsed.method, is_audio: parsed.isAudio },
    ticket_context: { status: parsed.ticketStatus, user_id: parsed.assignedExternalUserId,
      queue_id: parsed.queueId, last_message: String((payload.ticket || msg.ticket)?.lastMessage || '').slice(0, 2000) },
  });
}

export function mergeCurrentMessages(turns) {
  const last = turns.at(-1).envelope;
  return freeze({ ...last, current_message: { ...last.current_message,
    text: turns.map((t) => t.envelope.current_message.text).filter(Boolean).join('\n'),
  }, external_event_ids: turns.map((t) => t.external_event_id) });
}
