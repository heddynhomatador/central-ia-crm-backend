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

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

const DEFAULT_SCHEDULE_HOURS = {
  0: [],
  1: [['09:00', '12:00'], ['13:00', '18:00']],
  2: [['09:00', '12:00'], ['13:00', '18:00']],
  3: [['09:00', '12:00'], ['13:00', '18:00']],
  4: [['09:00', '12:00'], ['13:00', '18:00']],
  5: [['09:00', '12:00'], ['13:00', '18:00']],
  6: [],
};

function validTime(value = '') {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''));
}

function normalizedSchedulePolicy(input = {}) {
  const policy = input && typeof input === 'object' ? input : {};
  const hours = {};

  for (let day = 0; day <= 6; day += 1) {
    const rawIntervals = policy.business_hours?.[day] || policy.business_hours?.[String(day)] || DEFAULT_SCHEDULE_HOURS[day];
    hours[day] = (Array.isArray(rawIntervals) ? rawIntervals : [])
      .map((interval) => Array.isArray(interval) ? interval : [interval?.start, interval?.end])
      .filter((interval) => validTime(interval?.[0]) && validTime(interval?.[1]) && interval[0] < interval[1])
      .map((interval) => [String(interval[0]), String(interval[1])]);
  }

  return {
    enabled: policy.enabled === true,
    timezone: String(policy.timezone || 'America/Sao_Paulo'),
    duration_minutes: boundedNumber(policy.duration_minutes, 60, 15, 480),
    buffer_minutes: boundedNumber(policy.buffer_minutes, 15, 0, 240),
    advance_notice_minutes: boundedNumber(policy.advance_notice_minutes, 60, 0, 10080),
    horizon_days: boundedNumber(policy.horizon_days, 21, 1, 90),
    business_hours: hours,
  };
}

function normalizeExternalList(data) {
  const keys = ['appointments', 'items', 'results', 'rows', 'records', 'data'];
  const visited = new Set();

  function visit(value, depth = 0) {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== 'object' || depth > 4 || visited.has(value)) return [];
    visited.add(value);

    for (const key of keys) {
      if (Array.isArray(value[key])) return value[key];
    }
    for (const key of keys) {
      const nested = visit(value[key], depth + 1);
      if (nested.length > 0) return nested;
    }
    return [];
  }

  return visit(data);
}

let appointmentSchedulingQueue = Promise.resolve();

async function withAppointmentSchedulingLock(task) {
  const previous = appointmentSchedulingQueue;
  let release;
  appointmentSchedulingQueue = new Promise((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    return await task();
  } finally {
    release();
  }
}

function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}

function localDateKey(date, timeZone) {
  const parts = zonedParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addDaysToDateKey(dateKey, days) {
  const base = new Date(`${dateKey}T12:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

function zonedDateTimeToUtc(dateKey, time, timeZone) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || !validTime(time)) return null;
  const [year, month, day] = dateKey.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const desiredUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let candidate = new Date(desiredUtc);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const actual = zonedParts(candidate, timeZone);
    const actualAsUtc = Date.UTC(
      Number(actual.year),
      Number(actual.month) - 1,
      Number(actual.day),
      Number(actual.hour),
      Number(actual.minute),
      Number(actual.second),
    );
    candidate = new Date(candidate.getTime() + (desiredUtc - actualAsUtc));
  }

  return candidate;
}

function timeMinutes(value = '') {
  if (!validTime(value)) return null;
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function appointmentPeriod(item = {}) {
  const startValue = pickValue(item, [
    'startAt',
    'start_at',
    'start',
    'data.startAt',
    'appointment.startAt',
  ]);
  const endValue = pickValue(item, [
    'endAt',
    'end_at',
    'end',
    'data.endAt',
    'appointment.endAt',
  ]);
  const start = startValue ? new Date(startValue) : null;
  const end = endValue ? new Date(endValue) : null;
  if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return { start, end };
}

async function loadBusyAppointments(zpro, start, end) {
  const filters = {
    page: 1,
    limit: 200,
    startFrom: start.toISOString(),
    startTo: end.toISOString(),
  };
  const responses = await Promise.all([
    zpro.listAppointments({ ...filters, status: 'pending' }),
    zpro.listAppointments({ ...filters, status: 'confirmed' }),
  ]);

  const periods = responses
    .flatMap((response) => normalizeExternalList(response.data))
    .map(appointmentPeriod)
    .filter(Boolean);

  return { periods, responses };
}

function slotIsFree(start, end, busyPeriods = [], bufferMinutes = 0) {
  const bufferMs = bufferMinutes * 60 * 1000;
  return !busyPeriods.some((busy) => (
    start.getTime() < busy.end.getTime() + bufferMs &&
    end.getTime() + bufferMs > busy.start.getTime()
  ));
}

function slotInsideBusinessHours(dateKey, time, durationMinutes, policy) {
  const day = new Date(`${dateKey}T12:00:00.000Z`).getUTCDay();
  const startMinute = timeMinutes(time);
  if (startMinute === null) return false;
  return (policy.business_hours[day] || []).some(([from, to]) => {
    const fromMinute = timeMinutes(from);
    const toMinute = timeMinutes(to);
    return startMinute >= fromMinute && startMinute + durationMinutes <= toMinute;
  });
}

function formatAppointmentSlot(date, timeZone) {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date).replace(',', '');
}

async function findAvailableAppointmentSlots({ zpro, policy, from = new Date(), limit = 3 }) {
  const minimumStart = new Date(from.getTime() + policy.advance_notice_minutes * 60 * 1000);
  const firstDateKey = localDateKey(minimumStart, policy.timezone);
  const windowEnd = zonedDateTimeToUtc(
    addDaysToDateKey(firstDateKey, policy.horizon_days),
    '23:59',
    policy.timezone,
  );
  const { periods } = await loadBusyAppointments(zpro, minimumStart, windowEnd);
  const slots = [];
  const stepMinutes = Math.max(15, policy.duration_minutes + policy.buffer_minutes);

  for (let offset = 0; offset <= policy.horizon_days && slots.length < limit; offset += 1) {
    const dateKey = addDaysToDateKey(firstDateKey, offset);
    const day = new Date(`${dateKey}T12:00:00.000Z`).getUTCDay();
    for (const [fromTime, toTime] of policy.business_hours[day] || []) {
      const fromMinute = timeMinutes(fromTime);
      const toMinute = timeMinutes(toTime);
      for (let minute = fromMinute; minute + policy.duration_minutes <= toMinute; minute += stepMinutes) {
        const hour = String(Math.floor(minute / 60)).padStart(2, '0');
        const minuteText = String(minute % 60).padStart(2, '0');
        const start = zonedDateTimeToUtc(dateKey, `${hour}:${minuteText}`, policy.timezone);
        const end = new Date(start.getTime() + policy.duration_minutes * 60 * 1000);
        if (start < minimumStart) continue;
        if (!slotIsFree(start, end, periods, policy.buffer_minutes)) continue;
        slots.push({ start, end, dateKey, time: `${hour}:${minuteText}` });
        if (slots.length >= limit) break;
      }
      if (slots.length >= limit) break;
    }
  }

  return slots;
}

function findAppointmentRule(decision = {}, routingRules = []) {
  const exact = findRoutingRule(decision, routingRules);
  if (exact) return exact;

  return routingRules.find((rule) => (
    /\b(reuniao|agendamento|agendada|agendado|demonstracao|demo|consulta)\b/i.test(normalizeText([
      rule.stage_name,
      rule.pipeline_name,
      rule.routing_instruction,
    ].join(' ')))
  )) || null;
}

async function applyAppointmentWorkflow({ zpro, agent, actions, parsed, lead, decision, routingRules }) {
  if (!decision?.appointment_intent) return { decision, rule: null, appointment: null };

  const policy = normalizedSchedulePolicy(agent.settings?.schedule_policy);
  if (!policy.enabled || !canExecuteAction(actions, 'schedule_appointment')) {
    return {
      decision: {
        ...decision,
        action: 'reply',
        pipeline_id: '',
        stage_id: '',
        queue_id: '',
        user_id: '',
        reply: 'Posso te ajudar a escolher o melhor horario, mas o agendamento automatico ainda nao esta habilitado.',
        reason: 'Agendamento automatico desabilitado',
      },
      rule: null,
      appointment: null,
    };
  }

  const dateKey = String(decision.appointment_date || '').trim();
  const time = String(decision.appointment_time || '').trim();
  const hasExactSlot = /^\d{4}-\d{2}-\d{2}$/.test(dateKey) && validTime(time);

  if (!decision.appointment_confirmed || !hasExactSlot) {
    const slots = await findAvailableAppointmentSlots({ zpro, policy });
    const options = slots.map((slot) => formatAppointmentSlot(slot.start, policy.timezone));
    return {
      decision: {
        ...decision,
        action: 'reply',
        pipeline_id: '',
        stage_id: '',
        queue_id: '',
        user_id: '',
        appointment_confirmed: false,
        reply: options.length > 0
          ? `Tenho estes horarios livres: ${options.join(', ')}. Qual deles fica melhor para voce?`
          : 'Nao encontrei horario livre na agenda agora. Qual dia e periodo voce prefere para eu verificar?',
        reason: 'Coletando data e horario antes de criar o compromisso',
      },
      rule: null,
      appointment: { status: 'collecting', options },
    };
  }

  const start = zonedDateTimeToUtc(dateKey, time, policy.timezone);
  const end = start ? new Date(start.getTime() + policy.duration_minutes * 60 * 1000) : null;
  const minimumStart = new Date(Date.now() + policy.advance_notice_minutes * 60 * 1000);
  const insideHours = start && end && slotInsideBusinessHours(dateKey, time, policy.duration_minutes, policy);

  let created = null;
  if (start && end && start >= minimumStart && insideHours) {
    created = await withAppointmentSchedulingLock(async () => {
      const dayStart = zonedDateTimeToUtc(dateKey, '00:00', policy.timezone);
      const dayEnd = zonedDateTimeToUtc(dateKey, '23:59', policy.timezone);
      const { periods } = await loadBusyAppointments(zpro, dayStart, dayEnd);
      if (!slotIsFree(start, end, periods, policy.buffer_minutes)) return null;

      const title = decision.appointment_title || `Reuniao com ${lead.name || parsed.name || lead.phone || parsed.phone}`;
      const response = await zpro.createAppointment({
        title,
        description: decision.reason || 'Agendamento criado pela Central IA CRM.',
        contactId: parsed.contactId || lead.external_contact_id,
        contactName: lead.name || parsed.name || lead.phone || parsed.phone,
        contactPhone: lead.phone || parsed.phone,
        whatsappId: parsed.whatsappId || parsed.channelId,
        startAt: start.toISOString(),
        endAt: end.toISOString(),
        status: 'confirmed',
        notes: `Criado automaticamente pelo agente ${agent.name || agent.id}. Ticket ${parsed.ticketId || 'nao informado'}.`,
      });
      return { response, title };
    });
  }

  if (!created) {
    const slots = await findAvailableAppointmentSlots({ zpro, policy, from: start && start > new Date() ? start : new Date() });
    const options = slots.map((slot) => formatAppointmentSlot(slot.start, policy.timezone));
    return {
      decision: {
        ...decision,
        action: 'reply',
        pipeline_id: '',
        stage_id: '',
        queue_id: '',
        user_id: '',
        appointment_confirmed: false,
        reply: options.length > 0
          ? `Esse horario nao esta disponivel. Posso marcar em ${options.join(', ')}. Qual voce prefere?`
          : 'Esse horario nao esta disponivel. Me diga outro dia ou periodo para eu verificar.',
        reason: 'Horario fora da agenda, com pouca antecedencia ou em conflito',
      },
      rule: null,
      appointment: { status: 'conflict', options },
    };
  }

  const { response: appointmentResponse, title } = created;
  const rule = findAppointmentRule(decision, routingRules);
  const confirmation = `Agendamento confirmado para ${formatAppointmentSlot(start, policy.timezone)}.`;
  const shouldHandoff = rule?.stop_ai_after_match === true;
  const handoffText = shouldHandoff ? rule.handoff_message || defaultHandoffMessage(agent) : '';

  return {
    decision: {
      ...decision,
      action: shouldHandoff ? 'handoff' : rule ? 'move_stage' : 'reply',
      pipeline_id: rule?.external_pipeline_id || '',
      stage_id: rule?.external_stage_id || '',
      queue_id: rule?.external_queue_id || '',
      user_id: '',
      reply: [confirmation, handoffText].filter(Boolean).join(' '),
      reason: `Compromisso criado no Z-PRO: ${decision.reason || title}`,
      appointment_created: true,
      appointment_start_at: start.toISOString(),
      appointment_end_at: end.toISOString(),
      appointment_endpoint: appointmentResponse.endpoint,
    },
    rule,
    appointment: {
      status: 'created',
      endpoint: appointmentResponse.endpoint,
      data: sanitizeObject(appointmentResponse.data),
      start_at: start.toISOString(),
      end_at: end.toISOString(),
    },
  };
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
  if (!Array.isArray(actions) || actions.length === 0) return true;
  const matchingActions = actions.filter((action) => action.action_key === actionKey);
  if (matchingActions.length === 0) return true;
  return matchingActions.some((action) => action.enabled === true);
}

function leadStopStatusFor(reasonOrAction = '') {
  const value = normalizeId(reasonOrAction);
  return value.includes('closed') || value.includes('close') ? 'archived' : 'transferred';
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
    metadata: event.payload || {},
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
      .select('role, content, event_type, created_at, metadata')
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

function recentUserBurstCount(context = [], windowMinutes = 3) {
  const since = Date.now() - windowMinutes * 60 * 1000;
  let count = 0;

  for (const row of [...context].reverse()) {
    const createdAt = new Date(row.created_at).getTime();
    if (!Number.isFinite(createdAt) || createdAt < since) break;
    if (row.role === 'assistant') break;
    if (row.role === 'system' && /ai_response|ai_action/i.test(row.event_type || '')) break;
    if (row.role === 'user') count += 1;
  }

  return count;
}

function contextShowsAiHandoff(context = []) {
  const latestAction = [...context].reverse().find((row) => row.event_type === 'ai_action_executed');
  if (latestAction?.metadata?.action === 'handoff' && latestAction?.metadata?.ticket_verified === false) {
    return false;
  }

  return context.some((row) => {
    const action = normalizeId(row.metadata?.decision?.action || row.metadata?.result?.action || row.metadata?.action || '');
    if (['handoff', 'close_ticket', 'stop_ai'].includes(action)) return true;
    if (row.event_type === 'ai_action_executed') return false;
    if (row.role !== 'assistant' && row.role !== 'system') return false;
    return /\b(encaminhar|transferir|transferencia|atendimento para nossa equipe|setor de relacionamento|humano)\b/i
      .test(normalizeText(row.content));
  });
}

function isStopAction(action = '') {
  return ['handoff', 'close_ticket', 'stop_ai'].includes(normalizeId(action));
}

function applyRoutingRuleToDecision(decision = {}, rule = null, agent = {}) {
  if (!rule) return decision;

  let action = normalizeId(decision.action);
  if (!['reply', 'handoff', 'move_stage', 'close_ticket', 'stop_ai', 'schedule_appointment'].includes(action)) {
    action = 'move_stage';
  }
  if (action === 'reply') action = 'move_stage';
  if (rule.close_ticket_on_match) action = 'close_ticket';

  const shouldStop = isStopAction(action);

  return {
    ...decision,
    reply: shouldStop
      ? rule.handoff_message || decision.reply || defaultHandoffMessage(agent)
      : decision.reply || '',
    action,
    pipeline_id: rule.external_pipeline_id || decision.pipeline_id || '',
    stage_id: rule.external_stage_id || decision.stage_id || '',
    queue_id: rule.external_queue_id || decision.queue_id || '',
    reason: decision.reason || `Regra de etapa: ${rule.stage_name || rule.external_stage_id}`,
    confidence: Math.max(Number(decision.confidence || 0), 0.95),
  };
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
    rule.close_ticket_on_match
      ? 'Politica da regra: encerrar ticket quando a conversa pedir encerramento claro.'
      : rule.stop_ai_after_match
        ? 'Politica da regra: pode transferir para humano quando a conversa realmente exigir humano; tambem pode apenas mover etapa e continuar.'
        : 'Politica da regra: mover oportunidade para esta etapa e continuar a conversa.',
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
  const schedulePolicy = normalizedSchedulePolicy(settings.schedule_policy);
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
    'Quando houver regras de etapa, escolha pipeline_id, stage_id e queue_id somente entre os IDs listados nas regras. Nunca invente IDs.',
    'Se uma regra de etapa combinar com a necessidade do cliente, preencha os IDs exatos da regra.',
    'Use move_stage quando a oportunidade deve mudar de etapa, mas a IA ainda deve continuar qualificando ou explicando.',
    'Use handoff somente quando o cliente pedir humano, houver intencao clara de contratar/negociar, assunto sensivel ou a regra mandar transferir nesse contexto.',
    schedulePolicy.enabled
      ? 'Agendamento esta ativo. Quando o cliente quiser agendar, preencha appointment_intent=true. Nao prometa disponibilidade por conta propria: o backend consultara a agenda do Z-PRO.'
      : 'Agendamento automatico esta desativado.',
    schedulePolicy.enabled
      ? 'Use schedule_appointment somente quando o historico tiver uma data e um horario inequivocos aceitos pelo cliente. Antes disso use reply, appointment_confirmed=false e deixe o backend oferecer horarios livres.'
      : '',
    schedulePolicy.enabled
      ? `Fuso da agenda: ${schedulePolicy.timezone}. Duracao padrao: ${schedulePolicy.duration_minutes} minutos. Intervalo minimo: ${schedulePolicy.buffer_minutes} minutos.`
      : '',
    'Se nenhuma regra combinar, deixe pipeline_id, stage_id, queue_id e user_id vazios.',
    'Se o cliente pedir humano, atendente, suporte humano, cancelamento, reclamacao ou financeiro, escolha uma acao de transferencia.',
    'Use close_ticket somente se o cliente pedir encerramento, disser que nao tem interesse, ou confirmar claramente que esta resolvido. Nunca encerre quando o cliente perguntou preco, como funciona, detalhes ou demonstrou interesse.',
    'Retorne exclusivamente um JSON valido conforme o schema solicitado.',
    'Valores aceitos em action: reply, handoff, move_stage, close_ticket, stop_ai, schedule_appointment.',
    'Para agenda, use appointment_date no formato YYYY-MM-DD e appointment_time no formato HH:mm. Nao invente data ou horario ausentes na conversa.',
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
      appointment_intent: false,
      appointment_confirmed: false,
      appointment_date: '',
      appointment_time: '',
      appointment_title: '',
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
      appointment_intent:
        parsed.appointment_intent === true ||
        parsed.appointmentIntent === true ||
        normalizeId(parsed.action || parsed.acao) === 'schedule_appointment',
      appointment_confirmed: parsed.appointment_confirmed === true || parsed.appointmentConfirmed === true,
      appointment_date: String(parsed.appointment_date || parsed.appointmentDate || '').trim(),
      appointment_time: String(parsed.appointment_time || parsed.appointmentTime || '').trim(),
      appointment_title: String(parsed.appointment_title || parsed.appointmentTitle || '').trim(),
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
      appointment_intent: false,
      appointment_confirmed: false,
      appointment_date: '',
      appointment_time: '',
      appointment_title: '',
      reason: 'Modelo retornou texto livre',
      confidence: 0.3,
    };
  }
}

function stripEmoji(value = '') {
  return String(value || '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function looksLikeClosingReply(value = '') {
  return /\b(finalizando|encerrando|encerrar|obrigado pelo contato|excelente dia|ate logo)\b/i
    .test(normalizeText(value));
}

function looksLikeHandoffReply(value = '') {
  return /\b(encaminhar|encaminho|transferir|transferindo|atendente|humano|nossa equipe|setor de relacionamento)\b/i
    .test(normalizeText(value));
}

function explicitCloseIntent({ parsed, context = [] }) {
  const userText = normalizeText([
    ...context
      .filter((row) => row.role === 'user')
      .slice(-4)
      .map((row) => row.content),
    parsed.text || '',
  ].join(' '));

  if (/\b(como funciona|quero saber|mais informacoes|informacoes|preco|valor|quanto custa|funcionalidades|detalhes|ura|crm|whatsapp|ligacoes|ia)\b/i.test(userText)) {
    return false;
  }

  return /\b(nao tenho interesse|nao quero|nao preciso|pode encerrar|encerrar atendimento|nao me chama|nao envie|pare de chamar|ja resolvi|resolvido|era so isso|obrigad[oa],? era so)\b/i
    .test(userText);
}

function strongHandoffIntent({ decision = {}, parsed, context = [] }) {
  if (humanRequestDetected(parsed.text)) return true;

  const text = normalizeText([
    ...context
      .filter((row) => row.role === 'user')
      .slice(-4)
      .map((row) => row.content),
    parsed.text || '',
    decision.reason || '',
  ].join(' '));

  if (/\b(contratar|contratacao|fechar|fechamento|contrato|pagamento|pagar|boleto|financeiro|regularizacao|regularizar|negociar|negociacao|desconto|condicao especial|suporte|cancelamento|cancelar|reclamacao|reclamar|pergunta tecnica|nao sei responder)\b/i.test(text)) {
    return true;
  }

  return false;
}

function fallbackContinuationReply({ parsed, lead }) {
  const name = lead?.name || parsed?.name || '';
  const prefix = name ? `${name}, ` : '';
  return `${prefix}me conta um pouco melhor o que voce quer entender ou qual resultado busca, que eu te ajudo por aqui.`;
}

function normalizeAiDecisionForWorkflow({
  decision = {},
  actions = [],
  rule = null,
  agent = {},
  parsed = {},
  lead = {},
  context = [],
  spamRisk = false,
}) {
  const normalized = {
    ...decision,
    action: normalizeId(decision.action || 'reply') || 'reply',
    reply: stripEmoji(decision.reply || ''),
  };

  if (!['reply', 'handoff', 'move_stage', 'close_ticket', 'stop_ai', 'schedule_appointment'].includes(normalized.action)) {
    normalized.action = 'reply';
  }

  const wantsHuman = humanRequestDetected(parsed.text);
  const closeAllowed = canExecuteAction(actions, 'close_ticket') && explicitCloseIntent({ parsed, context });
  const transferAllowed = canExecuteAction(actions, 'transfer_ticket');
  const ruleAllowsHandoff = rule?.stop_ai_after_match === true;

  if (normalized.action === 'close_ticket' && !closeAllowed) {
    normalized.action = rule ? 'move_stage' : 'reply';
    normalized.reason = `${normalized.reason || 'Decisao ajustada'} | close_ticket bloqueado sem encerramento explicito`;
    if (!normalized.reply || looksLikeClosingReply(normalized.reply) || looksLikeHandoffReply(normalized.reply)) {
      normalized.reply = fallbackContinuationReply({ parsed, lead });
    }
  }

  if (normalized.action === 'handoff' && !transferAllowed) {
    normalized.action = rule ? 'move_stage' : 'reply';
    normalized.reason = `${normalized.reason || 'Decisao ajustada'} | handoff bloqueado porque transfer_ticket esta desabilitado`;
    if (!normalized.reply || looksLikeClosingReply(normalized.reply) || looksLikeHandoffReply(normalized.reply)) {
      normalized.reply = fallbackContinuationReply({ parsed, lead });
    }
  }

  if (normalized.action === 'handoff' && !rule && !wantsHuman && !spamRisk) {
    normalized.action = 'reply';
    normalized.reason = `${normalized.reason || 'Decisao ajustada'} | handoff bloqueado sem regra, pedido humano ou risco de spam`;
    if (!normalized.reply || looksLikeClosingReply(normalized.reply) || looksLikeHandoffReply(normalized.reply)) {
      normalized.reply = fallbackContinuationReply({ parsed, lead });
    }
  }

  if (normalized.action === 'handoff' && !spamRisk && !ruleAllowsHandoff && !strongHandoffIntent({ decision: normalized, parsed, context })) {
    normalized.action = rule ? 'move_stage' : 'reply';
    normalized.reason = `${normalized.reason || 'Decisao ajustada'} | handoff bloqueado sem sinal forte de entrega humana`;
    if (!normalized.reply || looksLikeClosingReply(normalized.reply) || looksLikeHandoffReply(normalized.reply)) {
      normalized.reply = fallbackContinuationReply({ parsed, lead });
    }
  }

  if (!normalized.reply && normalized.action === 'move_stage') {
    normalized.reply = fallbackContinuationReply({ parsed, lead });
  }

  if (!isStopAction(normalized.action) && looksLikeHandoffReply(normalized.reply)) {
    normalized.reply = fallbackContinuationReply({ parsed, lead });
  }

  return normalized;
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

function aiDecisionResponseFormat() {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'crm_ai_decision',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          reply: { type: 'string', description: 'Mensagem curta em portugues do Brasil para enviar ao cliente.' },
          action: {
            type: 'string',
            enum: ['reply', 'handoff', 'move_stage', 'close_ticket', 'stop_ai', 'schedule_appointment'],
            description: 'Acao operacional que o backend deve tentar executar.',
          },
          pipeline_id: { type: 'string', description: 'ID exato do funil Z-PRO, ou string vazia.' },
          stage_id: { type: 'string', description: 'ID exato da etapa Z-PRO, ou string vazia.' },
          queue_id: { type: 'string', description: 'ID exato da fila Z-PRO, ou string vazia.' },
          user_id: { type: 'string', description: 'ID exato do usuario Z-PRO, ou string vazia.' },
          appointment_intent: { type: 'boolean', description: 'True quando o cliente quer marcar, remarcar ou confirmar um compromisso.' },
          appointment_confirmed: { type: 'boolean', description: 'True somente quando data e horario foram aceitos inequivocamente pelo cliente.' },
          appointment_date: { type: 'string', description: 'Data local YYYY-MM-DD, ou string vazia.' },
          appointment_time: { type: 'string', description: 'Horario local HH:mm, ou string vazia.' },
          appointment_title: { type: 'string', description: 'Titulo curto do compromisso, ou string vazia.' },
          reason: { type: 'string', description: 'Motivo operacional da decisao.' },
          confidence: { type: 'number', description: 'Confianca de 0 a 1.' },
        },
        required: [
          'reply',
          'action',
          'pipeline_id',
          'stage_id',
          'queue_id',
          'user_id',
          'appointment_intent',
          'appointment_confirmed',
          'appointment_date',
          'appointment_time',
          'appointment_title',
          'reason',
          'confidence',
        ],
      },
    },
  };
}

function routeClassifierResponseFormat() {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'crm_route_classifier',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          rule_index: {
            type: 'number',
            description: 'Numero da regra escolhida, comecando em 1. Use -1 quando nenhuma regra combinar.',
          },
          action: {
            type: 'string',
            enum: ['none', 'handoff', 'move_stage', 'close_ticket'],
            description: 'Acao que a regra exige.',
          },
          reply: {
            type: 'string',
            description: 'Mensagem curta para o cliente quando a regra combinar. Vazio se nenhuma regra combinar.',
          },
          reason: {
            type: 'string',
            description: 'Por que a conversa combina ou nao com a regra.',
          },
          confidence: {
            type: 'number',
            description: 'Confianca de 0 a 1.',
          },
        },
        required: ['rule_index', 'action', 'reply', 'reason', 'confidence'],
      },
    },
  };
}

function parseRouteClassifierDecision(raw = '') {
  const text = String(raw || '').trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  try {
    const parsed = JSON.parse(text);
    return {
      rule_index: Number(parsed.rule_index ?? -1),
      action: String(parsed.action || 'none').trim(),
      reply: String(parsed.reply || '').trim(),
      reason: String(parsed.reason || '').trim(),
      confidence: Number(parsed.confidence ?? 0),
    };
  } catch {
    return {
      rule_index: -1,
      action: 'none',
      reply: '',
      reason: 'Classificador retornou texto invalido',
      confidence: 0,
    };
  }
}

function ruleAtIndex(ruleIndex, routingRules = []) {
  const index = Number(ruleIndex);
  if (!Number.isInteger(index)) return null;
  if (index < 1 || index > routingRules.length) return null;
  return routingRules[index - 1];
}

async function classifyRoutingRuleWithAi({ agent, parsed, lead, context, routingRules, currentDecision }) {
  if (!routingRules.length) {
    return {
      rule: null,
      classification: {
        rule_index: -1,
        action: 'none',
        reply: '',
        reason: 'Nao ha regras configuradas',
        confidence: 0,
      },
    };
  }

  const client = getOpenAIClient();
  if (!client) throw new Error('OPENAI_API_KEY ausente no backend');

  const rulesText = routingRules.map((rule, index) => [
    `REGRA ${index + 1}`,
    `Funil: ${rule.pipeline_name || rule.external_pipeline_id} | pipeline_id=${rule.external_pipeline_id}`,
    `Etapa: ${rule.stage_name || rule.external_stage_id} | stage_id=${rule.external_stage_id}`,
    `Fila: ${rule.queue_name || rule.external_queue_id || 'nao definida'} | queue_id=${rule.external_queue_id || ''}`,
    `Instrucao: ${rule.routing_instruction || 'sem instrucao'}`,
    `Pode parar IA: ${rule.stop_ai_after_match ? 'sim' : 'nao'}`,
    `Pode encerrar ticket: ${rule.close_ticket_on_match ? 'sim' : 'nao'}`,
    rule.handoff_message ? `Mensagem da regra: ${rule.handoff_message}` : '',
  ].filter(Boolean).join('\n')).join('\n\n');

  const request = {
    model: agent.model || process.env.DEFAULT_OPENAI_MODEL || 'gpt-4o-mini',
    temperature: 0,
    max_tokens: boundedNumber(process.env.OPENAI_ROUTE_MAX_TOKENS, 220, 120, 400),
    response_format: routeClassifierResponseFormat(),
    messages: [
      {
        role: 'system',
        content: [
          'Voce e um classificador operacional de CRM. Sua unica tarefa e escolher uma regra de etapa do Z-PRO para a conversa.',
          'Use somente as regras listadas. Nao invente funil, etapa, fila ou usuario.',
          'Escolha -1 quando nenhuma regra combinar com seguranca.',
          'Considere o historico recente inteiro, nao apenas uma palavra solta.',
          'Se o cliente quer humano mas nenhuma regra especifica combina, use -1.',
          'Escolha move_stage quando a conversa pertence a uma etapa, mas a IA deve continuar conduzindo o lead.',
          'Escolha handoff somente quando o cliente pediu uma pessoa, quer negociar/contratar/fechar, ou a instrucao da regra exige humano naquele contexto.',
          'Se uma regra esta marcada como "Pode parar IA: sim", isso e permissao operacional, nao obrigacao. Nao escolha handoff so por causa dessa marcacao.',
          'Escolha close_ticket somente quando houver recusa clara, pedido de encerramento ou resolucao confirmada.',
          'Perguntas como preco, como funciona, funcionalidades, detalhes, WhatsApp, ligacoes, CRM ou IA normalmente sao move_stage para etapa de informacoes, nao handoff.',
          'Use exatamente as chaves: rule_index, action, reply, reason, confidence.',
          'Valores aceitos em action: none, handoff, move_stage, close_ticket.',
          'Retorne somente JSON no schema pedido.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `Contato: ${lead.name || parsed.name || 'nao informado'} (${lead.phone || parsed.phone || 'sem telefone'})`,
          `Status do ticket: ${parsed.ticketStatus || 'nao informado'}`,
          'Historico recente:',
          contextToPrompt(context),
          `Mensagem atual: ${parsed.text || '[sem texto]'}`,
          'Decisao preliminar da IA:',
          JSON.stringify(sanitizeObject(currentDecision || {})),
          'Regras disponiveis:',
          rulesText,
        ].join('\n'),
      },
    ],
  };

  let completion;
  try {
    completion = await client.chat.completions.create(request);
  } catch (err) {
    if (!/response_format|json_schema|schema/i.test(err.message || '')) throw err;
    const fallbackRequest = {
      ...request,
      response_format: { type: 'json_object' },
    };
    completion = await client.chat.completions.create(fallbackRequest);
  }

  const classification = parseRouteClassifierDecision(completion.choices?.[0]?.message?.content || '');
  const rule = classification.confidence >= 0.65
    ? ruleAtIndex(classification.rule_index, routingRules)
    : null;

  return {
    rule,
    classification,
  };
}

async function generateAiDecision({ agent, actions, parsed, lead, context, routingRules, spamRisk }) {
  const client = getOpenAIClient();
  if (!client) throw new Error('OPENAI_API_KEY ausente no backend');
  const schedulePolicy = normalizedSchedulePolicy(agent.settings?.schedule_policy);
  const localNow = new Intl.DateTimeFormat('sv-SE', {
    timeZone: schedulePolicy.timezone,
    dateStyle: 'short',
    timeStyle: 'short',
    hourCycle: 'h23',
  }).format(new Date());

  const request = {
    model: agent.model || process.env.DEFAULT_OPENAI_MODEL || 'gpt-4o-mini',
    temperature: Number(agent.temperature ?? 0.3),
    max_tokens: boundedNumber(agent.settings?.max_tokens || process.env.OPENAI_DECISION_MAX_TOKENS, 320, 160, 600),
    response_format: aiDecisionResponseFormat(),
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
          `Data e hora local atual (${schedulePolicy.timezone}): ${localNow}`,
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
    if (!/response_format|json_schema|schema|json/i.test(err.message || '')) throw err;
    try {
      completion = await client.chat.completions.create({
        ...request,
        response_format: { type: 'json_object' },
      });
    } catch (fallbackErr) {
      if (!/response_format|json/i.test(fallbackErr.message || '')) throw fallbackErr;
      const fallbackRequest = { ...request };
      delete fallbackRequest.response_format;
      completion = await client.chat.completions.create(fallbackRequest);
    }
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

function humanRequestDetected(text = '') {
  return /\b(humano|atendente|pessoa|alguem|falar com|me liga|ligar|suporte humano|consultor|vendedor|gerente)\b/i
    .test(normalizeText(text));
}

function appointmentIntentDetected({ decision = {}, parsed = {}, context = [] }) {
  if (decision.appointment_intent === true || normalizeId(decision.action) === 'schedule_appointment') return true;
  const current = normalizeText(parsed.text || '');
  if (/\b(agendar|agendamento|agenda|marcar|reuniao|demonstracao|demo)\b/i.test(current)) return true;

  const lastAssistant = [...context].reverse().find((row) => row.role === 'assistant');
  const assistantOfferedSlots = /\b(horario|horarios|agenda|agendar|disponibilidade)\b/i
    .test(normalizeText(lastAssistant?.content || ''));
  const shortConfirmation = /^(sim|pode ser|fechado|confirmo|ok|\d{1,2}(?::\d{2})?|\d{1,2}h)$/i.test(current.trim());
  return assistantOfferedSlots && shortConfirmation;
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

function findRoutingRule(decision = {}, routingRules = [], fallback = {}) {
  const pipelineId = normalizeId(decision.pipeline_id || fallback.pipeline_id);
  const stageId = normalizeId(decision.stage_id || fallback.stage_id);
  if (!pipelineId && !stageId) return null;

  return routingRules.find((rule) => {
    const pipelineMatches = !pipelineId || normalizeId(rule.external_pipeline_id) === pipelineId;
    const stageMatches = !stageId || normalizeId(rule.external_stage_id) === stageId;
    return pipelineMatches && stageMatches;
  }) || null;
}

function currentOpportunityRoutingFallback({ opportunity = {}, integration = {}, parsed = {}, decision = {} }) {
  return {
    pipeline_id: opportunity?.pipeline_id || integration?.pipeline_id || decision?.pipeline_id || '',
    stage_id: opportunity?.stage_id || integration?.initial_stage_id || decision?.stage_id || '',
    queue_id: decision?.queue_id || parsed?.queueId || integration?.sales_queue_id || '',
  };
}

function ruleUserIds(rule = null) {
  if (!rule) return [];
  let userOrder = rule.user_order;
  if (typeof userOrder === 'string') {
    try {
      userOrder = JSON.parse(userOrder);
    } catch {
      userOrder = [];
    }
  }
  return Array.isArray(userOrder)
    ? userOrder
      .map((item) => (
        item && typeof item === 'object'
          ? pickFirst(item.external_user_id, item.externalUserId, item.userId, item.id, item.value)
          : item
      ))
      .map((item) => String(item || '').trim())
      .filter(Boolean)
    : [];
}

async function selectRuleUser(rule = null) {
  if (!rule) return null;
  const userOrder = ruleUserIds(rule);
  if (userOrder.length === 0) return null;

  const index = Math.max(0, Number(rule.round_robin_cursor || 0)) % userOrder.length;
  const userId = userOrder[index];
  if (!userId) return null;

  await supabaseAdmin
    .from('crm_ai_stage_assignment_rules')
    .update({
      round_robin_cursor: (index + 1) % userOrder.length,
      updated_at: new Date().toISOString(),
    })
    .eq('id', rule.id);

  return userId;
}

async function markLeadAiStopped({ lead, parsed, reason, status = 'transferred', extra = {} }) {
  const dbStatus = ['new', 'ai_attending', 'qualified', 'transferred', 'in_progress', 'won', 'lost', 'archived']
    .includes(status)
    ? status
    : leadStopStatusFor(reason);
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
      status: dbStatus,
      metadata,
      updated_at: new Date().toISOString(),
    })
    .eq('id', lead.id)
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

async function resumeLeadAiAfterFailedHandoff({ lead, parsed, error }) {
  const metadata = {
    ...(lead.metadata || {}),
    ai_state: {
      ...(lead.metadata?.ai_state || {}),
      stopped: false,
      reason: 'handoff_failed',
      ticket_id: parsed.ticketId || lead.external_ticket_id || null,
      handoff_error: error || 'Falha ao confirmar atribuicao no Z-PRO',
      resumed_at: new Date().toISOString(),
    },
  };

  const { data, error: updateError } = await supabaseAdmin
    .from('crm_ai_leads')
    .update({
      status: 'ai_attending',
      metadata,
      updated_at: new Date().toISOString(),
    })
    .eq('id', lead.id)
    .select('*')
    .single();

  if (updateError) throw updateError;
  return data;
}

async function updateLocalOpportunityStage({ opportunity, pipelineId, stageId, assignedExternalUserId, rawPatch = {} }) {
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
  if (assignedExternalUserId !== undefined) {
    payload.assigned_external_user_id = assignedExternalUserId || null;
  }

  const { data, error } = await supabaseAdmin
    .from('crm_ai_opportunities')
    .update(payload)
    .eq('id', opportunity.id)
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

async function ensureLocalOpportunityForAction({ integration, lead, opportunity, pipelineId, stageId, assignedExternalUserId = null }) {
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
      assigned_external_user_id: assignedExternalUserId || null,
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
    attempts: sanitizeObject(err.attempts || []),
    extra: sanitizeObject(extra),
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

function ticketStateFromResponse(data = {}) {
  return {
    userId: pickValue(data, [
      'userId', 'user_id', 'data.userId', 'data.user_id', 'ticket.userId', 'ticket.user_id',
      'data.ticket.userId', 'data.ticket.user_id', 'user.id', 'data.user.id',
      'ticket.user.id', 'data.ticket.user.id',
    ]),
    queueId: pickValue(data, [
      'queueId', 'queue_id', 'data.queueId', 'data.queue_id', 'ticket.queueId', 'ticket.queue_id',
      'data.ticket.queueId', 'data.ticket.queue_id', 'queue.id', 'data.queue.id',
      'ticket.queue.id', 'data.ticket.queue.id',
    ]),
    status: pickValue(data, ['status', 'data.status', 'ticket.status', 'data.ticket.status']),
  };
}

function ticketStateMatches(state, { userId, queueId, status }) {
  const userMatches = !userId || String(state.userId || '') === String(userId);
  const queueMatches = !queueId || String(state.queueId || '') === String(queueId);
  const statusMatches = !status || normalizeId(state.status) === normalizeId(status);
  return userMatches && queueMatches && statusMatches;
}

async function verifyTicketState(zpro, ticketId, expected, attempts = 3) {
  let verification = null;
  let state = {};

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    verification = await zpro.showTicket(ticketId);
    state = ticketStateFromResponse(verification.data || {});
    if (ticketStateMatches(state, expected)) {
      return { verification, state, matched: true };
    }
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  return { verification, state, matched: false };
}

async function executeAiDecision({ zpro, integration, agent, actions, parsed, lead, opportunity, decision, routingRules }) {
  const action = String(decision?.action || 'reply').toLowerCase();
  const stopAction = isStopAction(action);
  const rule = findRoutingRule(decision, routingRules)
    || (stopAction
      ? findRoutingRule(
        {},
        routingRules,
        currentOpportunityRoutingFallback({ opportunity, integration, parsed, decision }),
      )
      : null);
  const selectedRuleUserId = stopAction ? await selectRuleUser(rule) : null;

  if (!['handoff', 'move_stage', 'close_ticket', 'stop_ai'].includes(action)) {
    return { executed: false, action };
  }

  const targetPipelineId = rule?.external_pipeline_id || decision.pipeline_id || opportunity?.pipeline_id || integration.pipeline_id || '';
  const targetStageId = rule?.external_stage_id || decision.stage_id || opportunity?.stage_id || integration.initial_stage_id || '';
  const targetQueueId = rule?.external_queue_id || decision.queue_id || integration.sales_queue_id || parsed.queueId || '';
  let targetUserId = stopAction
    ? selectedRuleUserId || decision.user_id || parsed.assignedExternalUserId || ''
    : parsed.assignedExternalUserId || '';
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
    ticket_verification: null,
    ticket_verified: false,
    ticket_error: null,
    ticket_effective_user_id: null,
    ticket_effective_queue_id: null,
    ticket_effective_status: null,
    local_ai_stopped: false,
    local_ai_stop_error: null,
  };

  if (stopAction) {
    try {
      lead = await markLeadAiStopped({
        lead,
        parsed,
        reason: action === 'close_ticket' ? 'ticket_closed_by_ai' : 'human_handoff_by_ai',
        status: leadStopStatusFor(action),
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
    } catch (err) {
      result.local_ai_stop_error = err.message || String(err);
      await recordAiActionFailure({ integration, lead, action, step: 'local_ai_stop', err });
    }

    const ticketStatus = action === 'close_ticket' ? 'closed' : targetUserId ? 'open' : 'pending';
    const actionKey = action === 'close_ticket' ? 'close_ticket' : 'transfer_ticket';
    const ticketPayload = {
      ticketId: parsed.ticketId,
      queueId: action === 'close_ticket' ? null : targetQueueId || null,
      userId: action === 'close_ticket' ? null : targetUserId || null,
      status: ticketStatus,
      chatgptStatus: false,
      typebotStatus: false,
      dialogflowStatus: false,
      difyStatus: false,
      n8nStatus: false,
    };

    if (parsed.ticketId && canExecuteAction(actions, actionKey)) {
      try {
        const candidateUserIds = action === 'close_ticket'
          ? ['']
          : Array.from(new Set([targetUserId, ...ruleUserIds(rule)].filter(Boolean)));
        if (candidateUserIds.length === 0) candidateUserIds.push('');
        let state = {};

        for (const candidateUserId of candidateUserIds) {
          const candidatePayload = {
            ...ticketPayload,
            userId: action === 'close_ticket' ? null : candidateUserId || null,
            status: action === 'close_ticket' ? 'closed' : candidateUserId ? 'open' : 'pending',
          };
          result.ticket = await zpro.updateTicketAssignment(candidatePayload);
          const verified = await verifyTicketState(zpro, parsed.ticketId, candidatePayload);
          result.ticket_verification = verified.verification;
          state = verified.state;
          if (verified.matched) {
            targetUserId = candidateUserId;
            Object.assign(ticketPayload, candidatePayload);
            break;
          }
        }

        result.ticket_effective_user_id = state.userId;
        result.ticket_effective_queue_id = state.queueId;
        result.ticket_effective_status = state.status;
        result.ticket_verified = ticketStateMatches(state, ticketPayload);
        result.user_id = targetUserId || null;
        if (!result.ticket_verified) {
          throw new Error(
            `Z-PRO respondeu, mas o ticket ${parsed.ticketId} permaneceu com usuario=${state.userId || 'vazio'}, fila=${state.queueId || 'vazia'} e status=${state.status || 'vazio'}.`,
          );
        }
      } catch (err) {
        result.ticket_error = err.message || String(err);
        await recordAiActionFailure({
          integration,
          lead,
          action,
          step: 'ticket_update_or_verification',
          err,
          extra: sanitizeObject(ticketPayload),
        });
      }
    } else if (parsed.ticketId) {
      result.ticket_error = `Acao ${actionKey} desabilitada`;
    } else {
      result.ticket_error = 'Payload sem ticketId';
    }

    if (action === 'handoff' && !result.ticket_verified) {
      try {
        lead = await resumeLeadAiAfterFailedHandoff({
          lead,
          parsed,
          error: result.ticket_error,
        });
        result.local_ai_stopped = false;
      } catch (err) {
        result.local_ai_stop_error = err.message || String(err);
      }
    }
  }

  if (action === 'move_stage' || action === 'handoff') {
    const canMove = canExecuteAction(actions, 'update_opportunity');
    const mirroredUserId = stopAction
      ? result.ticket_verified ? targetUserId : parsed.assignedExternalUserId || ''
      : parsed.assignedExternalUserId || '';

    try {
      opportunity = await ensureLocalOpportunityForAction({
        integration,
        lead,
        opportunity,
        pipelineId: targetPipelineId,
        stageId: targetStageId,
        assignedExternalUserId: mirroredUserId || null,
      });

      if (opportunity && (targetPipelineId || targetStageId || mirroredUserId)) {
        opportunity = await updateLocalOpportunityStage({
          opportunity,
          pipelineId: targetPipelineId,
          stageId: targetStageId,
          assignedExternalUserId: mirroredUserId || opportunity.assigned_external_user_id || null,
          rawPatch: {
            ai_last_route_at: new Date().toISOString(),
            ai_last_route_reason: decision.reason || '',
            ai_last_route_rule_id: rule?.id || null,
            ai_last_route_target_user_id: targetUserId || null,
            ai_ticket_assignment_verified: result.ticket_verified,
            ai_ticket_assignment_error: result.ticket_error || null,
          },
        });
      }
    } catch (err) {
      result.opportunity_error = err.message || String(err);
      await recordAiActionFailure({
        integration,
        lead,
        action,
        step: 'local_opportunity_route',
        err,
        extra: {
          pipeline_id: targetPipelineId || null,
          stage_id: targetStageId || null,
          user_id: mirroredUserId || null,
          rule_id: rule?.id || null,
        },
      });
    }

    try {
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
          userId: mirroredUserId,
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
          responsibleId: mirroredUserId || undefined,
          description: decision.reason || undefined,
        });
      }

      if (opportunity && result.opportunity) {
        opportunity = await updateLocalOpportunityStage({
          opportunity,
          pipelineId: targetPipelineId,
          stageId: targetStageId,
          assignedExternalUserId: mirroredUserId || opportunity.assigned_external_user_id || null,
          rawPatch: {
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
        step: 'external_opportunity_route',
        err,
        extra: {
          external_opportunity_id: getOpportunityExternalId(opportunity) || null,
          pipeline_id: targetPipelineId || null,
          stage_id: targetStageId || null,
          user_id: mirroredUserId || null,
          rule_id: rule?.id || null,
        },
      });
    }
  }

  result.executed = Boolean(result.local_ai_stopped || result.opportunity || result.ticket_verified || action === 'stop_ai');

  await insertLeadEvent({
    tenantId: integration.tenant_id,
    leadId: lead.id,
    eventType: 'ai_action_executed',
    summary: `Acao da IA: ${action}`,
    payload: sanitizeObject({ decision, result }),
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
      status: leadStopStatusFor(blockReason),
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
    const perfStartedAt = Date.now();
    const perf = {
      started_at: new Date(perfStartedAt).toISOString(),
    };
    const markPerf = (key) => {
      perf[key] = Date.now() - perfStartedAt;
    };

    const [context, routingRules] = await Promise.all([
      loadTicketContext({
        tenantId: integration.tenant_id,
        leadId: lead.id,
        ticketId: parsed.ticketId,
      }),
      loadStageRoutingRules(integration),
    ]);
    markPerf('context_and_rules_ms');

    if (contextShowsAiHandoff(context)) {
      await markLeadAiStopped({
        lead,
        parsed,
        reason: 'ai_handoff_already_sent',
        status: 'transferred',
        extra: {
          action: 'handoff',
        },
      });
      await insertLeadEvent({
        tenantId: integration.tenant_id,
        leadId: lead.id,
        eventType: 'ai_response_skipped',
        summary: 'IA nao respondeu porque ja tinha encaminhado este ticket.',
        payload: {
          ticket_id: parsed.ticketId,
          reason: 'ai_handoff_already_sent',
        },
      });
      return null;
    }

    const settings = agent.settings || {};
    const spamPolicy = settings.spam_policy || {};
    const spamWindowMinutes = Number(spamPolicy.window_minutes || 3);
    const spamMaxMessages = Number(spamPolicy.max_messages || 5);
    const spamBurstCount = recentUserBurstCount(context, spamWindowMinutes);
    const spamTotalCount = recentUserMessageCount(context, spamWindowMinutes);
    const spamRisk = spamBurstCount >= spamMaxMessages;
    const wantsHuman = humanRequestDetected(parsed.text);
    let reply = '';
    let decision = null;
    let appointmentResult = null;
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
    } else if (wantsHuman && routingRules.length === 0) {
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
      const decisionStartedAt = Date.now();
      decision = await generateAiDecision({ agent, actions, parsed, lead, context, routingRules, spamRisk });
      perf.openai_decision_ms = Date.now() - decisionStartedAt;
      if (appointmentIntentDetected({ decision, parsed, context })) {
        decision.appointment_intent = true;
        if (!decision.appointment_confirmed && isStopAction(decision.action)) {
          decision.action = 'reply';
        }
      }

      let decisionRule = findRoutingRule(decision || {}, routingRules);
      const routeSecondPassEnabled = String(process.env.OPENAI_ROUTE_SECOND_PASS || 'false').toLowerCase() === 'true';
      perf.openai_route_second_pass_enabled = routeSecondPassEnabled;
      if (!decisionRule && routingRules.length > 0 && !decision.appointment_intent && routeSecondPassEnabled) {
        const classifierStartedAt = Date.now();
        const routeChoice = await classifyRoutingRuleWithAi({
          agent,
          parsed,
          lead,
          context,
          routingRules,
          currentDecision: decision,
        });
        perf.openai_route_classifier_ms = Date.now() - classifierStartedAt;

        await insertLeadEvent({
          tenantId: integration.tenant_id,
          leadId: lead.id,
          eventType: 'ai_route_classified',
          summary: routeChoice.rule
            ? `Regra escolhida: ${routeChoice.rule.stage_name || routeChoice.rule.external_stage_id}`
            : 'Nenhuma regra de etapa escolhida',
          payload: sanitizeObject({
            classification: routeChoice.classification,
            rule_id: routeChoice.rule?.id || null,
            pipeline_id: routeChoice.rule?.external_pipeline_id || null,
            stage_id: routeChoice.rule?.external_stage_id || null,
            queue_id: routeChoice.rule?.external_queue_id || null,
          }),
        });

        logInfo('zpro.webhook.ai_route_classified', {
          integrationId: integration.id,
          tenantId: integration.tenant_id,
          leadId: lead.id,
          ticketId: parsed.ticketId || null,
          classification: routeChoice.classification,
          ruleId: routeChoice.rule?.id || null,
          pipelineId: routeChoice.rule?.external_pipeline_id || null,
          stageId: routeChoice.rule?.external_stage_id || null,
          queueId: routeChoice.rule?.external_queue_id || null,
        });

        if (routeChoice.rule) {
          decisionRule = routeChoice.rule;
          const classifiedAction = ['handoff', 'move_stage', 'close_ticket'].includes(routeChoice.classification.action)
            ? routeChoice.classification.action
            : 'move_stage';
          decision = {
            ...decision,
            action: classifiedAction,
            reason: routeChoice.classification.reason || decision.reason || '',
            reply: isStopAction(classifiedAction)
              ? routeChoice.classification.reply || routeChoice.rule.handoff_message || defaultHandoffMessage(agent)
              : decision.reply || routeChoice.classification.reply || '',
            confidence: Math.max(Number(decision.confidence || 0), Number(routeChoice.classification.confidence || 0)),
          };
        }
      }

      if (decisionRule && !decision.appointment_intent) {
        decision = applyRoutingRuleToDecision(decision, decisionRule, agent);
      }
      if (wantsHuman && (!decision.action || decision.action === 'reply')) {
        decision = {
          ...decision,
          reply: defaultHandoffMessage(agent),
          action: 'handoff',
          reason: decision.reason || 'Cliente pediu atendimento humano',
          confidence: Math.max(Number(decision.confidence || 0), 0.9),
        };
      }

      if (decision.appointment_intent) {
        const appointmentStartedAt = Date.now();
        const scheduled = await applyAppointmentWorkflow({
          zpro,
          agent,
          actions,
          parsed,
          lead,
          decision,
          routingRules,
        });
        perf.zpro_appointment_ms = Date.now() - appointmentStartedAt;
        decision = scheduled.decision;
        decisionRule = scheduled.rule || findRoutingRule(decision || {}, routingRules);
        appointmentResult = scheduled.appointment;

        await insertLeadEvent({
          tenantId: integration.tenant_id,
          leadId: lead.id,
          eventType: decision.appointment_created ? 'zpro_appointment_created' : 'zpro_appointment_pending',
          summary: decision.appointment_created
            ? 'Agendamento criado no Z-PRO.'
            : 'Agendamento aguardando data ou horario disponivel.',
          payload: sanitizeObject({
            decision,
            appointment: appointmentResult,
          }),
        });
      }
      reply = decision.reply;
    }

    let decisionRule = findRoutingRule(decision || {}, routingRules);
    if (!decisionRule && isStopAction(decision?.action)) {
      decisionRule = findRoutingRule(
        {},
        routingRules,
        currentOpportunityRoutingFallback({ opportunity, integration, parsed, decision }),
      );
      if (decisionRule) {
        decision = applyRoutingRuleToDecision(decision, decisionRule, agent);
      }
    }

    decision = normalizeAiDecisionForWorkflow({
      decision,
      actions,
      rule: decisionRule,
      agent,
      parsed,
      lead,
      context,
      spamRisk,
    });
    reply = decision.reply || reply;

    if (decisionRule && isStopAction(decision?.action) && !decision.appointment_created) {
      if (decisionRule.handoff_message) reply = decisionRule.handoff_message;
      if (!reply) reply = defaultHandoffMessage(agent);
      decision.reply = reply;
    }

    reply = stripEmoji(reply);
    decision.reply = reply;
    decision.spam = {
      risk: spamRisk,
      burst_count: spamBurstCount,
      total_recent_count: spamTotalCount,
      window_minutes: spamWindowMinutes,
      max_messages: spamMaxMessages,
    };

    if (!reply) return null;

    let leadForAction = lead;
    let preStopError = null;
    if (decision && isStopAction(decision.action)) {
      try {
        leadForAction = await markLeadAiStopped({
          lead,
          parsed,
          reason: decision.action === 'close_ticket' ? 'ticket_closed_by_ai' : 'human_handoff_by_ai',
          status: leadStopStatusFor(decision.action),
          extra: {
            action: decision.action,
            pipeline_id: decision.pipeline_id || null,
            stage_id: decision.stage_id || null,
            queue_id: decision.queue_id || null,
            user_id: decision.user_id || null,
            pre_send: true,
          },
        });
      } catch (err) {
        preStopError = err.message || String(err);
        await recordAiActionFailure({
          integration,
          lead,
          action: decision.action,
          step: 'local_ai_stop_pre_send',
          err,
        });
      }
    }

    const sendStartedAt = Date.now();
    const result = await zpro.sendMessage({
      number: lead.phone || parsed.phone,
      body: reply,
    });
    perf.zpro_send_message_ms = Date.now() - sendStartedAt;

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
        const actionStartedAt = Date.now();
        actionResult = await executeAiDecision({
          zpro,
          integration,
          agent,
          actions,
          parsed,
          lead: leadForAction,
          opportunity,
          decision,
          routingRules,
        });
        perf.action_execution_ms = Date.now() - actionStartedAt;
        if (preStopError) actionResult.local_ai_stop_error = preStopError;
        const stopCompleted = decision.action === 'stop_ai' || actionResult?.ticket_verified === true;
        if (!preStopError && isStopAction(decision.action) && actionResult && stopCompleted) {
          actionResult.local_ai_stopped = true;
        }
      } catch (actionError) {
        actionResult = {
          executed: decision.action === 'stop_ai' && !preStopError,
          action: decision.action,
          local_ai_stopped: decision.action === 'stop_ai' && !preStopError,
          local_ai_stop_error: preStopError,
          ticket_error: null,
          opportunity_error: null,
        };
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

    markPerf('total_ms');
    logInfo('zpro.webhook.ai_perf', {
      integrationId: integration.id,
      tenantId: integration.tenant_id,
      leadId: lead.id,
      ticketId: parsed.ticketId || null,
      action: decision?.action || null,
      routeRuleId: actionResult?.rule_id || null,
      timings: perf,
      spam: decision?.spam || null,
    });

    return { reply, result, decision, actionResult, appointmentResult, perf };
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
    'data.opportunity.id',
    'data.opportunity.opportunityId',
    'data.card.id',
    'data.card.opportunityId',
    'data.kanban.id',
    'opportunity.id',
    'card.id',
    'kanban.id',
  ]);
}

async function maybeCreateExternalOpportunity({ zpro, integration, actions, parsed, lead, opportunity }) {
  if (!integration.auto_create_opportunity) return null;
  if (!integration.pipeline_id || !integration.initial_stage_id) return null;
  if (!canExecuteAction(actions, 'create_opportunity')) return null;

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

    return {
      ...result,
      externalOpportunityId,
    };
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

async function syncOpportunityFromTicketState({ getZpro, integration, actions, parsed, lead, opportunity }) {
  if (!opportunity?.id) return opportunity;

  const ticketStatus = normalizeId(parsed.ticketStatus);
  const ticketUserId = parsed.assignedExternalUserId || null;
  const shouldMirrorTicket =
    ticketStatus === 'open' ||
    ticketStatus === 'pending' ||
    ticketUserId;

  if (!shouldMirrorTicket) return opportunity;

  let updatedOpportunity = opportunity;
  try {
    updatedOpportunity = await updateLocalOpportunityStage({
      opportunity,
      pipelineId: opportunity.pipeline_id,
      stageId: opportunity.stage_id,
      assignedExternalUserId: ticketUserId,
      rawPatch: {
        zpro_ticket_sync_at: new Date().toISOString(),
        zpro_ticket_sync_status: parsed.ticketStatus || null,
        zpro_ticket_sync_ticket_id: parsed.ticketId || null,
        zpro_ticket_sync_queue_id: parsed.queueId || null,
        zpro_ticket_sync_user_id: ticketUserId,
      },
    });
  } catch (err) {
    await recordAiActionFailure({
      integration,
      lead,
      action: 'ticket_sync',
      step: 'local_opportunity_owner_sync',
      err,
      extra: {
        ticket_id: parsed.ticketId || null,
        user_id: ticketUserId,
      },
    });
    return opportunity;
  }

  const externalOpportunityId = getOpportunityExternalId(updatedOpportunity);
  if (!ticketUserId || !externalOpportunityId || !canExecuteAction(actions, 'update_opportunity')) {
    return updatedOpportunity;
  }

  try {
    const zpro = await getZpro();
    const result = await zpro.moveOpportunity({
      opportunityId: externalOpportunityId,
      name: updatedOpportunity.title,
      value: updatedOpportunity.value,
      status: updatedOpportunity.status || 'open',
      pipelineId: updatedOpportunity.pipeline_id || integration.pipeline_id,
      stageId: updatedOpportunity.stage_id || integration.initial_stage_id,
      responsibleId: ticketUserId,
      description: 'Responsavel sincronizado a partir do ticket.',
    });

    updatedOpportunity = await updateLocalOpportunityStage({
      opportunity: updatedOpportunity,
      pipelineId: updatedOpportunity.pipeline_id,
      stageId: updatedOpportunity.stage_id,
      assignedExternalUserId: ticketUserId,
      rawPatch: {
        zpro_ticket_sync_external_at: new Date().toISOString(),
        zpro_ticket_sync_external_result: sanitizeObject(result.data || {}),
      },
    });

    await insertLeadEvent({
      tenantId: integration.tenant_id,
      leadId: lead.id,
      eventType: 'zpro_opportunity_owner_synced',
      summary: 'Responsavel da oportunidade sincronizado com o ticket.',
      payload: {
        ticket_id: parsed.ticketId || null,
        external_opportunity_id: externalOpportunityId,
        user_id: ticketUserId,
        endpoint: result.endpoint,
      },
    });
  } catch (err) {
    await recordAiActionFailure({
      integration,
      lead,
      action: 'ticket_sync',
      step: 'external_opportunity_owner_sync',
      err,
      extra: {
        ticket_id: parsed.ticketId || null,
        external_opportunity_id: externalOpportunityId,
        user_id: ticketUserId,
      },
    });
  }

  return updatedOpportunity;
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
          assigned_external_user_id: parsed.ticketId
            ? parsed.assignedExternalUserId || null
            : parsed.assignedExternalUserId || lead.assigned_external_user_id,
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
          assigned_external_user_id: parsed.assignedExternalUserId || null,
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

    opportunity = await syncOpportunityFromTicketState({
      getZpro,
      integration,
      actions,
      parsed,
      lead,
      opportunity,
    });

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
      aiRuleId: aiResult?.actionResult?.rule_id || null,
      aiTargetPipelineId: aiResult?.actionResult?.pipeline_id || null,
      aiTargetStageId: aiResult?.actionResult?.stage_id || null,
      aiTargetQueueId: aiResult?.actionResult?.queue_id || null,
      aiTargetUserId: aiResult?.actionResult?.user_id || null,
      aiTicketEndpoint: aiResult?.actionResult?.ticket?.endpoint || null,
      aiTicketVerificationEndpoint: aiResult?.actionResult?.ticket_verification?.endpoint || null,
      aiTicketVerified: aiResult?.actionResult?.ticket_verified === true,
      aiTicketEffectiveUserId: aiResult?.actionResult?.ticket_effective_user_id || null,
      aiTicketEffectiveQueueId: aiResult?.actionResult?.ticket_effective_queue_id || null,
      aiTicketEffectiveStatus: aiResult?.actionResult?.ticket_effective_status || null,
      aiPerf: aiResult?.perf || null,
      aiAppointmentStatus: aiResult?.appointmentResult?.status || null,
      aiAppointmentStartAt: aiResult?.appointmentResult?.start_at || null,
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
      aiRuleId: aiResult?.actionResult?.rule_id || null,
      aiTargetPipelineId: aiResult?.actionResult?.pipeline_id || null,
      aiTargetStageId: aiResult?.actionResult?.stage_id || null,
      aiTargetQueueId: aiResult?.actionResult?.queue_id || null,
      aiTargetUserId: aiResult?.actionResult?.user_id || null,
      aiTicketEndpoint: aiResult?.actionResult?.ticket?.endpoint || null,
      aiTicketVerificationEndpoint: aiResult?.actionResult?.ticket_verification?.endpoint || null,
      aiTicketVerified: aiResult?.actionResult?.ticket_verified === true,
      aiTicketEffectiveUserId: aiResult?.actionResult?.ticket_effective_user_id || null,
      aiTicketEffectiveQueueId: aiResult?.actionResult?.ticket_effective_queue_id || null,
      aiTicketEffectiveStatus: aiResult?.actionResult?.ticket_effective_status || null,
      aiPerf: aiResult?.perf || null,
      aiAppointmentStatus: aiResult?.appointmentResult?.status || null,
      aiAppointmentStartAt: aiResult?.appointmentResult?.start_at || null,
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
