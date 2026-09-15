import express from 'express';
import { ZproService } from '../services/zproService.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logInfo, logWarn, sanitizeObject } from '../lib/logging.js';
import { getFollowupWorkerStatus, runFollowupCycle } from '../services/followupWorker.js';

export const adminRouter = express.Router();

const INTEGRATION_SAFE_SELECT = `
  id,
  tenant_id,
  provider,
  name,
  base_url,
  api_id,
  channel_id,
  sales_queue_id,
  pipeline_id,
  initial_stage_id,
  won_stage_id,
  lost_stage_id,
  webhook_public_id,
  auto_create_opportunity,
  active,
  has_token,
  created_at,
  updated_at
`;

const ZPRO_CONFIG_FIELDS = [
  'tenant_id',
  'provider',
  'name',
  'base_url',
  'api_id',
  'channel_id',
  'sales_queue_id',
  'pipeline_id',
  'initial_stage_id',
  'won_stage_id',
  'lost_stage_id',
  'auto_create_opportunity',
  'active',
];

const ZPRO_READERS = {
  users: { label: 'usuarios/vendedores', method: 'listUsers' },
  queues: { label: 'filas', method: 'listQueues' },
  channels: { label: 'canais', method: 'listChannels' },
  pipelines: { label: 'funis/kanbans', method: 'listPipelines' },
  stages: { label: 'etapas', method: 'listStages' },
  tickets: { label: 'atendimentos/tickets', method: 'listTickets' },
  opportunities: { label: 'oportunidades', method: 'listOpportunities' },
};

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function isAdminApiKeyAuthorized(req) {
  const key = req.headers['x-admin-api-key'];
  return Boolean(process.env.ADMIN_API_KEY && key === process.env.ADMIN_API_KEY);
}

function requireAdminApiKey(req, res, next) {
  if (!isAdminApiKeyAuthorized(req)) {
    return res.status(401).json({
      ok: false,
      error: 'Nao autorizado',
      message: 'Nao autorizado',
    });
  }

  next();
}

function getBearerToken(req) {
  const authorization = String(req.headers.authorization || '');
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || null;
}

async function loadRequester(req) {
  if (isAdminApiKeyAuthorized(req)) {
    return {
      authType: 'admin_api_key',
      isSuperadmin: true,
      userId: null,
    };
  }

  const token = getBearerToken(req);
  if (!token) return null;

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) return null;

  const { data: profile, error: profileError } = await supabaseAdmin
    .from('crm_ai_profiles')
    .select('global_role,status')
    .eq('id', data.user.id)
    .maybeSingle();

  if (profileError) throw profileError;

  return {
    authType: 'supabase_jwt',
    isSuperadmin: profile?.global_role === 'superadmin' && profile?.status === 'active',
    userId: data.user.id,
  };
}

async function assertTenantPermission(req, tenantId, allowedRoles) {
  if (!tenantId) throw httpError(400, 'tenant_id obrigatorio');

  const requester = await loadRequester(req);
  if (!requester) throw httpError(401, 'Nao autorizado');
  if (requester.isSuperadmin) return requester;

  const { data: member, error } = await supabaseAdmin
    .from('crm_ai_members')
    .select('role,status')
    .eq('tenant_id', tenantId)
    .eq('user_id', requester.userId)
    .maybeSingle();

  if (error) throw error;

  if (!member || member.status !== 'active' || !allowedRoles.includes(member.role)) {
    throw httpError(403, 'Sem permissao para esta empresa');
  }

  return requester;
}

async function assertCanAdminTenant(req, tenantId) {
  return assertTenantPermission(req, tenantId, ['tenant_admin']);
}

async function assertCanManageTenant(req, tenantId) {
  return assertTenantPermission(req, tenantId, ['tenant_admin', 'manager']);
}

async function assertSuperadmin(req) {
  const requester = await loadRequester(req);
  if (!requester) throw httpError(401, 'Nao autorizado');
  if (!requester.isSuperadmin) throw httpError(403, 'Acesso exclusivo do superadmin');
  return requester;
}

const AGENT_WRITE_FIELDS = [
  'name',
  'model',
  'system_prompt',
  'temperature',
  'enabled',
  'welcome_message',
  'handoff_message',
  'settings',
];

function pickAgentPayload(body = {}) {
  const payload = Object.fromEntries(
    AGENT_WRITE_FIELDS
      .filter((field) => Object.hasOwn(body, field))
      .map((field) => [field, body[field]]),
  );
  if (Object.hasOwn(payload, 'name')) payload.name = String(payload.name || '').trim();
  if (Object.hasOwn(payload, 'model')) payload.model = String(payload.model || '').trim();
  if (Object.hasOwn(payload, 'temperature')) {
    const temperature = Number(payload.temperature);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      throw httpError(400, 'Temperatura deve estar entre 0 e 2');
    }
    payload.temperature = temperature;
  }
  if (Object.hasOwn(payload, 'settings') && (!payload.settings || typeof payload.settings !== 'object')) {
    throw httpError(400, 'settings deve ser um objeto');
  }
  return payload;
}

function pickIntegrationPayload(body = {}) {
  return Object.fromEntries(
    ZPRO_CONFIG_FIELDS
      .filter((field) => Object.hasOwn(body, field))
      .map((field) => [field, body[field]]),
  );
}

function cleanIntegration(integration) {
  if (!integration) return null;

  const {
    id,
    tenant_id,
    provider,
    name,
    base_url,
    api_id,
    channel_id,
    sales_queue_id,
    pipeline_id,
    initial_stage_id,
    won_stage_id,
    lost_stage_id,
    webhook_public_id,
    auto_create_opportunity,
    active,
    has_token,
    created_at,
    updated_at,
  } = integration;

  return {
    id,
    tenant_id,
    provider,
    name,
    base_url,
    api_id,
    channel_id,
    sales_queue_id,
    pipeline_id,
    initial_stage_id,
    won_stage_id,
    lost_stage_id,
    webhook_public_id,
    auto_create_opportunity,
    active,
    has_token,
    created_at,
    updated_at,
  };
}

async function loadIntegration(integrationId) {
  if (!integrationId) throw httpError(400, 'integrationId obrigatorio');

  const { data: integration, error } = await supabaseAdmin
    .from('crm_ai_integrations')
    .select('*')
    .eq('id', integrationId)
    .maybeSingle();

  if (error) throw error;
  if (!integration) throw httpError(404, 'Integracao nao encontrada');
  return integration;
}

async function loadAgent(agentId) {
  if (!agentId) throw httpError(400, 'agentId obrigatorio');

  const { data: agent, error } = await supabaseAdmin
    .from('crm_ai_agents')
    .select('*')
    .eq('id', agentId)
    .maybeSingle();

  if (error) throw error;
  if (!agent) throw httpError(404, 'Agente nao encontrado');
  return agent;
}

function getIntegrationId(req) {
  return req.params.integrationId || req.body?.integrationId || req.query?.integrationId;
}

async function createZproService(integration) {
  const { data: token, error: tokenError } = await supabaseAdmin.rpc(
    'crm_ai_service_get_zpro_token',
    {
      p_integration_id: integration.id,
    },
  );

  if (tokenError) throw tokenError;

  return new ZproService({
    baseUrl: integration.base_url,
    token,
  });
}

async function saveZproToken(integrationId, token) {
  if (!token) throw httpError(400, 'token obrigatorio');

  const { error } = await supabaseAdmin.rpc('crm_ai_service_set_zpro_token', {
    p_integration_id: integrationId,
    p_token: token,
  });

  if (error) throw error;
}

async function ensureIntegrationWebhookId(integration) {
  if (integration?.webhook_public_id) return integration;
  const { data, error } = await supabaseAdmin
    .from('crm_ai_integrations')
    .update({ webhook_public_id: crypto.randomUUID(), updated_at: new Date().toISOString() })
    .eq('id', integration.id)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function ensureIntegrationAgent(integration, createdBy = null) {
  const { data: agents, error } = await supabaseAdmin
    .from('crm_ai_agents')
    .select('*')
    .eq('tenant_id', integration.tenant_id)
    .order('created_at', { ascending: true });
  if (error) throw error;

  const bound = (agents || []).find((agent) => String(agent.settings?.integration_id || '') === String(integration.id));
  if (bound) return bound;

  if ((agents || []).length > 0) {
    const candidate = agents.find((agent) => !agent.settings?.integration_id) || agents[0];
    const { data, error: updateError } = await supabaseAdmin
      .from('crm_ai_agents')
      .update({
        settings: {
          ...(candidate.settings || {}),
          integration_id: integration.id,
          safe_mode: candidate.settings?.safe_mode ?? false,
        },
        updated_at: new Date().toISOString(),
      })
      .eq('id', candidate.id)
      .select('*')
      .single();
    if (updateError) throw updateError;
    return data;
  }

  const { data, error: insertError } = await supabaseAdmin
    .from('crm_ai_agents')
    .insert({
      tenant_id: integration.tenant_id,
      name: 'Agente principal',
      model: 'gpt-4o-mini',
      system_prompt: 'Atenda com clareza, use o contexto da conversa e nunca invente preços, horários ou confirmações. Quando não souber ou o cliente pedir uma pessoa, transfira para a equipe humana.',
      temperature: 0.3,
      enabled: true,
      welcome_message: '',
      handoff_message: 'Vou encaminhar seu atendimento para nossa equipe. Um atendente continuará com você.',
      settings: {
        integration_id: integration.id,
        safe_mode: false,
        voice_tone: 'Profissional',
      },
      created_by: createdBy || null,
    })
    .select('*')
    .single();
  if (insertError) throw insertError;
  return data;
}

function zproErrorResponse(res, err) {
  const statusCode = err.statusCode || 502;
  return res.status(statusCode).json({
    ok: false,
    error: err.message || String(err),
    message: err.message || String(err),
    code: err.code || 'ZPRO_REQUEST_FAILED',
    attempts: err.attempts,
  });
}

function compactObject(value = {}) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''),
  );
}

function normalizeList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data?.data)) return data.data.data;
  if (Array.isArray(data?.data?.items)) return data.data.items;
  if (Array.isArray(data?.data?.results)) return data.data.results;
  if (Array.isArray(data?.data?.rows)) return data.data.rows;
  if (Array.isArray(data?.data?.records)) return data.data.records;
  if (Array.isArray(data?.data?.list)) return data.data.list;
  if (Array.isArray(data?.data?.tickets)) return data.data.tickets;
  if (Array.isArray(data?.data?.opportunities)) return data.data.opportunities;
  if (Array.isArray(data?.data?.kanbans)) return data.data.kanbans;
  if (Array.isArray(data?.data?.pipelines)) return data.data.pipelines;
  if (Array.isArray(data?.data?.funnels)) return data.data.funnels;
  if (Array.isArray(data?.data?.funis)) return data.data.funis;
  if (Array.isArray(data?.data?.stages)) return data.data.stages;
  if (Array.isArray(data?.data?.steps)) return data.data.steps;
  if (Array.isArray(data?.data?.columns)) return data.data.columns;
  if (Array.isArray(data?.data?.etapas)) return data.data.etapas;
  if (Array.isArray(data?.data?.fases)) return data.data.fases;
  if (Array.isArray(data?.data?.contacts)) return data.data.contacts;
  if (Array.isArray(data?.data?.users)) return data.data.users;
  if (Array.isArray(data?.data?.queues)) return data.data.queues;
  if (Array.isArray(data?.data?.sessions)) return data.data.sessions;
  if (Array.isArray(data?.data?.whatsapps)) return data.data.whatsapps;
  if (Array.isArray(data?.data?.channels)) return data.data.channels;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.rows)) return data.rows;
  if (Array.isArray(data?.records)) return data.records;
  if (Array.isArray(data?.list)) return data.list;
  if (Array.isArray(data?.content)) return data.content;
  if (Array.isArray(data?.tickets)) return data.tickets;
  if (Array.isArray(data?.opportunities)) return data.opportunities;
  if (Array.isArray(data?.kanbans)) return data.kanbans;
  if (Array.isArray(data?.pipelines)) return data.pipelines;
  if (Array.isArray(data?.funnels)) return data.funnels;
  if (Array.isArray(data?.funis)) return data.funis;
  if (Array.isArray(data?.stages)) return data.stages;
  if (Array.isArray(data?.steps)) return data.steps;
  if (Array.isArray(data?.columns)) return data.columns;
  if (Array.isArray(data?.etapas)) return data.etapas;
  if (Array.isArray(data?.fases)) return data.fases;
  if (Array.isArray(data?.contacts)) return data.contacts;
  if (Array.isArray(data?.users)) return data.users;
  if (Array.isArray(data?.queues)) return data.queues;
  if (Array.isArray(data?.sessions)) return data.sessions;
  if (Array.isArray(data?.whatsapps)) return data.whatsapps;
  if (Array.isArray(data?.channels)) return data.channels;
  return [];
}

function getLeadExternalId(lead = {}) {
  return String(
    lead.id ||
      lead.ticketId ||
      lead.ticket_id ||
      lead.opportunityId ||
      lead.opportunity_id ||
      lead.external_id ||
      lead.externalId ||
      '',
  );
}

function normalizedItemPhone(item = {}) {
  return normalizeDigits(pickValue(item, [
    'phone',
    'number',
    'contactNumber',
    'contact_number',
    'contact.phone',
    'contact.number',
    'customer.phone',
    'customer.number',
    'ticket.contact.phone',
    'ticket.contact.number',
  ]));
}

function itemContactId(item = {}) {
  return String(pickValue(item, [
    'contactId',
    'contact_id',
    'contact.id',
    'customerId',
    'customer_id',
    'customer.id',
    'ticket.contactId',
    'ticket.contact_id',
    'ticket.contact.id',
    'lead.external_contact_id',
  ]) || '');
}

function explicitOpportunityTicketId(item = {}) {
  return String(pickValue(item, [
    'external_ticket_id',
    'externalTicketId',
    'ticketId',
    'ticket_id',
    'ticket.id',
    'raw_data.external_ticket_id',
    'raw_data.ticketId',
    'raw_data.ticket_id',
  ]) || '');
}

function opportunitySnapshot(item = {}) {
  if (!item || typeof item !== 'object') return null;
  return {
    id: String(pickValue(item, [
      'external_opportunity_id',
      'externalOpportunityId',
      'opportunityId',
      'opportunity_id',
      'id',
    ]) || ''),
    ticketId: explicitOpportunityTicketId(item),
    pipelineId: String(pickValue(item, [
      'pipeline_id',
      'pipelineId',
      'pipeline.id',
      'kanbanId',
      'kanban_id',
      'raw_data.pipeline_id',
    ]) || ''),
    stageId: String(pickValue(item, [
      'stage_id',
      'stageId',
      'stage.id',
      'kanbanStageId',
      'kanban_stage_id',
      'raw_data.stage_id',
    ]) || ''),
    responsibleId: String(pickValue(item, [
      'assigned_external_user_id',
      'responsibleId',
      'responsible_id',
      'userId',
      'user_id',
      'user.id',
    ]) || ''),
    contactId: itemContactId(item),
    phone: normalizedItemPhone(item),
    source: item.external_opportunity_id || item.external_ticket_id ? 'local' : 'zpro',
  };
}

function getItemOpportunityId(item = {}) {
  return String(pickValue(item, [
    'crmOpportunity.id',
    'external_opportunity_id',
    'externalOpportunityId',
    'opportunityId',
    'opportunity_id',
    'opportunity.id',
  ]) || '');
}

function opportunityMatchKeys(item = {}) {
  const snapshot = opportunitySnapshot(item);
  if (!snapshot) return [];
  return [
    snapshot.ticketId ? `ticket:${snapshot.ticketId}` : '',
    snapshot.contactId ? `contact:${snapshot.contactId}` : '',
    snapshot.phone ? `phone:${snapshot.phone}` : '',
  ].filter(Boolean);
}

function ticketMatchKeys(item = {}) {
  const ticketId = getLeadExternalId(item);
  const contactId = itemContactId(item);
  const phone = normalizedItemPhone(item);
  return [
    ticketId ? `ticket:${ticketId}` : '',
    contactId ? `contact:${contactId}` : '',
    phone ? `phone:${phone}` : '',
  ].filter(Boolean);
}

export function enrichTicketsWithOpportunities(tickets = [], externalOpportunities = [], localOpportunities = []) {
  const byKey = new Map();
  for (const opportunity of [...externalOpportunities, ...localOpportunities]) {
    for (const key of opportunityMatchKeys(opportunity)) {
      if (!byKey.has(key) || opportunity.external_opportunity_id) byKey.set(key, opportunity);
    }
  }

  return tickets.map((ticket) => {
    const matched = ticketMatchKeys(ticket).map((key) => byKey.get(key)).find(Boolean) || null;
    const crmOpportunity = opportunitySnapshot(matched);
    if (!crmOpportunity) {
      return {
        ...ticket,
        hasOpportunity: false,
        crmOpportunity: null,
      };
    }

    return {
      ...ticket,
      hasOpportunity: true,
      opportunityId: crmOpportunity.id || undefined,
      pipelineId: crmOpportunity.pipelineId || pickValue(ticket, ['pipelineId', 'pipeline_id']) || undefined,
      stageId: crmOpportunity.stageId || pickValue(ticket, ['stageId', 'stage_id']) || undefined,
      crmOpportunity,
    };
  });
}

function adminLeadName(item = {}) {
  return String(pickValue(item, [
    'name', 'contactName', 'contact_name', 'contact.name', 'customer.name', 'ticket.contact.name',
  ]) || normalizedItemPhone(item) || 'Lead');
}

export function localLeadTicketSnapshot(lead = {}) {
  const zpro = lead.metadata?.zpro || {};
  const ticketId = String(lead.external_ticket_id || zpro.ticket_id || '');
  if (!ticketId) return null;

  const fallbackStatus = lead.status === 'archived'
    ? 'closed'
    : lead.status === 'transferred'
      ? 'open'
      : 'pending';

  return {
    id: ticketId,
    ticketId,
    status: zpro.ticket_status || lead.metadata?.ticket_status || fallbackStatus,
    queueId: zpro.queue_id || lead.metadata?.queue_id || null,
    userId: lead.assigned_external_user_id || zpro.assigned_external_user_id || null,
    whatsappId: zpro.whatsapp_id || lead.metadata?.whatsapp_id || null,
    createdAt: zpro.ticket_created_at || lead.first_message_at || lead.created_at || null,
    updatedAt: zpro.ticket_updated_at || lead.last_message_at || lead.updated_at || null,
    contact: {
      id: lead.external_contact_id || zpro.contact_id || null,
      name: lead.name || lead.phone || 'Lead',
      number: lead.phone || '',
    },
    source: 'crm_ai_local',
  };
}

export function opportunityTicketSnapshot(opportunity = {}) {
  const ticketId = explicitOpportunityTicketId(opportunity);
  if (!ticketId) return null;

  return {
    ...opportunity,
    id: ticketId,
    ticketId,
    status: pickValue(opportunity, ['ticket.status', 'ticketStatus', 'ticket_status']) || 'pending',
    queueId: pickValue(opportunity, ['ticket.queueId', 'ticket.queue_id', 'queueId', 'queue_id']) || null,
    userId: pickValue(opportunity, [
      'ticket.userId', 'ticket.user_id', 'responsibleId', 'responsible_id', 'userId', 'user_id',
    ]) || null,
    createdAt: pickValue(opportunity, ['ticket.createdAt', 'ticket.created_at', 'createdAt', 'created_at']) || null,
    contact: {
      id: itemContactId(opportunity) || null,
      name: adminLeadName(opportunity),
      number: normalizedItemPhone(opportunity),
    },
    pipelineId: pickValue(opportunity, ['pipelineId', 'pipeline_id', 'pipeline.id', 'kanbanId', 'kanban_id']) || null,
    stageId: pickValue(opportunity, ['stageId', 'stage_id', 'stage.id', 'kanbanStageId', 'kanban_stage_id']) || null,
    source: 'zpro_opportunity',
  };
}

function externalOpportunityIdFromResponse(data = {}) {
  return String(pickValue(data, [
    'id', 'opportunityId', 'opportunity_id', 'data.id', 'data.opportunityId',
    'data.opportunity_id', 'data.opportunity.id', 'opportunity.id', 'card.id', 'data.card.id',
  ]) || '');
}

async function ensureAdminLeadForTicket(integration, item, ticketId, targetUserId) {
  let { data: lead, error } = await supabaseAdmin
    .from('crm_ai_leads')
    .select('*')
    .eq('integration_id', integration.id)
    .eq('external_ticket_id', String(ticketId))
    .maybeSingle();
  if (error) throw error;

  const phone = normalizedItemPhone(item);
  if (!lead && phone) {
    const response = await supabaseAdmin
      .from('crm_ai_leads')
      .select('*')
      .eq('tenant_id', integration.tenant_id)
      .eq('phone', phone)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (response.error) throw response.error;
    lead = response.data;
  }

  const now = new Date().toISOString();
  if (lead) {
    const response = await supabaseAdmin
      .from('crm_ai_leads')
      .update({
        integration_id: integration.id,
        external_ticket_id: String(ticketId),
        external_contact_id: itemContactId(item) || lead.external_contact_id,
        assigned_external_user_id: targetUserId || null,
        name: adminLeadName(item) || lead.name,
        phone: phone || lead.phone,
        last_message_at: now,
        updated_at: now,
      })
      .eq('id', lead.id)
      .select('*')
      .single();
    if (response.error) throw response.error;
    return response.data;
  }

  const response = await supabaseAdmin
    .from('crm_ai_leads')
    .insert({
      tenant_id: integration.tenant_id,
      integration_id: integration.id,
      name: adminLeadName(item),
      phone: phone || String(ticketId),
      source: 'zpro_bulk_redistribution',
      external_contact_id: itemContactId(item) || null,
      external_ticket_id: String(ticketId),
      assigned_external_user_id: targetUserId || null,
      status: targetUserId ? 'transferred' : 'new',
      first_message_at: now,
      last_message_at: now,
      metadata: { imported_by_redistribution: true },
    })
    .select('*')
    .single();
  if (response.error) throw response.error;
  return response.data;
}

async function ensureAdminLocalOpportunity({
  integration,
  item,
  ticketId,
  targetUserId,
  pipelineId,
  stageId,
  externalOpportunityId,
}) {
  const lead = await ensureAdminLeadForTicket(integration, item, ticketId, targetUserId);
  const now = new Date().toISOString();
  const existing = await supabaseAdmin
    .from('crm_ai_opportunities')
    .select('*')
    .eq('integration_id', integration.id)
    .eq('external_ticket_id', String(ticketId))
    .maybeSingle();
  if (existing.error) throw existing.error;

  const payload = {
    tenant_id: integration.tenant_id,
    integration_id: integration.id,
    lead_id: lead.id,
    external_ticket_id: String(ticketId),
    external_opportunity_id: externalOpportunityId ? String(externalOpportunityId) : null,
    title: `${adminLeadName(item)} - WhatsApp`,
    pipeline_id: String(pipelineId),
    stage_id: String(stageId),
    assigned_external_user_id: targetUserId || null,
    status: 'open',
    value: 0,
    raw_data: {
      ...(existing.data?.raw_data || {}),
      synchronized_by_redistribution_at: now,
    },
    updated_at: now,
  };

  if (existing.data) {
    const response = await supabaseAdmin
      .from('crm_ai_opportunities')
      .update(payload)
      .eq('id', existing.data.id)
      .select('*')
      .single();
    if (response.error) throw response.error;
    return response.data;
  }

  const response = await supabaseAdmin
    .from('crm_ai_opportunities')
    .insert({ ...payload, created_at: now })
    .select('*')
    .single();
  if (response.error) throw response.error;
  return response.data;
}

function queueUserIds(queue = {}, users = []) {
  const raw = queue.raw_data || queue;
  const collections = [
    raw.users,
    raw.usuarios,
    raw.members,
    raw.agents,
    raw.attendants,
    raw.userQueues,
  ].filter(Array.isArray);
  const ids = collections
    .flat()
    .map((item) => String(
      item && typeof item === 'object'
        ? pickValue(item, ['id', 'userId', 'user_id', 'external_user_id']) || ''
        : item || '',
    ))
    .filter(Boolean);

  const queueId = String(queue.external_queue_id || pickValue(raw, ['id', 'queueId', 'queue_id']) || '');
  for (const user of users) {
    const userRaw = user.raw_data || user;
    const directQueueIds = [
      pickValue(userRaw, ['queueId', 'queue_id', 'queue.id']),
      ...(Array.isArray(userRaw.queueIds) ? userRaw.queueIds : []),
      ...(Array.isArray(userRaw.queues) ? userRaw.queues.map((item) => (
        item && typeof item === 'object' ? pickValue(item, ['id', 'queueId', 'queue_id']) : item
      )) : []),
    ].map((item) => String(item || '')).filter(Boolean);
    if (queueId && directQueueIds.includes(queueId)) ids.push(String(user.external_user_id));
  }

  return Array.from(new Set(ids));
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

function stageCollectionsFrom(item = {}) {
  return [
    item.stages,
    item.steps,
    item.columns,
    item.kanbanStages,
    item.kanban_stages,
    item.etapas,
    item.fases,
    item.children,
  ].filter(Array.isArray);
}

function extractNestedStageItems(data, integration, filters = {}) {
  const roots = [];
  const normalized = normalizeList(data);
  if (normalized.length > 0) roots.push(...normalized);
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    roots.push(data);
    if (data.data && typeof data.data === 'object' && !Array.isArray(data.data)) {
      roots.push(data.data);
    }
  }

  const stages = [];
  for (const root of roots) {
    if (!root || typeof root !== 'object') continue;

    const pipelineId =
      pickValue(root, [
        'id',
        'pipelineId',
        'pipeline_id',
        'kanbanId',
        'kanban_id',
        'funnelId',
        'funilId',
        'external_pipeline_id',
      ]) || filters.pipelineId || filters.external_pipeline_id || integration.pipeline_id;

    for (const collection of stageCollectionsFrom(root)) {
      for (const stage of collection) {
        if (!stage || typeof stage !== 'object') continue;
        stages.push({
          ...stage,
          pipelineId:
            pickValue(stage, [
              'pipelineId',
              'pipeline_id',
              'kanbanId',
              'kanban_id',
              'funnelId',
              'funilId',
              'external_pipeline_id',
            ]) || pipelineId,
        });
      }
    }
  }

  return stages;
}

function cacheConflictKey(kind, row = {}) {
  if (kind === 'users') return `${row.integration_id}:${row.external_user_id}`;
  if (kind === 'queues') return `${row.integration_id}:${row.external_queue_id}`;
  if (kind === 'pipelines') return `${row.integration_id}:${row.external_pipeline_id}`;
  if (kind === 'stages') {
    return `${row.integration_id}:${row.external_pipeline_id}:${row.external_stage_id}`;
  }
  return JSON.stringify(row);
}

function dedupeCacheRows(kind, rows = []) {
  const map = new Map();
  for (const row of rows) {
    map.set(cacheConflictKey(kind, row), row);
  }
  return Array.from(map.values());
}

function normalizeDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeToken(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeFilterIds(...values) {
  return values
    .flatMap((value) => String(value || '').split(','))
    .map((value) => value.trim())
    .filter(Boolean);
}

function itemMatchesAnyId(item, paths, expected = []) {
  if (expected.length === 0) return true;

  const actualValues = paths
    .map((path) => pickValue(item, [path]))
    .filter((value) => value !== undefined && value !== null && value !== '')
    .map((value) => String(value));

  if (actualValues.length === 0) return false;

  return actualValues.some((actual) =>
    expected.some((target) => actual === target || normalizeDigits(actual) === normalizeDigits(target)),
  );
}

function itemMatchesStatus(item, statusFilter) {
  const statuses = normalizeFilterIds(statusFilter).map(normalizeToken);
  if (statuses.length === 0) return true;

  const actual = normalizeToken(
    pickValue(item, [
      'status',
      'ticket.status',
      'opportunity.status',
      'state',
      'situacao',
    ]),
  );

  return Boolean(actual && statuses.includes(actual));
}

function parseDateBound(value, endOfDay = false) {
  if (!value) return null;
  const text = String(value);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? new Date(`${text}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}`)
    : new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getLiveItemCreatedAt(item = {}) {
  const value = pickValue(item, [
    'createdAt',
    'created_at',
    'created',
    'date',
    'ticket.createdAt',
    'ticket.created_at',
    'contact.createdAt',
    'contact.created_at',
    'opportunity.createdAt',
    'opportunity.created_at',
  ]);
  if (!value) return null;

  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function itemMatchesDateRange(item, filters = {}) {
  const from = parseDateBound(filters.dateFrom || filters.createdFrom || filters.startDate, false);
  const to = parseDateBound(filters.dateTo || filters.createdTo || filters.endDate, true);
  if (!from && !to) return true;

  const createdAt = getLiveItemCreatedAt(item);
  if (!createdAt) return false;
  if (from && createdAt < from) return false;
  if (to && createdAt > to) return false;
  return true;
}

function filterLiveItems(items = [], filters = {}) {
  const userIds = normalizeFilterIds(filters.userId, filters.assignedUserId, filters.user_id);
  const queueIds = normalizeFilterIds(filters.queueId, filters.queue_id);
  const pipelineIds = normalizeFilterIds(filters.pipelineId, filters.pipeline_id);
  const stageIds = normalizeFilterIds(filters.stageId, filters.stage_id);

  return items.filter((item) => {
    if (
      !itemMatchesAnyId(
        item,
        [
          'userId',
          'user_id',
          'user.id',
          'assignedUserId',
          'assigned_user_id',
          'assignedUser.id',
          'assigned_user.id',
          'responsibleId',
          'responsible_id',
          'responsible.id',
          'usuario.id',
          'atendente.id',
        ],
        userIds,
      )
    ) return false;

    if (
      !itemMatchesAnyId(
        item,
        [
          'queueId',
          'queue_id',
          'queue.id',
          'filaId',
          'fila_id',
          'fila.id',
        ],
        queueIds,
      )
    ) return false;

    if (
      !itemMatchesAnyId(
        item,
        [
          'pipelineId',
          'pipeline_id',
          'pipeline.id',
          'kanbanId',
          'kanban_id',
          'kanban.id',
          'opportunity.pipelineId',
          'opportunity.pipeline_id',
          'opportunity.pipeline.id',
        ],
        pipelineIds,
      )
    ) return false;

    if (
      !itemMatchesAnyId(
        item,
        [
          'stageId',
          'stage_id',
          'stage.id',
          'kanbanStageId',
          'kanban_stage_id',
          'kanbanStage.id',
          'opportunity.stageId',
          'opportunity.stage_id',
          'opportunity.stage.id',
        ],
        stageIds,
      )
    ) return false;

    if (!itemMatchesStatus(item, filters.status)) return false;
    if (!itemMatchesDateRange(item, filters)) return false;
    return true;
  });
}

function getLeadDedupeKey(lead = {}) {
  const externalId = getLeadExternalId(lead);
  if (externalId) return `external:${externalId}`;

  const phone = normalizeDigits(
    pickValue(lead, [
      'phone',
      'number',
      'contactNumber',
      'contact_number',
      'contact.phone',
      'contact.number',
      'contact.waId',
      'contact.wa_id',
      'customer.phone',
      'customer.number',
      'ticket.contact.number',
      'ticket.contact.phone',
    ]),
  );

  if (phone) return `phone:${phone}`;

  const contactId = pickValue(lead, [
    'contactId',
    'contact_id',
    'contact.id',
    'customerId',
    'customer_id',
    'customer.id',
  ]);

  if (contactId) return `contact:${contactId}`;
  return '';
}

export function dedupeItems(items = []) {
  const unique = new Map();
  let fallbackIndex = 0;

  for (const item of items) {
    const key = getLeadDedupeKey(item);
    const dedupeKey = key || `fallback:${fallbackIndex++}`;
    if (!unique.has(dedupeKey)) unique.set(dedupeKey, item);
  }

  return Array.from(unique.values());
}

function asPositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function paginationDetails(data = {}, items = [], filters = {}) {
  const currentPage =
    asPositiveNumber(
      pickValue(data, [
        'page',
        'currentPage',
        'current_page',
        'pagination.page',
        'pagination.currentPage',
        'meta.page',
        'meta.currentPage',
      ]),
    ) || asPositiveNumber(filters.page) || 1;
  const totalPages = asPositiveNumber(
    pickValue(data, [
      'totalPages',
      'total_pages',
      'pages',
      'pageCount',
      'page_count',
      'pagination.totalPages',
      'pagination.total_pages',
      'meta.totalPages',
      'meta.total_pages',
      'meta.pages',
    ]),
  );
  const totalCount = asPositiveNumber(
    pickValue(data, [
      'total',
      'count',
      'totalCount',
      'total_count',
      'pagination.total',
      'pagination.totalCount',
      'meta.total',
      'meta.totalCount',
    ]),
  );
  const hasMore = ['hasMore', 'has_more', 'pagination.hasMore', 'pagination.has_more'].some(
    (path) => pickValue(data, [path]) === true,
  );

  return {
    currentPage,
    totalPages,
    totalCount,
    hasMore: Boolean(hasMore || (totalPages && currentPage < totalPages)),
    pageSize: items.length,
  };
}

async function readZproPagedList(zpro, methodName, filters = {}) {
  const maxPages = Math.min(100, Math.max(1, Number(filters.maxPages || filters.max_pages || 10)));
  const cleanFilters = { ...filters };
  delete cleanFilters.maxPages;
  delete cleanFilters.max_pages;

  const first = await zpro[methodName](cleanFilters);
  const firstItems = normalizeList(first.data);
  const details = paginationDetails(first.data, firstItems, cleanFilters);
  const allItems = [...firstItems];
  const pageErrors = [];
  let pagesRead = 1;
  const pageKey =
    Object.hasOwn(cleanFilters, 'pageNumber') || methodName === 'listTickets' || methodName === 'listUsers'
      ? 'pageNumber'
      : 'page';

  if (details.totalPages && details.totalPages > details.currentPage) {
    const lastPage = Math.min(details.totalPages, maxPages);
    for (let page = details.currentPage + 1; page <= lastPage; page += 1) {
      try {
        const next = await zpro[methodName]({
          ...cleanFilters,
          [pageKey]: page,
        });
        allItems.push(...normalizeList(next.data));
        pagesRead = page;
      } catch (err) {
        pageErrors.push({
          page,
          error: err.message || String(err),
        });
        break;
      }
    }
  } else if (details.hasMore) {
    for (let page = details.currentPage + 1; page <= details.currentPage + maxPages - 1; page += 1) {
      try {
        const next = await zpro[methodName]({
          ...cleanFilters,
          [pageKey]: page,
        });
        const nextItems = normalizeList(next.data);
        const nextDetails = paginationDetails(next.data, nextItems, { ...cleanFilters, page });
        allItems.push(...nextItems);
        pagesRead = page;
        if (!nextDetails.hasMore || nextItems.length === 0) break;
      } catch (err) {
        pageErrors.push({
          page,
          error: err.message || String(err),
        });
        break;
      }
    }
  } else if (firstItems.length > 0 && maxPages > 1) {
    const seen = new Set(firstItems.map((item, index) => getLeadDedupeKey(item) || `first:${index}`));

    for (let page = details.currentPage + 1; page <= details.currentPage + maxPages - 1; page += 1) {
      try {
        const next = await zpro[methodName]({
          ...cleanFilters,
          [pageKey]: page,
        });
        const nextItems = normalizeList(next.data);
        if (nextItems.length === 0) break;

        let newItems = 0;
        for (const item of nextItems) {
          const key = getLeadDedupeKey(item) || `${page}:${newItems}`;
          if (!seen.has(key)) {
            seen.add(key);
            newItems += 1;
          }
        }

        allItems.push(...nextItems);
        pagesRead = page;
        if (newItems === 0) break;
      } catch (err) {
        pageErrors.push({
          page,
          error: err.message || String(err),
        });
        break;
      }
    }
  }

  return {
    endpoint: first.endpoint,
    method: first.method,
    data: first.data,
    items: allItems,
    pagination: {
      ...details,
      pagesRead,
      maxPages,
      pageErrors,
    },
  };
}

async function readLocalLeadTickets(integration, limit = 5000) {
  const pageSize = 1000;
  const rows = [];
  const boundedLimit = Math.max(1, Math.min(5000, Number(limit || 5000)));

  for (let offset = 0; offset < boundedLimit; offset += pageSize) {
    const upper = Math.min(offset + pageSize, boundedLimit) - 1;
    const response = await supabaseAdmin
      .from('crm_ai_leads')
      .select('*')
      .eq('tenant_id', integration.tenant_id)
      .eq('integration_id', integration.id)
      .not('external_ticket_id', 'is', null)
      .order('last_message_at', { ascending: false })
      .range(offset, upper);
    if (response.error) throw response.error;
    const page = response.data || [];
    rows.push(...page);
    if (page.length < upper - offset + 1) break;
  }

  return rows.map(localLeadTicketSnapshot).filter(Boolean);
}

export function distributeItems(items = [], targetUsers = [], mode = 'balanced', targetQueueId = '') {
  const activeUsers = targetUsers
    .map((user) => ({
      id: String(user.id || user.external_user_id || user.externalUserId || ''),
      name: String(user.name || user.label || user.id || user.external_user_id || ''),
      quantity: Number(user.quantity || 0),
    }))
    .filter((user) => user.id);

  if (activeUsers.length === 0) {
    throw httpError(400, 'Selecione ao menos um atendente de destino');
  }

  let expandedUsers = activeUsers;
  if (mode === 'quantity') {
    expandedUsers = activeUsers.flatMap((user) =>
      Array.from({ length: Math.max(0, user.quantity) }, () => user),
    );

    if (expandedUsers.length === 0) {
      throw httpError(400, 'Informe a quantidade de cada atendente');
    }
  }

  return items.map((item, index) => {
    const target = expandedUsers[index % expandedUsers.length];
    return {
      item,
      itemId: getLeadExternalId(item),
      targetUserId: target.id,
      targetUserName: target.name,
      targetQueueId: String(targetQueueId || ''),
    };
  });
}

function ticketAssignmentState(data = {}) {
  return {
    userId: String(pickValue(data, [
      'userId', 'user_id', 'data.userId', 'data.user_id', 'ticket.userId', 'ticket.user_id',
      'data.ticket.userId', 'data.ticket.user_id', 'user.id', 'data.user.id',
    ]) || ''),
    queueId: String(pickValue(data, [
      'queueId', 'queue_id', 'data.queueId', 'data.queue_id', 'ticket.queueId', 'ticket.queue_id',
      'data.ticket.queueId', 'data.ticket.queue_id', 'queue.id', 'data.queue.id',
    ]) || ''),
    status: String(pickValue(data, ['status', 'data.status', 'ticket.status', 'data.ticket.status']) || '').toLowerCase(),
  };
}

async function verifyAdminTicketAssignment(zpro, ticketId, expected, attempts = 2) {
  let lastState = {};
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await zpro.showTicket(ticketId);
    lastState = ticketAssignmentState(response.data || {});
    const matched = (
      (!expected.userId || lastState.userId === String(expected.userId))
      && (!expected.queueId || lastState.queueId === String(expected.queueId))
      && (!expected.status || lastState.status === String(expected.status).toLowerCase())
    );
    if (matched) return { verified: true, state: lastState, endpoint: response.endpoint };
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return { verified: false, state: lastState, endpoint: null };
}

function readActive(item = {}) {
  const explicit = pickValue(item, ['active', 'isActive', 'enabled']);
  if (explicit === false || explicit === 'false' || explicit === 0 || explicit === '0') return false;
  const status = String(pickValue(item, ['status']) || '').toLowerCase();
  return !['inactive', 'disabled', 'closed', 'deleted', 'inativo'].includes(status);
}

const ZPRO_CACHE_TABLES = {
  users: {
    table: 'crm_ai_zpro_users_cache',
    conflict: 'integration_id,external_user_id',
  },
  queues: {
    table: 'crm_ai_zpro_queues_cache',
    conflict: 'integration_id,external_queue_id',
  },
  pipelines: {
    table: 'crm_ai_zpro_pipelines_cache',
    conflict: 'integration_id,external_pipeline_id',
  },
  stages: {
    table: 'crm_ai_zpro_stages_cache',
    conflict: 'integration_id,external_pipeline_id,external_stage_id',
  },
};

function mapCacheRows(kind, items, integration, filters = {}) {
  return items
    .map((item) => {
      if (kind === 'users') {
        const externalId = pickValue(item, ['id', 'userId', 'user_id', 'externalId', 'external_id']);
        if (!externalId) return null;

        return {
          tenant_id: integration.tenant_id,
          integration_id: integration.id,
          external_user_id: String(externalId),
          name: String(pickValue(item, ['name', 'username', 'displayName', 'display_name', 'nome']) || externalId),
          email: pickValue(item, ['email', 'mail']) || null,
          active: readActive(item),
          raw_data: item,
          synced_at: new Date().toISOString(),
        };
      }

      if (kind === 'queues') {
        const externalId = pickValue(item, ['id', 'queueId', 'queue_id', 'externalId', 'external_id']);
        if (!externalId) return null;

        return {
          tenant_id: integration.tenant_id,
          integration_id: integration.id,
          external_queue_id: String(externalId),
          name: String(pickValue(item, ['name', 'title', 'label', 'queue', 'nome']) || externalId),
          active: readActive(item),
          raw_data: item,
          synced_at: new Date().toISOString(),
        };
      }

      if (kind === 'pipelines') {
        const externalId = pickValue(item, [
          'id',
          'pipelineId',
          'pipeline_id',
          'kanbanId',
          'kanban_id',
          'funnelId',
          'funilId',
          'externalId',
          'external_id',
        ]);
        if (!externalId) return null;

        return {
          tenant_id: integration.tenant_id,
          integration_id: integration.id,
          external_pipeline_id: String(externalId),
          name: String(pickValue(item, ['name', 'title', 'label', 'pipeline', 'kanban', 'nome']) || externalId),
          active: readActive(item),
          raw_data: item,
          synced_at: new Date().toISOString(),
        };
      }

      if (kind === 'stages') {
        const externalStageId = pickValue(item, [
          'id',
          'stageId',
          'stage_id',
          'stepId',
          'step_id',
          'columnId',
          'column_id',
          'kanbanStageId',
          'kanban_stage_id',
          'externalId',
          'external_id',
        ]);
        const externalPipelineId =
          pickValue(item, [
            'pipelineId',
            'pipeline_id',
            'kanbanId',
            'kanban_id',
            'funnelId',
            'funilId',
            'pipeline.id',
            'kanban.id',
          ]) || filters.pipelineId || filters.external_pipeline_id || integration.pipeline_id;

        if (!externalStageId || !externalPipelineId) return null;

        return {
          tenant_id: integration.tenant_id,
          integration_id: integration.id,
          external_pipeline_id: String(externalPipelineId),
          external_stage_id: String(externalStageId),
          name: String(pickValue(item, ['name', 'title', 'label', 'stage', 'step', 'nome']) || externalStageId),
          position: Number(pickValue(item, ['position', 'order', 'sort', 'index']) ?? null) || null,
          color: pickValue(item, ['color', 'hex', 'backgroundColor']) || null,
          active: readActive(item),
          raw_data: item,
          synced_at: new Date().toISOString(),
        };
      }

      return null;
    })
    .filter(Boolean);
}

async function syncZproCache(integration, kind, filters = {}) {
  const config = ZPRO_CACHE_TABLES[kind];
  const reader = ZPRO_READERS[kind];
  if (!config || !reader) throw httpError(404, 'Recurso Z-PRO nao reconhecido para cache');

  const zpro = await createZproService(integration);
  const response = await readZproPagedList(zpro, reader.method, filters);
  const items = response.items;
  const sourceItems =
    kind === 'stages'
      ? [...items, ...extractNestedStageItems(response.data, integration, filters)]
      : items;
  const rows = dedupeCacheRows(kind, mapCacheRows(kind, sourceItems, integration, filters));

  if (rows.length > 0) {
    const { error } = await supabaseAdmin
      .from(config.table)
      .upsert(rows, { onConflict: config.conflict });
    if (error) throw error;
  }

  let nestedStagesSaved = 0;
  if (kind === 'pipelines') {
    const nestedStageRows = dedupeCacheRows(
      'stages',
      mapCacheRows('stages', extractNestedStageItems(response.data, integration, filters), integration, filters),
    );

    if (nestedStageRows.length > 0) {
      const { error } = await supabaseAdmin
        .from(ZPRO_CACHE_TABLES.stages.table)
        .upsert(nestedStageRows, { onConflict: ZPRO_CACHE_TABLES.stages.conflict });
      if (error) throw error;
      nestedStagesSaved = nestedStageRows.length;
    }
  }

  return {
    ok: true,
    kind,
    endpoint: response.endpoint,
    method: response.method,
    received: items.length,
    saved: rows.length,
    nestedStagesSaved,
    pagination: response.pagination,
    items: rows,
  };
}

async function syncZproReferenceSet(integration, kinds = [], filters = {}) {
  const results = [];

  async function pushSync(kind, nextFilters = {}) {
    try {
      results.push(await syncZproCache(integration, kind, nextFilters));
    } catch (err) {
      results.push({
        ok: false,
        kind,
        error: err.message || String(err),
        code: err.code || 'ZPRO_SYNC_FAILED',
        attempts: err.attempts,
      });
    }
  }

  for (const kind of kinds) {
    if (kind !== 'stages' || filters.pipelineId || filters.external_pipeline_id) {
      await pushSync(kind, filters);
      continue;
    }

    const { data: pipelines, error } = await supabaseAdmin
      .from('crm_ai_zpro_pipelines_cache')
      .select('external_pipeline_id')
      .eq('tenant_id', integration.tenant_id)
      .eq('integration_id', integration.id)
      .eq('active', true);

    if (error) throw error;

    if (!pipelines?.length) {
      await pushSync('stages', filters);
      continue;
    }

    for (const pipeline of pipelines) {
      await pushSync('stages', {
        ...filters,
        pipelineId: pipeline.external_pipeline_id,
      });
    }
  }

  return results;
}

adminRouter.get('/debug/integrations', requireAdminApiKey, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('crm_ai_integrations')
      .select(INTEGRATION_SAFE_SELECT)
      .order('created_at', { ascending: false });

    if (error) throw error;

    return res.json({
      ok: true,
      integrations: (data || []).map(cleanIntegration),
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/debug/followups', requireAdminApiKey, async (req, res, next) => {
  try {
    const statuses = ['pending', 'running', 'sent', 'cancelled', 'failed'];
    const counts = await Promise.all(statuses.map(async (status) => {
      const { count, error } = await supabaseAdmin
        .from('crm_ai_followup_jobs')
        .select('id', { count: 'exact', head: true })
        .eq('status', status);
      if (error) throw error;
      return [status, count || 0];
    }));

    return res.json({
      ok: true,
      worker: getFollowupWorkerStatus(),
      jobs: Object.fromEntries(counts),
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/debug/followups/run', requireAdminApiKey, async (req, res, next) => {
  try {
    const result = await runFollowupCycle();
    return res.json({ ok: true, result, worker: getFollowupWorkerStatus() });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/integrations/zpro', async (req, res, next) => {
  try {
    const tenantId = String(req.query.tenantId || req.query.tenant_id || '').trim();
    if (!tenantId) throw httpError(400, 'tenantId obrigatorio');
    await assertCanManageTenant(req, tenantId);

    const { data, error } = await supabaseAdmin
      .from('crm_ai_integrations')
      .select(INTEGRATION_SAFE_SELECT)
      .eq('tenant_id', tenantId)
      .eq('provider', 'zpro')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return res.json({ ok: true, integration: cleanIntegration(data) });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/integrations/zpro', async (req, res, next) => {
  try {
    const body = req.body || {};
    const integrationId = body.id || body.integrationId || null;
    const token = body.token || '';
    const payload = {
      ...pickIntegrationPayload(body),
      provider: 'zpro',
      name: body.name || 'Z-PRO',
    };

    let integration = null;
    let requester = null;

    if (integrationId) {
      integration = await loadIntegration(integrationId);
      requester = await assertCanAdminTenant(req, integration.tenant_id);

      if (payload.tenant_id && payload.tenant_id !== integration.tenant_id) {
        throw httpError(400, 'Nao e permitido trocar a empresa da integracao');
      }

      delete payload.tenant_id;

      const { data, error } = await supabaseAdmin
        .from('crm_ai_integrations')
        .update(payload)
        .eq('id', integration.id)
        .select('*')
        .single();

      if (error) throw error;
      integration = data;
    } else {
      if (!payload.tenant_id) throw httpError(400, 'tenant_id obrigatorio');
      if (!payload.base_url) throw httpError(400, 'URL do Z-PRO obrigatoria');

      requester = await assertCanAdminTenant(req, payload.tenant_id);

      const { data: existing, error: existingError } = await supabaseAdmin
        .from('crm_ai_integrations')
        .select('*')
        .eq('tenant_id', payload.tenant_id)
        .eq('provider', 'zpro')
        .maybeSingle();

      if (existingError) throw existingError;

      if (existing) {
        const { data, error } = await supabaseAdmin
          .from('crm_ai_integrations')
          .update(payload)
          .eq('id', existing.id)
          .select('*')
          .single();

        if (error) throw error;
        integration = data;
      } else {
        const { data, error } = await supabaseAdmin
          .from('crm_ai_integrations')
          .insert(payload)
          .select('*')
          .single();

        if (error) throw error;
        integration = data;
      }
    }

    if (token) {
      await saveZproToken(integration.id, token);
      integration = await loadIntegration(integration.id);
    }

    integration = await ensureIntegrationWebhookId(integration);
    const agent = await ensureIntegrationAgent(integration, requester?.userId || null);

    logInfo('admin.zpro.integration_saved', {
      requestId: req.requestId,
      integration: cleanIntegration(integration),
      agentId: agent?.id || null,
      tokenReceived: Boolean(token),
    });

    return res.json({
      ok: true,
      integration: cleanIntegration(integration),
      agent: agent ? { id: agent.id, name: agent.name, enabled: agent.enabled } : null,
      message: token ? 'Configuracao e token salvos com sucesso.' : 'Configuracao salva com sucesso.',
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/integrations/:integrationId/zpro/token', async (req, res, next) => {
  try {
    const integration = await loadIntegration(req.params.integrationId);
    const requester = await assertCanAdminTenant(req, integration.tenant_id);
    await saveZproToken(integration.id, req.body?.token);
    const readyIntegration = await ensureIntegrationWebhookId(await loadIntegration(integration.id));
    await ensureIntegrationAgent(readyIntegration, requester?.userId || null);

    logInfo('admin.zpro.token_saved', {
      requestId: req.requestId,
      integrationId: integration.id,
      tenantId: integration.tenant_id,
    });

    return res.json({
      ok: true,
      message: 'Token salvo com sucesso.',
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/integrations/:integrationId/zpro/readiness', async (req, res, next) => {
  try {
    let integration = await loadIntegration(req.params.integrationId);
    await assertCanManageTenant(req, integration.tenant_id);
    integration = await ensureIntegrationWebhookId(integration);

    const { data: agents, error } = await supabaseAdmin
      .from('crm_ai_agents')
      .select('id,name,enabled,settings')
      .eq('tenant_id', integration.tenant_id);
    if (error) throw error;

    const matchingAgents = (agents || []).filter((agent) => (
      !agent.settings?.integration_id
      || String(agent.settings.integration_id) === String(integration.id)
    ));
    const activeAgents = matchingAgents.filter((agent) => agent.enabled === true);
    const forwardedProtocol = String(req.headers['x-forwarded-proto'] || '')
      .split(',')[0]
      .trim();
    const protocol = forwardedProtocol || req.protocol;
    const origin = String(process.env.PUBLIC_BACKEND_URL || `${protocol}://${req.get('host')}`).replace(/\/+$/, '');
    const webhookUrl = `${origin}/webhooks/zpro/${integration.webhook_public_id}`;
    const checks = {
      active: integration.active === true,
      token: integration.has_token === true,
      webhook: Boolean(integration.webhook_public_id),
      agent: activeAgents.length > 0,
    };

    return res.json({
      ok: Object.values(checks).every(Boolean),
      checks,
      webhookUrl,
      integration: cleanIntegration(integration),
      agents: activeAgents.map((agent) => ({ id: agent.id, name: agent.name })),
      message: Object.values(checks).every(Boolean)
        ? 'Integracao pronta para receber mensagens.'
        : 'Existem itens pendentes na configuracao.',
    });
  } catch (err) {
    next(err);
  }
});

async function testZproConnection(req, res, next) {
  try {
    const integration = await loadIntegration(getIntegrationId(req));
    await assertCanManageTenant(req, integration.tenant_id);

    const zpro = await createZproService(integration);
    let queues = null;

    try {
      queues = await zpro.listQueues();
    } catch (err) {
      queues = {
        ok: false,
        warning: 'Token/base_url carregaram, mas a consulta de filas falhou.',
        message: err.message || String(err),
        code: err.code || 'ZPRO_QUEUE_TEST_FAILED',
      };
    }

    return res.json({
      ok: true,
      integration: cleanIntegration(integration),
      queues,
    });
  } catch (err) {
    next(err);
  }
}

adminRouter.post('/integrations/zpro/test', testZproConnection);
adminRouter.post('/integrations/:integrationId/zpro/test', testZproConnection);

async function readZproResource(req, res, next) {
  try {
    const kind = req.params.kind || req.routeResourceKind;
    const reader = ZPRO_READERS[kind];

    if (!reader) throw httpError(404, 'Recurso Z-PRO nao reconhecido');

    const integration = await loadIntegration(getIntegrationId(req));
    await assertCanManageTenant(req, integration.tenant_id);

    const zpro = await createZproService(integration);

    try {
      const data = await zpro[reader.method](compactObject(req.query || {}));

      logInfo('admin.zpro.resource_read', {
        requestId: req.requestId,
        integrationId: integration.id,
        tenantId: integration.tenant_id,
        resource: kind,
      });

      return res.json({
        ok: true,
        resource: kind,
        label: reader.label,
        integration: cleanIntegration(integration),
        data: sanitizeObject(data),
        items: sanitizeObject(normalizeList(data?.data ?? data)),
      });
    } catch (err) {
      logWarn('admin.zpro.resource_failed', {
        requestId: req.requestId,
        integrationId: integration.id,
        tenantId: integration.tenant_id,
        resource: kind,
        error: err.message || String(err),
        code: err.code,
      });

      return zproErrorResponse(res, err);
    }
  } catch (err) {
    next(err);
  }
}

for (const kind of Object.keys(ZPRO_READERS)) {
  adminRouter.get(`/integrations/zpro/${kind}`, (req, res, next) => {
    req.routeResourceKind = kind;
    return readZproResource(req, res, next);
  });

  adminRouter.get(`/integrations/:integrationId/zpro/${kind}`, (req, res, next) => {
    req.routeResourceKind = kind;
    return readZproResource(req, res, next);
  });
}

adminRouter.get('/integrations/:integrationId/zpro/:kind', readZproResource);

adminRouter.get('/zpro/debug/endpoints', async (req, res, next) => {
  try {
    const integration = await loadIntegration(getIntegrationId(req));
    await assertCanManageTenant(req, integration.tenant_id);
    const zpro = await createZproService(integration);

    const resources = ['users', 'queues', 'channels', 'pipelines', 'stages', 'tickets', 'opportunities', 'appointments'];
    const endpoints = {
      users: zpro.endpointAliases('users', ['listUsers', 'users', 'listAgents', 'agents']),
      queues: zpro.endpointAliases('queues', ['listQueues', 'queues']),
      channels: zpro.endpointAliases('channels', [
        'listSessions',
        'listWhatsapps',
        'listChannels',
        'sessions',
        'channels',
        'whatsapps',
      ]),
      pipelines: zpro.endpointAliases('pipelines', [
        'pipeline/list',
        'listKanbans',
        'kanbans',
        'kanban',
        'kanban/list',
        'listPipelines',
        'pipelines',
        'pipelines/list',
        'pipeline',
        'listFunnels',
        'funnels',
        'funis',
        'funnel',
        'funil/pipelines',
        'funil/kanban',
        'funil/kanbans',
        'funil/list',
        'crm/pipelines',
        'crm/kanbans',
        'crm/funil/pipelines',
        'crm/funil/kanban',
      ]),
      stages: zpro.endpointAliases('stages', [
        'stage/list',
        'listKanbanStages',
        'kanbanStages',
        'kanban/stages',
        'kanban/{pipelineId}/stages',
        'listPipelineStages',
        'pipelineStages',
        'pipeline/stages',
        'pipeline/{pipelineId}/stages',
        'pipelines/{pipelineId}/stages',
        'listStages',
        'stages',
        'stages/list',
        'steps',
        'funil/stages',
        'funil/etapas',
        'funil/kanban/stages',
        'funil/kanban/{pipelineId}/stages',
        'funil/pipelines/{pipelineId}/stages',
        'funil/{pipelineId}/stages',
        'crm/stages',
        'crm/kanban/stages',
        'crm/funil/stages',
      ]),
      tickets: zpro.endpointAliases('tickets', [
        'listTickets',
        'tickets',
        'tickets/list',
        'findTickets',
        'searchTickets',
        'findTicket',
        'searchTicket',
        'atendimentos',
        'atendimentos/list',
        'funil/tickets',
        'funil/kanban',
        'funil/kanban/tickets',
        'crm/tickets',
      ]),
      opportunities: zpro.endpointAliases('opportunities', [
        'listOpportunities',
        'opportunities',
        'opportunity',
        'listKanbanCards',
        'kanbanCards',
        'kanban/cards',
        'kanban/cards/list',
        'kanban/list',
        'cards',
        'cards/list',
        'funil/kanban',
        'funil/kanban/cards',
        'funil/cards',
        'crm/opportunities',
        'crm/kanban/cards',
        'crm/funil/kanban/cards',
      ]),
      appointments: zpro.endpointAliases('appointments', ['appointment/list']),
      createAppointment: zpro.endpointAliases('create_appointment', ['appointment/create']),
      showTicket: zpro.endpointAliases('show_ticket', ['showTicketById']),
    };

    return res.json({
      ok: true,
      resources,
      endpoints,
      envKeys: [
        'ZPRO_ENDPOINT_USERS',
        'ZPRO_ENDPOINT_QUEUES',
        'ZPRO_ENDPOINT_CHANNELS',
        'ZPRO_ENDPOINT_PIPELINES',
        'ZPRO_ENDPOINT_STAGES',
        'ZPRO_ENDPOINT_TICKETS',
        'ZPRO_ENDPOINT_OPPORTUNITIES',
        'ZPRO_ENDPOINT_ASSIGN_TICKET',
        'ZPRO_ENDPOINT_SHOW_TICKET',
        'ZPRO_ENDPOINT_MOVE_OPPORTUNITY',
        'ZPRO_ENDPOINT_APPOINTMENTS',
        'ZPRO_ENDPOINT_CREATE_APPOINTMENT',
      ],
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/integrations/:integrationId/zpro/sync/:kind', async (req, res, next) => {
  try {
    const integration = await loadIntegration(getIntegrationId(req));
    await assertCanAdminTenant(req, integration.tenant_id);

    const kind = req.params.kind;
    const filters = compactObject(req.body?.filters || req.query || {});
    const kinds = kind === 'all' ? ['users', 'queues', 'pipelines', 'stages'] : [kind];
    const results = await syncZproReferenceSet(integration, kinds, filters);

    return res.json({
      ok: true,
      integration: cleanIntegration(integration),
      results: sanitizeObject(results),
    });
  } catch (err) {
    return zproErrorResponse(res, err);
  }
});

adminRouter.post('/zpro/reference/sync', async (req, res, next) => {
  try {
    const integration = await loadIntegration(getIntegrationId(req));
    await assertCanAdminTenant(req, integration.tenant_id);

    const kind = req.body?.kind || req.query?.kind || 'all';
    const filters = compactObject(req.body?.filters || req.query || {});
    const kinds = kind === 'all' ? ['users', 'queues', 'pipelines', 'stages'] : [kind];
    const results = await syncZproReferenceSet(integration, kinds, filters);

    return res.json({
      ok: true,
      integration: cleanIntegration(integration),
      results: sanitizeObject(results),
    });
  } catch (err) {
    return zproErrorResponse(res, err);
  }
});

adminRouter.get('/zpro/reference', async (req, res, next) => {
  try {
    const integration = await loadIntegration(getIntegrationId(req));
    await assertCanManageTenant(req, integration.tenant_id);

    const [users, queues, pipelines, stages, rules] = await Promise.all([
      supabaseAdmin
        .from('crm_ai_zpro_users_cache')
        .select('*')
        .eq('tenant_id', integration.tenant_id)
        .eq('integration_id', integration.id)
        .order('name', { ascending: true }),
      supabaseAdmin
        .from('crm_ai_zpro_queues_cache')
        .select('*')
        .eq('tenant_id', integration.tenant_id)
        .eq('integration_id', integration.id)
        .order('name', { ascending: true }),
      supabaseAdmin
        .from('crm_ai_zpro_pipelines_cache')
        .select('*')
        .eq('tenant_id', integration.tenant_id)
        .eq('integration_id', integration.id)
        .order('name', { ascending: true }),
      supabaseAdmin
        .from('crm_ai_zpro_stages_cache')
        .select('*')
        .eq('tenant_id', integration.tenant_id)
        .eq('integration_id', integration.id)
        .order('position', { ascending: true }),
      supabaseAdmin
        .from('crm_ai_stage_assignment_rules')
        .select('*')
        .eq('tenant_id', integration.tenant_id)
        .eq('integration_id', integration.id),
    ]);

    for (const result of [users, queues, pipelines, stages, rules]) {
      if (result.error) throw result.error;
    }

    return res.json({
      ok: true,
      integration: cleanIntegration(integration),
      users: users.data || [],
      queues: (queues.data || []).map((queue) => ({
        ...queue,
        user_ids: queueUserIds(queue, users.data || []),
      })),
      pipelines: pipelines.data || [],
      stages: stages.data || [],
      rules: rules.data || [],
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/zpro/stage-rules', async (req, res, next) => {
  try {
    const integration = await loadIntegration(getIntegrationId(req));
    await assertCanManageTenant(req, integration.tenant_id);

    const { data, error } = await supabaseAdmin
      .from('crm_ai_stage_assignment_rules')
      .select('*')
      .eq('tenant_id', integration.tenant_id)
      .eq('integration_id', integration.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    return res.json({
      ok: true,
      rules: data || [],
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/zpro/stage-rules', async (req, res, next) => {
  try {
    const body = req.body || {};
    const integration = await loadIntegration(getIntegrationId(req));
    await assertCanAdminTenant(req, integration.tenant_id);

    const payload = {
      tenant_id: integration.tenant_id,
      integration_id: integration.id,
      external_pipeline_id: String(body.external_pipeline_id || body.pipelineId || ''),
      external_stage_id: String(body.external_stage_id || body.stageId || ''),
      external_queue_id: body.external_queue_id || body.queueId || null,
      distribution_mode: body.distribution_mode || body.distributionMode || 'balanced_rotation',
      user_order: Array.isArray(body.user_order)
        ? body.user_order
        : Array.isArray(body.userOrder)
          ? body.userOrder
          : [],
      routing_instruction: body.routing_instruction || body.routingInstruction || null,
      handoff_message: body.handoff_message || body.handoffMessage || null,
      stop_ai_after_match: body.stop_ai_after_match ?? body.stopAiAfterMatch ?? false,
      close_ticket_on_match: body.close_ticket_on_match ?? body.closeTicketOnMatch ?? false,
      active: body.active !== false,
    };

    if (!payload.external_pipeline_id) throw httpError(400, 'Funil obrigatorio');
    if (!payload.external_stage_id) throw httpError(400, 'Etapa obrigatoria');

    const { data, error } = await supabaseAdmin
      .from('crm_ai_stage_assignment_rules')
      .upsert(payload, {
        onConflict: 'integration_id,external_pipeline_id,external_stage_id',
      })
      .select('*')
      .single();

    if (error) throw error;

    return res.json({
      ok: true,
      rule: data,
      message: 'Regra de etapa salva.',
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/agents', async (req, res, next) => {
  try {
    const tenantId = String(req.query?.tenantId || req.query?.tenant_id || '').trim();
    await assertCanManageTenant(req, tenantId);

    const { data, error } = await supabaseAdmin
      .from('crm_ai_agents')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: true });
    if (error) throw error;

    return res.json({ ok: true, agents: data || [] });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/agents', async (req, res, next) => {
  try {
    const tenantId = String(req.body?.tenant_id || '').trim();
    const requester = await assertCanAdminTenant(req, tenantId);
    const payload = pickAgentPayload(req.body || {});
    if (!payload.name) throw httpError(400, 'Nome do agente obrigatorio');

    const { data, error } = await supabaseAdmin
      .from('crm_ai_agents')
      .insert({
        tenant_id: tenantId,
        ...payload,
        created_by: requester.userId || null,
      })
      .select('*')
      .single();
    if (error) throw error;

    return res.status(201).json({ ok: true, agent: data });
  } catch (err) {
    next(err);
  }
});

adminRouter.put('/agents/:agentId', async (req, res, next) => {
  try {
    const agent = await loadAgent(req.params.agentId);
    await assertCanAdminTenant(req, agent.tenant_id);
    const payload = pickAgentPayload(req.body || {});
    if (Object.hasOwn(payload, 'name') && !payload.name) {
      throw httpError(400, 'Nome do agente obrigatorio');
    }

    const { data, error } = await supabaseAdmin
      .from('crm_ai_agents')
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq('id', agent.id)
      .select('*')
      .single();
    if (error) throw error;

    return res.json({ ok: true, agent: data });
  } catch (err) {
    next(err);
  }
});

adminRouter.delete('/agents/:agentId', async (req, res, next) => {
  try {
    const agent = await loadAgent(req.params.agentId);
    await assertCanAdminTenant(req, agent.tenant_id);
    const { error } = await supabaseAdmin
      .from('crm_ai_agents')
      .delete()
      .eq('id', agent.id);
    if (error) throw error;

    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/superadmin/users', async (req, res, next) => {
  try {
    await assertSuperadmin(req);
    const [profiles, members] = await Promise.all([
      supabaseAdmin
        .from('crm_ai_profiles')
        .select('id,email,full_name,global_role,status,created_at')
        .order('created_at', { ascending: false }),
      supabaseAdmin
        .from('crm_ai_members')
        .select('user_id,tenant_id,role,status,crm_ai_tenants(name)')
        .order('created_at', { ascending: false }),
    ]);
    if (profiles.error) throw profiles.error;
    if (members.error) throw members.error;

    const membershipsByUser = new Map();
    for (const member of members.data || []) {
      const rows = membershipsByUser.get(member.user_id) || [];
      rows.push({
        tenant_id: member.tenant_id,
        tenant_name: member.crm_ai_tenants?.name || null,
        role: member.role,
        status: member.status,
      });
      membershipsByUser.set(member.user_id, rows);
    }

    return res.json({
      ok: true,
      users: (profiles.data || []).map((profile) => ({
        ...profile,
        memberships: membershipsByUser.get(profile.id) || [],
      })),
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/superadmin/users', async (req, res, next) => {
  let createdUserId = null;
  try {
    const requester = await assertSuperadmin(req);
    const email = String(req.body?.email || '').trim().toLowerCase();
    const fullName = String(req.body?.full_name || req.body?.fullName || '').trim();
    const password = String(req.body?.password || '');
    const globalRole = req.body?.global_role === 'superadmin' ? 'superadmin' : 'user';
    const tenantId = String(req.body?.tenant_id || '').trim();
    const memberRole = String(req.body?.role || 'agent');

    if (!/^\S+@\S+\.\S+$/.test(email)) throw httpError(400, 'E-mail invalido');
    if (!fullName) throw httpError(400, 'Nome obrigatorio');
    if (password.length < 8) throw httpError(400, 'A senha deve ter pelo menos 8 caracteres');
    if (!['tenant_admin', 'manager', 'agent'].includes(memberRole)) {
      throw httpError(400, 'Papel de empresa invalido');
    }
    if (globalRole !== 'superadmin' && !tenantId) {
      throw httpError(400, 'Selecione uma empresa para o usuario');
    }

    if (tenantId) {
      const tenant = await supabaseAdmin
        .from('crm_ai_tenants')
        .select('id')
        .eq('id', tenantId)
        .maybeSingle();
      if (tenant.error) throw tenant.error;
      if (!tenant.data) throw httpError(404, 'Empresa nao encontrada');
    }

    const authResult = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });
    if (authResult.error) throw httpError(400, authResult.error.message);
    createdUserId = authResult.data.user.id;

    const profile = await supabaseAdmin
      .from('crm_ai_profiles')
      .upsert({
        id: createdUserId,
        email,
        full_name: fullName,
        global_role: globalRole,
        status: 'active',
        updated_at: new Date().toISOString(),
      }, { onConflict: 'id' });
    if (profile.error) throw profile.error;

    if (tenantId) {
      const member = await supabaseAdmin
        .from('crm_ai_members')
        .insert({
          tenant_id: tenantId,
          user_id: createdUserId,
          role: memberRole,
          status: 'active',
          created_by: requester.userId || null,
        });
      if (member.error) throw member.error;
    }

    return res.status(201).json({
      ok: true,
      user: {
        id: createdUserId,
        email,
        full_name: fullName,
        global_role: globalRole,
        tenant_id: tenantId || null,
        role: tenantId ? memberRole : null,
      },
    });
  } catch (err) {
    if (createdUserId) {
      await supabaseAdmin.auth.admin.deleteUser(createdUserId).catch(() => null);
    }
    next(err);
  }
});

adminRouter.get('/agents/:agentId/actions', async (req, res, next) => {
  try {
    const agent = await loadAgent(req.params.agentId);
    await assertCanManageTenant(req, agent.tenant_id);

    const { data, error } = await supabaseAdmin
      .from('crm_ai_actions')
      .select('id, tenant_id, agent_id, action_key, enabled, config')
      .eq('tenant_id', agent.tenant_id)
      .eq('agent_id', agent.id)
      .order('action_key', { ascending: true });

    if (error) throw error;

    return res.json({
      ok: true,
      actions: data || [],
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/agents/:agentId/actions', async (req, res, next) => {
  try {
    const agent = await loadAgent(req.params.agentId);
    await assertCanAdminTenant(req, agent.tenant_id);

    const rows = Array.isArray(req.body?.actions) ? req.body.actions : [];
    if (rows.length === 0) throw httpError(400, 'Nenhuma acao informada');

    const payload = rows
      .map((row) => ({
        tenant_id: agent.tenant_id,
        agent_id: agent.id,
        action_key: String(row.action_key || row.key || '').trim(),
        enabled: row.enabled === true,
        config: row.config && typeof row.config === 'object' ? row.config : {},
      }))
      .filter((row) => row.action_key);

    if (payload.length === 0) throw httpError(400, 'Nenhuma acao valida informada');

    const { data, error } = await supabaseAdmin
      .from('crm_ai_actions')
      .upsert(payload, { onConflict: 'agent_id,action_key' })
      .select('id, tenant_id, agent_id, action_key, enabled, config');

    if (error) throw error;

    return res.json({
      ok: true,
      actions: data || [],
      message: 'Acoes salvas.',
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/zpro/live/leads', async (req, res, next) => {
  try {
    const integration = await loadIntegration(getIntegrationId(req));
    await assertCanManageTenant(req, integration.tenant_id);

    const filters = compactObject({
      userId: req.query.userId,
      assignedUserId: req.query.userId,
      queueId: req.query.queueId,
      pipelineId: req.query.pipelineId,
      stageId: req.query.stageId,
      status: req.query.status,
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
      limit: req.query.limit || 500,
      maxPages: req.query.maxPages || 100,
    });

    const zpro = await createZproService(integration);
    const [ticketsResult, opportunitiesResult, localOpportunitiesResult, localTicketsResult] = await Promise.allSettled([
      readZproPagedList(zpro, 'listTickets', filters),
      readZproPagedList(zpro, 'listOpportunities', compactObject({
        pipelineId: filters.pipelineId,
        stageId: filters.stageId,
        status: filters.status,
        limit: 500,
        maxPages: filters.maxPages,
      })),
      supabaseAdmin
        .from('crm_ai_opportunities')
        .select('*')
        .eq('tenant_id', integration.tenant_id)
        .eq('integration_id', integration.id),
      readLocalLeadTickets(integration, filters.limit),
    ]);

    const externalOpportunities = opportunitiesResult.status === 'fulfilled'
      ? opportunitiesResult.value.items
      : [];
    const localOpportunities = localOpportunitiesResult.status === 'fulfilled'
      && !localOpportunitiesResult.value.error
      ? localOpportunitiesResult.value.data || []
      : [];
    const localTickets = localTicketsResult.status === 'fulfilled'
      ? localTicketsResult.value
      : [];
    const opportunityTickets = externalOpportunities
      .map(opportunityTicketSnapshot)
      .filter(Boolean);
    const usingFallback = ticketsResult.status === 'rejected';
    const fallbackItems = dedupeItems([...opportunityTickets, ...localTickets]);
    if (usingFallback && fallbackItems.length === 0) throw ticketsResult.reason;

    const response = usingFallback
      ? {
        endpoint: opportunitiesResult.status === 'fulfilled'
          ? opportunitiesResult.value.endpoint
          : 'crm_ai_leads',
        data: null,
        pagination: opportunitiesResult.status === 'fulfilled'
          ? opportunitiesResult.value.pagination
          : { pagesRead: 1 },
      }
      : ticketsResult.value;
    const rawItems = usingFallback ? fallbackItems : response.items;
    const enrichedItems = enrichTicketsWithOpportunities(rawItems, externalOpportunities, localOpportunities);
    const filteredRawItems = filterLiveItems(enrichedItems, filters);
    const uniqueItems = dedupeItems(filteredRawItems);
    const limit = Math.max(1, Math.min(5000, Number(filters.limit || 500)));
    const items = uniqueItems.slice(0, limit);

    if (usingFallback) {
      logWarn('admin.zpro.live_leads_ticket_list_fallback', {
        requestId: req.requestId,
        integrationId: integration.id,
        tenantId: integration.tenant_id,
        externalOpportunityTickets: opportunityTickets.length,
        localTickets: localTickets.length,
        error: ticketsResult.reason?.message || String(ticketsResult.reason),
        attempts: sanitizeObject(ticketsResult.reason?.attempts || []),
      });
    }

    if (opportunitiesResult.status === 'rejected') {
      logWarn('admin.zpro.live_leads_opportunities_unavailable', {
        requestId: req.requestId,
        integrationId: integration.id,
        error: opportunitiesResult.reason?.message || String(opportunitiesResult.reason),
      });
    }
    if (
      localOpportunitiesResult.status === 'rejected'
      || localOpportunitiesResult.value?.error
    ) {
      const error = localOpportunitiesResult.status === 'rejected'
        ? localOpportunitiesResult.reason
        : localOpportunitiesResult.value.error;
      logWarn('admin.zpro.live_leads_local_opportunities_unavailable', {
        requestId: req.requestId,
        integrationId: integration.id,
        error: error?.message || String(error),
      });
    }
    if (localTicketsResult.status === 'rejected') {
      logWarn('admin.zpro.live_leads_local_tickets_unavailable', {
        requestId: req.requestId,
        integrationId: integration.id,
        error: localTicketsResult.reason?.message || String(localTicketsResult.reason),
      });
    }

    logInfo('admin.zpro.live_leads_read', {
      requestId: req.requestId,
      integrationId: integration.id,
      tenantId: integration.tenant_id,
      count: items.length,
      received: rawItems.length,
      unique: uniqueItems.length,
      withOpportunity: items.filter((item) => item.hasOpportunity).length,
      filters,
      endpoint: response.endpoint,
    });

    return res.json({
      ok: true,
      source: usingFallback ? 'zpro_opportunities_and_local_cache' : 'zpro_live',
      persisted: usingFallback,
      partial: usingFallback,
      warning: usingFallback
        ? 'A rota listTickets desta instalacao Z-PRO nao respondeu. A consulta usou oportunidades do Z-PRO e tickets ja sincronizados; somente itens com ticket identificado podem ser redistribuidos.'
        : null,
      endpoint: response.endpoint,
      filters,
      count: items.length,
      received: rawItems.length,
      totalUnique: uniqueItems.length,
      duplicatesIgnored: filteredRawItems.length - uniqueItems.length,
      filteredOut: rawItems.length - filteredRawItems.length,
      withOpportunity: items.filter((item) => item.hasOpportunity).length,
      withoutOpportunity: items.filter((item) => !item.hasOpportunity).length,
      opportunitySources: {
        zpro: externalOpportunities.length,
        local: localOpportunities.length,
      },
      ticketSources: {
        zpro: usingFallback ? 0 : rawItems.length,
        zproOpportunities: usingFallback ? opportunityTickets.length : 0,
        local: usingFallback ? localTickets.length : 0,
      },
      items: sanitizeObject(items),
      pagination: response.pagination,
      raw: sanitizeObject(response.data),
    });
  } catch (err) {
    return zproErrorResponse(res, err);
  }
});

adminRouter.get('/zpro/live/opportunities', async (req, res, next) => {
  try {
    const integration = await loadIntegration(getIntegrationId(req));
    await assertCanManageTenant(req, integration.tenant_id);

    const filters = compactObject({
      userId: req.query.userId,
      assignedUserId: req.query.userId,
      pipelineId: req.query.pipelineId,
      stageId: req.query.stageId,
      status: req.query.status,
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
      limit: req.query.limit || 100,
    });

    const zpro = await createZproService(integration);
    const response = await readZproPagedList(zpro, 'listOpportunities', filters);
    const rawItems = response.items;
    const filteredRawItems = filterLiveItems(rawItems, filters);
    const uniqueItems = dedupeItems(filteredRawItems);
    const limit = Math.max(1, Math.min(500, Number(filters.limit || 100)));
    const items = uniqueItems.slice(0, limit);

    return res.json({
      ok: true,
      source: 'zpro_live',
      persisted: false,
      endpoint: response.endpoint,
      filters,
      count: items.length,
      received: rawItems.length,
      totalUnique: uniqueItems.length,
      duplicatesIgnored: filteredRawItems.length - uniqueItems.length,
      filteredOut: rawItems.length - filteredRawItems.length,
      items: sanitizeObject(items),
      pagination: response.pagination,
      raw: sanitizeObject(response.data),
    });
  } catch (err) {
    return zproErrorResponse(res, err);
  }
});

adminRouter.post('/zpro/redistribute/preview', async (req, res, next) => {
  try {
    const {
      integrationId,
      items = [],
      targetUsers = [],
      targetQueueId = '',
      mode = 'balanced',
      createMissingOpportunities = false,
      opportunityPipelineId = '',
      opportunityStageId = '',
    } = req.body || {};
    const integration = await loadIntegration(integrationId);
    await assertCanManageTenant(req, integration.tenant_id);

    if (!Array.isArray(items) || items.length === 0) {
      throw httpError(400, 'Selecione ao menos um lead da consulta ao vivo');
    }

    const uniqueItems = dedupeItems(items);
    if (createMissingOpportunities && (!opportunityPipelineId || !opportunityStageId)) {
      throw httpError(400, 'Selecione o funil e a etapa para criar oportunidades ausentes');
    }
    const assignments = distributeItems(uniqueItems, targetUsers, mode, targetQueueId);
    const summary = assignments.reduce((acc, item) => {
      acc[item.targetUserId] = acc[item.targetUserId] || {
        targetUserId: item.targetUserId,
        targetUserName: item.targetUserName,
        count: 0,
      };
      acc[item.targetUserId].count += 1;
      return acc;
    }, {});

    return res.json({
      ok: true,
      persisted: false,
      executable: true,
      totalReceived: items.length,
      totalUnique: uniqueItems.length,
      duplicatesIgnored: items.length - uniqueItems.length,
      assignments: sanitizeObject(assignments),
      summary: Object.values(summary),
      createMissingOpportunities: Boolean(createMissingOpportunities),
      opportunityPipelineId: opportunityPipelineId || null,
      opportunityStageId: opportunityStageId || null,
      message: 'Prévia pronta. A execução será feita em lotes pequenos, com verificação de cada ticket.',
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/zpro/redistribute', async (req, res, next) => {
  try {
    const {
      integrationId,
      assignments = [],
      confirm = false,
      delayMs = 250,
      createMissingOpportunities = false,
      opportunityPipelineId = '',
      opportunityStageId = '',
    } = req.body || {};
    const integration = await loadIntegration(integrationId);
    await assertCanManageTenant(req, integration.tenant_id);

    if (!confirm) {
      throw httpError(400, 'Confirme a execucao depois de revisar a previa');
    }

    if (!Array.isArray(assignments) || assignments.length === 0) {
      throw httpError(400, 'Nenhuma redistribuicao informada');
    }
    if (createMissingOpportunities && (!opportunityPipelineId || !opportunityStageId)) {
      throw httpError(400, 'Funil e etapa sao obrigatorios para criar oportunidades ausentes');
    }
    if (assignments.length > 25) {
      throw httpError(400, 'Envie no maximo 25 tickets por lote');
    }

    const zpro = await createZproService(integration);
    const results = [];
    const pauseMs = Math.max(0, Math.min(1500, Number(delayMs || 0)));

    for (let index = 0; index < assignments.length; index += 1) {
      const assignment = assignments[index];
      const itemId = assignment.itemId || getLeadExternalId(assignment.item);
      if (!itemId) {
        results.push({
          ok: false,
          itemId,
          error: 'Lead sem identificador externo',
        });
        continue;
      }

      const targetUserId = String(assignment.targetUserId || '');
      const targetQueueId = String(
        assignment.targetQueueId
        || pickValue(assignment.item || {}, ['queueId', 'queue_id', 'queue.id'])
        || '',
      );

      try {
        const result = await zpro.updateTicketAssignment({
          ticketId: itemId,
          userId: targetUserId,
          status: targetUserId ? 'open' : 'pending',
          queueId: targetQueueId || undefined,
        });
        const verification = await verifyAdminTicketAssignment(zpro, itemId, {
          userId: targetUserId,
          queueId: targetQueueId,
          status: targetUserId ? 'open' : 'pending',
        });
        if (!verification.verified) {
          throw new Error(
            `Ticket permaneceu com usuario=${verification.state.userId || 'vazio'}, fila=${verification.state.queueId || 'vazia'} e status=${verification.state.status || 'vazio'}`,
          );
        }

        const crmOpportunity = assignment.item?.crmOpportunity || {};
        let opportunityResult = null;
        let opportunityCreated = false;
        let opportunityRecovered = false;
        let opportunityError = null;
        let externalOpportunityId = String(crmOpportunity.id || '');
        const pipelineId = String(crmOpportunity.pipelineId || opportunityPipelineId || integration.pipeline_id || '');
        const stageId = String(crmOpportunity.stageId || opportunityStageId || integration.initial_stage_id || '');

        try {
          if (externalOpportunityId && pipelineId && stageId) {
            opportunityResult = await zpro.moveOpportunity({
              opportunityId: externalOpportunityId,
              pipelineId,
              stageId,
              responsibleId: targetUserId,
              status: 'open',
              description: 'Responsavel sincronizado pela redistribuicao em lote.',
            });
          } else if (createMissingOpportunities) {
            try {
              opportunityResult = await zpro.createOpportunity({
                number: normalizedItemPhone(assignment.item),
                contactName: adminLeadName(assignment.item),
                name: `${adminLeadName(assignment.item)} - WhatsApp`,
                value: 0,
                status: 'open',
                pipelineId,
                stageId,
                responsibleId: targetUserId,
                description: 'Oportunidade criada durante redistribuicao em lote.',
                validateNumber: true,
              });
              externalOpportunityId = externalOpportunityIdFromResponse(opportunityResult.data);
              if (!externalOpportunityId) {
                throw new Error('Z-PRO criou a oportunidade, mas nao retornou o identificador externo');
              }
              opportunityCreated = true;
            } catch (createError) {
              const lookup = await readZproPagedList(zpro, 'listOpportunities', {
                searchParam: normalizedItemPhone(assignment.item) || itemContactId(assignment.item),
                pipelineId,
                limit: 500,
                maxPages: 5,
              });
              const [linkedItem] = enrichTicketsWithOpportunities([assignment.item], lookup.items);
              externalOpportunityId = String(linkedItem?.crmOpportunity?.id || '');
              if (!externalOpportunityId) throw createError;
              opportunityRecovered = true;
              opportunityResult = await zpro.moveOpportunity({
                opportunityId: externalOpportunityId,
                pipelineId,
                stageId,
                responsibleId: targetUserId,
                status: 'open',
                description: 'Oportunidade existente vinculada durante redistribuicao em lote.',
              });
            }
          }

          if (externalOpportunityId && pipelineId && stageId) {
            await ensureAdminLocalOpportunity({
              integration,
              item: assignment.item || {},
              ticketId: itemId,
              targetUserId,
              pipelineId,
              stageId,
              externalOpportunityId,
            });
          } else {
            const localUpdate = await supabaseAdmin
              .from('crm_ai_opportunities')
              .update({
                assigned_external_user_id: targetUserId || null,
                updated_at: new Date().toISOString(),
              })
              .eq('tenant_id', integration.tenant_id)
              .eq('integration_id', integration.id)
              .eq('external_ticket_id', String(itemId));
            if (localUpdate.error) throw localUpdate.error;
          }
        } catch (syncError) {
          opportunityError = syncError.message || String(syncError);
          logWarn('admin.zpro.redistribute_opportunity_sync_failed', {
            integrationId: integration.id,
            ticketId: itemId,
            error: opportunityError,
          });
        }

        results.push({
          ok: !opportunityError,
          ticketUpdated: true,
          itemId,
          targetUserId,
          targetQueueId: targetQueueId || null,
          endpoint: result.endpoint,
          verificationEndpoint: verification.endpoint,
          verified: true,
          opportunityUpdated: Boolean(opportunityResult),
          opportunityCreated,
          opportunityRecovered,
          externalOpportunityId: externalOpportunityId || null,
          opportunityError,
          data: sanitizeObject(result.data),
        });
      } catch (err) {
        results.push({
          ok: false,
          itemId,
          targetUserId,
          targetQueueId: targetQueueId || null,
          error: err.message || String(err),
        });
      }

      if (pauseMs > 0 && index < assignments.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, pauseMs));
      }
    }

    return res.json({
      ok: results.every((item) => item.ok),
      processed: results.length,
      succeeded: results.filter((item) => item.ok).length,
      failed: results.filter((item) => !item.ok).length,
      results,
    });
  } catch (err) {
    return zproErrorResponse(res, err);
  }
});

adminRouter.post('/zpro/stage-move/preview', async (req, res, next) => {
  try {
    const {
      integrationId,
      items = [],
      targetPipelineId,
      targetStageId,
      quantity,
    } = req.body || {};
    const integration = await loadIntegration(integrationId);
    await assertCanManageTenant(req, integration.tenant_id);

    if (!targetPipelineId) throw httpError(400, 'Selecione o funil de destino');
    if (!targetStageId) throw httpError(400, 'Selecione a etapa de destino');
    if (!Array.isArray(items) || items.length === 0) {
      throw httpError(400, 'Selecione ao menos um lead da consulta ao vivo');
    }

    const uniqueItems = dedupeItems(items);
    const limit = Number(quantity || uniqueItems.length);
    const selected = uniqueItems.slice(0, Math.max(0, limit));
    const moves = selected.map((item) => ({
      item,
      itemId: getItemOpportunityId(item),
      ticketId: getLeadExternalId(item),
      targetPipelineId: String(targetPipelineId),
      targetStageId: String(targetStageId),
    }));

    return res.json({
      ok: true,
      persisted: false,
      totalReceived: items.length,
      totalUnique: uniqueItems.length,
      selected: moves.length,
      duplicatesIgnored: items.length - uniqueItems.length,
      moves: sanitizeObject(moves),
      message: 'Previa gerada sem gravar leads no banco. Duplicados por telefone/contato foram ignorados.',
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/zpro/stage-move', async (req, res, next) => {
  try {
    const {
      integrationId,
      moves = [],
      targetPipelineId,
      targetStageId,
      confirm = false,
    } = req.body || {};
    const integration = await loadIntegration(integrationId);
    await assertCanManageTenant(req, integration.tenant_id);

    if (!confirm) throw httpError(400, 'Confirme a execucao depois de revisar a previa');
    if (!targetPipelineId) throw httpError(400, 'Selecione o funil de destino');
    if (!targetStageId) throw httpError(400, 'Selecione a etapa de destino');
    if (!Array.isArray(moves) || moves.length === 0) {
      throw httpError(400, 'Nenhuma movimentacao informada');
    }

    const zpro = await createZproService(integration);
    const results = [];

    for (const move of moves) {
      const itemId = move.itemId || getItemOpportunityId(move.item);
      if (!itemId) {
        results.push({
          ok: false,
          itemId,
          error: 'Lead/oportunidade sem identificador externo',
        });
        continue;
      }

      const result = await zpro.moveOpportunity({
        opportunityId: itemId,
        ticketId: move.ticketId || getLeadExternalId(move.item),
        pipelineId: targetPipelineId,
        stageId: targetStageId,
        status: pickValue(move.item || {}, ['status', 'opportunity.status']) || undefined,
      });

      results.push({
        ok: true,
        itemId,
        targetPipelineId,
        targetStageId,
        endpoint: result.endpoint,
        data: sanitizeObject(result.data),
      });
    }

    return res.json({
      ok: true,
      results,
    });
  } catch (err) {
    return zproErrorResponse(res, err);
  }
});
