import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logInfo, logWarn, sanitizeObject } from '../lib/logging.js';
import { ZproService } from './zproService.js';

const ACTIVE_LEAD_STATUSES = new Set(['new', 'ai_attending', 'qualified']);
const DEFAULT_INTERVAL_MS = 15000;
const MAX_BATCH_SIZE = 20;

let workerTimer = null;
let cycleRunning = false;
const workerState = {
  startedAt: null,
  lastCycleAt: null,
  lastSuccessAt: null,
  lastError: null,
  processed: 0,
};

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeMessages(policy = {}) {
  const messages = Array.isArray(policy.messages) ? policy.messages : [];
  return messages.map((item) => {
    if (typeof item === 'string') return item.trim();
    return String(item?.message || item?.text || '').trim();
  });
}

function policyConfig(policy = {}) {
  const messages = normalizeMessages(policy);
  const delays = Array.isArray(policy.delays_minutes)
    ? policy.delays_minutes.map((value) => boundedNumber(value, 60, 1, 43200))
    : [];
  const maxAttempts = boundedNumber(policy.max_attempts, 3, 1, 10);

  return {
    messages,
    delays,
    maxAttempts,
  };
}

function policyUserOrder(policy = {}) {
  let users = policy.transfer_user_order;
  if (typeof users === 'string') {
    try {
      users = JSON.parse(users);
    } catch {
      users = [];
    }
  }
  return Array.isArray(users)
    ? [...new Set(users.map((item) => String(item || '').trim()).filter(Boolean))]
    : [];
}

export function roundRobinUserForPolicy(policy = {}) {
  const users = policyUserOrder(policy);
  if (users.length === 0) return null;
  const cursor = Math.max(0, Number(policy.round_robin_cursor || 0));
  return users[cursor % users.length];
}

async function reserveRoundRobinUser(policy = {}) {
  const userId = roundRobinUserForPolicy(policy);
  if (!userId) return null;
  const nextCursor = Math.max(0, Number(policy.round_robin_cursor || 0)) + 1;
  const { error } = await supabaseAdmin
    .from('crm_ai_followup_policies')
    .update({ round_robin_cursor: nextCursor, updated_at: new Date().toISOString() })
    .eq('id', policy.id);
  if (error) throw error;
  return userId;
}

function readPath(value, path) {
  return String(path)
    .split('.')
    .reduce((current, key) => (current && typeof current === 'object' ? current[key] : undefined), value);
}

function pickFirst(value, paths) {
  for (const path of paths) {
    const found = readPath(value, path);
    if (found !== undefined && found !== null && found !== '') return found;
  }
  return null;
}

function ticketState(data = {}) {
  return {
    status: String(pickFirst(data, ['status', 'data.status', 'ticket.status', 'data.ticket.status']) || '').toLowerCase(),
    userId: pickFirst(data, ['userId', 'user_id', 'data.userId', 'data.user_id', 'ticket.userId', 'data.ticket.userId']),
    queueId: pickFirst(data, ['queueId', 'queue_id', 'data.queueId', 'data.queue_id', 'ticket.queueId', 'data.ticket.queueId']),
  };
}

async function createZproService(integration) {
  const { data: token, error } = await supabaseAdmin.rpc('crm_ai_service_get_zpro_token', {
    p_integration_id: integration.id,
  });
  if (error) throw error;
  return new ZproService({ baseUrl: integration.base_url, token });
}

async function recordLeadEvent({ tenantId, leadId, eventType, summary, payload = {} }) {
  const { error } = await supabaseAdmin.from('crm_ai_lead_events').insert({
    tenant_id: tenantId,
    lead_id: leadId,
    event_type: eventType,
    summary,
    payload,
  });
  if (error) throw error;
}

async function rememberFollowupContext({ lead, integration, message, attempt }) {
  const { error } = await supabaseAdmin.from('crm_ai_ticket_context').insert({
    tenant_id: lead.tenant_id,
    integration_id: integration.id,
    lead_id: lead.id,
    external_ticket_id: lead.external_ticket_id || null,
    role: 'assistant',
    content: message.slice(0, 4000),
    event_type: 'followup_sent',
    metadata: { attempt },
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  });

  if (error && !/crm_ai_ticket_context|does not exist|schema cache/i.test(error.message || '')) {
    throw error;
  }
}

async function loadPolicy(tenantId, agentId = null) {
  const { data, error } = await supabaseAdmin
    .from('crm_ai_followup_policies')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('enabled', true)
    .order('created_at', { ascending: true });

  if (error) throw error;
  const policies = data || [];
  return policies.find((item) => agentId && item.agent_id === agentId)
    || policies.find((item) => !item.agent_id)
    || policies[0]
    || null;
}

async function upsertFollowupJob({ lead, policy, attempt, runAt }) {
  const payload = {
    tenant_id: lead.tenant_id,
    lead_id: lead.id,
    policy_id: policy.id,
    external_ticket_id: String(lead.external_ticket_id || ''),
    attempt,
    run_at: runAt.toISOString(),
    status: 'pending',
    error: null,
    sent_at: null,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabaseAdmin
    .from('crm_ai_followup_jobs')
    .upsert(payload, { onConflict: 'lead_id,policy_id,external_ticket_id,attempt' })
    .select('*')
    .single();
  if (error) throw error;

  await recordLeadEvent({
    tenantId: lead.tenant_id,
    leadId: lead.id,
    eventType: 'followup_scheduled',
    summary: `Follow-up ${attempt} agendado.`,
    payload: {
      job_id: data.id,
      policy_id: policy.id,
      ticket_id: data.external_ticket_id || null,
      attempt,
      run_at: data.run_at,
    },
  });

  logInfo('followup.scheduled', {
    jobId: data.id,
    leadId: lead.id,
    policyId: policy.id,
    ticketId: data.external_ticket_id || null,
    attempt,
    runAt: data.run_at,
  });

  return data;
}

export async function cancelPendingFollowups({ tenantId, leadId, reason = 'customer_replied' }) {
  if (!tenantId || !leadId) return 0;
  const { data, error } = await supabaseAdmin
    .from('crm_ai_followup_jobs')
    .update({
      status: 'cancelled',
      error: reason,
      updated_at: new Date().toISOString(),
    })
    .eq('tenant_id', tenantId)
    .eq('lead_id', leadId)
    .in('status', ['pending', 'running'])
    .select('id');

  if (error) {
    logWarn('followup.cancel_failed', { tenantId, leadId, reason, error: error.message || String(error) });
    return 0;
  }
  const cancelled = (data || []).length;
  if (cancelled > 0) {
    logInfo('followup.cancelled_on_reply', { tenantId, leadId, reason, cancelled });
  }
  return cancelled;
}

export async function scheduleFollowupAfterAiReply({ lead, agentId = null }) {
  if (!lead?.id || !lead?.tenant_id) return null;
  const policy = await loadPolicy(lead.tenant_id, agentId);
  if (!policy) return null;

  const config = policyConfig(policy);
  let attempt = 1;

  if (!policy.reset_attempts_on_reply) {
    const { data, error } = await supabaseAdmin
      .from('crm_ai_followup_jobs')
      .select('attempt')
      .eq('lead_id', lead.id)
      .eq('policy_id', policy.id)
      .eq('external_ticket_id', String(lead.external_ticket_id || ''))
      .eq('status', 'sent')
      .order('attempt', { ascending: false })
      .limit(1);
    if (error) throw error;
    attempt = Number(data?.[0]?.attempt || 0) + 1;
  }

  const message = config.messages[attempt - 1];
  if (attempt > config.maxAttempts || !message) return null;
  const delayMinutes = config.delays[attempt - 1] || config.delays.at(-1) || 60;
  const runAt = new Date(Date.now() + delayMinutes * 60 * 1000);
  return upsertFollowupJob({ lead, policy, attempt, runAt });
}

async function scheduleNextAttempt({ lead, policy, attempt }) {
  const config = policyConfig(policy);
  const nextAttempt = attempt + 1;
  const message = config.messages[nextAttempt - 1];
  if (nextAttempt > config.maxAttempts || !message) return null;
  const delayMinutes = config.delays[nextAttempt - 1] || config.delays.at(-1) || 60;
  return upsertFollowupJob({
    lead,
    policy,
    attempt: nextAttempt,
    runAt: new Date(Date.now() + delayMinutes * 60 * 1000),
  });
}

async function transferAfterLastFollowup({ zpro, lead, policy }) {
  if (!policy.transfer_after_last) return null;

  const assignedUserId = await reserveRoundRobinUser(policy);
  let ticketResult = null;
  if (lead.external_ticket_id && (policy.transfer_queue_id || assignedUserId)) {
    ticketResult = await zpro.updateTicketAssignment({
      ticketId: lead.external_ticket_id,
      queueId: policy.transfer_queue_id,
      userId: assignedUserId,
      status: assignedUserId ? 'open' : 'pending',
      chatgptStatus: false,
      typebotStatus: false,
      dialogflowStatus: false,
      difyStatus: false,
      n8nStatus: false,
    });
  }

  const { data: opportunity, error: opportunityError } = await supabaseAdmin
    .from('crm_ai_opportunities')
    .select('*')
    .eq('tenant_id', lead.tenant_id)
    .eq('lead_id', lead.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (opportunityError) throw opportunityError;

  let opportunityResult = null;
  const externalOpportunityId = opportunity?.external_opportunity_id
    || opportunity?.raw_data?.external_opportunity_id
    || opportunity?.raw_data?.zpro_create_response?.id;
  if (externalOpportunityId && policy.transfer_pipeline_id && policy.transfer_stage_id) {
    opportunityResult = await zpro.moveOpportunity({
      opportunityId: externalOpportunityId,
      name: opportunity.title,
      value: opportunity.value,
      status: opportunity.status || 'open',
      pipelineId: policy.transfer_pipeline_id,
      stageId: policy.transfer_stage_id,
      responsibleId: assignedUserId || undefined,
      description: 'Destino aplicado apos o ultimo follow-up sem resposta.',
    });
  }

  if (opportunity?.id && (policy.transfer_pipeline_id || policy.transfer_stage_id || assignedUserId)) {
    await supabaseAdmin
      .from('crm_ai_opportunities')
      .update({
        pipeline_id: policy.transfer_pipeline_id || opportunity.pipeline_id,
        stage_id: policy.transfer_stage_id || opportunity.stage_id,
        assigned_external_user_id: assignedUserId || opportunity.assigned_external_user_id,
        raw_data: {
          ...(opportunity.raw_data || {}),
          followup_transfer_at: new Date().toISOString(),
          followup_transfer_result: sanitizeObject(opportunityResult?.data || {}),
        },
        updated_at: new Date().toISOString(),
      })
      .eq('id', opportunity.id);
  }

  await supabaseAdmin
    .from('crm_ai_leads')
    .update({
      status: 'transferred',
      assigned_external_user_id: assignedUserId || null,
      metadata: {
        ...(lead.metadata || {}),
        ai_state: {
          ...(lead.metadata?.ai_state || {}),
          stopped: true,
          reason: 'followup_exhausted',
          ticket_id: lead.external_ticket_id || null,
          stopped_at: new Date().toISOString(),
        },
      },
      transferred_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', lead.id);

  await recordLeadEvent({
    tenantId: lead.tenant_id,
    leadId: lead.id,
    eventType: 'followup_exhausted_transfer',
    summary: 'Lead transferido apos o ultimo follow-up sem resposta.',
    payload: sanitizeObject({
      queue_id: policy.transfer_queue_id,
      user_id: assignedUserId,
      pipeline_id: policy.transfer_pipeline_id,
      stage_id: policy.transfer_stage_id,
      ticket: ticketResult,
      opportunity: opportunityResult,
    }),
  });

  return { ticketResult, opportunityResult, assignedUserId };
}

async function cancelJob(job, reason) {
  await supabaseAdmin
    .from('crm_ai_followup_jobs')
    .update({ status: 'cancelled', error: reason, updated_at: new Date().toISOString() })
    .eq('id', job.id);
  logInfo('followup.cancelled', { jobId: job.id, leadId: job.lead_id, attempt: job.attempt, reason });
}

async function processFollowupJob(job) {
  const { data: claimed, error: claimError } = await supabaseAdmin
    .from('crm_ai_followup_jobs')
    .update({ status: 'running', error: null, updated_at: new Date().toISOString() })
    .eq('id', job.id)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle();
  if (claimError) throw claimError;
  if (!claimed) return false;

  const [{ data: lead, error: leadError }, { data: policy, error: policyError }] = await Promise.all([
    supabaseAdmin.from('crm_ai_leads').select('*').eq('id', claimed.lead_id).maybeSingle(),
    supabaseAdmin.from('crm_ai_followup_policies').select('*').eq('id', claimed.policy_id).maybeSingle(),
  ]);
  if (leadError) throw leadError;
  if (policyError) throw policyError;
  if (!lead || !policy?.enabled) {
    await cancelJob(claimed, !lead ? 'lead_not_found' : 'policy_disabled');
    return false;
  }
  if (String(lead.external_ticket_id || '') !== String(claimed.external_ticket_id || '')) {
    await cancelJob(claimed, 'ticket_changed_after_schedule');
    return false;
  }
  if (!ACTIVE_LEAD_STATUSES.has(String(lead.status || '').toLowerCase()) || lead.metadata?.ai_state?.stopped) {
    await cancelJob(claimed, 'lead_not_available_for_ai');
    return false;
  }

  const lastInboundAt = new Date(lead.last_message_at || 0).getTime();
  const scheduledAt = new Date(job.updated_at || job.created_at).getTime();
  if (lastInboundAt > scheduledAt) {
    await cancelJob(claimed, 'customer_replied_after_schedule');
    return false;
  }

  const { data: integration, error: integrationError } = await supabaseAdmin
    .from('crm_ai_integrations')
    .select('*')
    .eq('id', lead.integration_id)
    .maybeSingle();
  if (integrationError) throw integrationError;
  if (!integration?.active || integration.provider !== 'zpro') {
    await cancelJob(claimed, 'integration_inactive');
    return false;
  }

  const config = policyConfig(policy);
  const message = config.messages[claimed.attempt - 1];
  if (!message) {
    await cancelJob(claimed, 'empty_message');
    return false;
  }

  const zpro = await createZproService(integration);
  if (!lead.external_ticket_id) {
    await cancelJob(claimed, 'ticket_id_missing');
    return false;
  }
  const ticket = await zpro.showTicket(claimed.external_ticket_id);
  const currentTicket = ticketState(ticket.data || {});
  if (currentTicket.status !== 'pending' || currentTicket.userId) {
    await cancelJob(claimed, `ticket_not_pending:${currentTicket.status || 'unknown'}`);
    return false;
  }

  const { data: currentJob, error: currentJobError } = await supabaseAdmin
    .from('crm_ai_followup_jobs')
    .select('status')
    .eq('id', claimed.id)
    .maybeSingle();
  if (currentJobError) throw currentJobError;
  if (currentJob?.status !== 'running') return false;

  const sendResult = await zpro.sendMessage({ number: lead.phone, body: message });
  const sentAt = new Date().toISOString();
  const { error: sentError } = await supabaseAdmin
    .from('crm_ai_followup_jobs')
    .update({ status: 'sent', sent_at: sentAt, error: null, updated_at: sentAt })
    .eq('id', claimed.id)
    .eq('status', 'running');
  if (sentError) throw sentError;

  await Promise.all([
    recordLeadEvent({
      tenantId: lead.tenant_id,
      leadId: lead.id,
      eventType: 'followup_sent',
      summary: message,
      payload: sanitizeObject({
        attempt: claimed.attempt,
        job_id: claimed.id,
        endpoint: sendResult.endpoint || 'base',
      }),
    }),
    rememberFollowupContext({ lead, integration, message, attempt: claimed.attempt }),
  ]);

  const next = await scheduleNextAttempt({ lead, policy, attempt: Number(claimed.attempt) });
  if (!next && Number(claimed.attempt) >= config.maxAttempts) {
    await transferAfterLastFollowup({ zpro, lead, policy });
  }

  logInfo('followup.sent', {
    jobId: claimed.id,
    leadId: lead.id,
    ticketId: lead.external_ticket_id,
    attempt: claimed.attempt,
    nextRunAt: next?.run_at || null,
  });
  return true;
}

export async function runFollowupCycle() {
  if (cycleRunning) return { skipped: true, reason: 'cycle_already_running' };
  cycleRunning = true;
  workerState.lastCycleAt = new Date().toISOString();

  try {
    const staleAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await supabaseAdmin
      .from('crm_ai_followup_jobs')
      .update({ status: 'pending', error: 'worker_recovered', updated_at: new Date().toISOString() })
      .eq('status', 'running')
      .lt('updated_at', staleAt);

    const { data: jobs, error } = await supabaseAdmin
      .from('crm_ai_followup_jobs')
      .select('*')
      .eq('status', 'pending')
      .lte('run_at', new Date().toISOString())
      .order('run_at', { ascending: true })
      .limit(MAX_BATCH_SIZE);
    if (error) throw error;

    if ((jobs || []).length > 0) {
      logInfo('followup.cycle_due', {
        due: jobs.length,
        oldestRunAt: jobs[0]?.run_at || null,
      });
    }

    let processed = 0;
    for (const job of jobs || []) {
      try {
        if (await processFollowupJob(job)) processed += 1;
      } catch (err) {
        await supabaseAdmin
          .from('crm_ai_followup_jobs')
          .update({
            status: 'failed',
            error: String(err.message || err).slice(0, 2000),
            updated_at: new Date().toISOString(),
          })
          .eq('id', job.id);
        logWarn('followup.job_failed', {
          jobId: job.id,
          leadId: job.lead_id,
          attempt: job.attempt,
          error: err.message || String(err),
        });
      }
    }

    workerState.processed += processed;
    workerState.lastSuccessAt = new Date().toISOString();
    workerState.lastError = null;
    return { skipped: false, due: (jobs || []).length, processed };
  } catch (err) {
    workerState.lastError = err.message || String(err);
    logWarn('followup.cycle_failed', { error: workerState.lastError });
    return { skipped: false, error: workerState.lastError };
  } finally {
    cycleRunning = false;
  }
}

export function startFollowupWorker() {
  if (workerTimer) return;
  const intervalMs = boundedNumber(process.env.FOLLOWUP_WORKER_INTERVAL_MS, DEFAULT_INTERVAL_MS, 5000, 300000);
  workerState.startedAt = new Date().toISOString();

  const tick = () => {
    runFollowupCycle().catch((err) => {
      logWarn('followup.worker_failed', { error: err.message || String(err) });
    });
  };
  setTimeout(tick, 1000).unref();
  workerTimer = setInterval(tick, intervalMs);
  workerTimer.unref();
  logInfo('followup.worker_started', { intervalMs });
}

export function getFollowupWorkerStatus() {
  return { ...workerState, cycleRunning };
}
