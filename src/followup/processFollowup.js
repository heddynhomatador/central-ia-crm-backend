import { loadResources, routeResourcesValid } from '../crm/resources.js';
import { ticketSnapshot } from '../crm/zproData.js';
import { selectAssignee, moveTicket } from '../crm/routingService.js';
import { syncOpportunity } from '../crm/opportunityService.js';
import { actionAllowed, engineMode, followupEligible } from '../conversation/state.js';
import { CommandExecutor } from '../operations/commandExecutor.js';
import { checked, engineError } from '../operations/store.js';
import { messageExternalKey, ZproService } from '../services/zproService.js';
import { followupMessage, scheduleFollowup } from './scheduler.js';
import { logInfo } from '../lib/logging.js';

export async function processFollowup({ batch, store, resourcesLoader = loadResources, zproFactory = null }) {
  const { conversation, job } = batch; const owner = conversation.lease_owner;
  let state = conversation.state;
  conversation.expected_version = job.turn_version;
  const resources = await resourcesLoader(store.db, conversation);
  const { integration, agent, references, actions, opportunity } = resources;
  const policy = await checked(store.db.from('crm_ai_followup_policies').select('*').eq('id', job.policy_id).eq('tenant_id', conversation.tenant_id).single());
  const release = async (status, code = null, state = conversation.state) => {
    await checked(store.db.from('crm_ai_followup_runs').update({ status, error_code: code,
      ...(status === 'sent' ? { sent_at: new Date().toISOString() } : {}) }).eq('id', job.id).eq('owner', owner).neq('status', 'cancelled'));
    await checked(store.db.from('crm_ai_conversations').update({ state, lease_owner: null, lease_until: null })
      .eq('id', conversation.id).eq('lease_owner', owner));
  };
  const canSend = () => store.rpc('crm_ai_followup_send_allowed', { p_conversation: conversation.id, p_owner: owner, p_job: job.id });
  try {
    if (!integration.active || !agent.enabled || agent.settings?.safe_mode || engineMode(agent) !== 'v2'
      || (process.env.APP_MODE || 'live') !== 'live' || !policy.enabled || !actionAllowed(actions, 'schedule_followup') || !(await canSend())) {
      await release('cancelled', 'policy_or_turn_changed'); return;
    }
    const zpro = zproFactory ? await zproFactory(store, integration) : new ZproService({ baseUrl: integration.base_url,
      token: await store.rpc('crm_ai_service_get_zpro_token', { p_integration_id: integration.id }) });
    let ticket = ticketSnapshot(await zpro.showTicket(conversation.ticket_id));
    if (!followupEligible(conversation.state, ticket) || !(await canSend())) { await release('cancelled', 'ineligible'); return; }
    const envelope = conversation.state.last_envelope;
    const message = followupMessage(policy, job.attempt);
    if (!envelope || !message) { await release('cancelled', 'missing_message'); return; }
    const commands = new CommandExecutor(store, conversation, owner);
    const payload = { number: envelope.metadata.phone, body: message, ticketId: conversation.ticket_id,
      channelId: envelope.metadata.channel_id, requireTicket: true,
      externalKey: messageExternalKey('v2_followup', integration.id, job.id) };
    await commands.run(`followup:${job.id}`, 'send_message', payload, async () => {
      if (!(await canSend())) throw engineError('FOLLOWUP_CANCELLED');
      return zpro.sendMessage(payload);
    });
    if (job.attempt >= Number(policy.max_attempts || 3) && policy.transfer_after_last && actionAllowed(actions, 'transfer_ticket') && await canSend()) {
      const rule = { id: `followup:${policy.id}`, external_pipeline_id: policy.transfer_pipeline_id,
        external_stage_id: policy.transfer_stage_id, external_queue_id: policy.transfer_queue_id,
        distribution_mode: 'balanced_rotation', user_order: policy.transfer_user_order || [] };
      if (!references.queues.some((q) => String(q.external_queue_id) === String(rule.external_queue_id) && q.active !== false)) throw engineError('FOLLOWUP_QUEUE_INVALID');
      const userId = await selectAssignee({ rule, references, store, conversation, commands, turnKey: job.id, zpro });
      if (!(await canSend())) throw engineError('FOLLOWUP_CANCELLED');
      ticket = await moveTicket({ zpro, commands, conversation, turnKey: job.id, queueId: rule.external_queue_id, userId, status: userId ? 'open' : 'pending' });
      state = { ...state, status: 'human_handoff', followup_eligible: false };
      // Ticket ownership is real even if the subsequent opportunity synchronization fails.
      await checked(store.db.from('crm_ai_conversations').update({ state }).eq('id', conversation.id).eq('lease_owner', owner));
      if (routeResourcesValid(rule, references) && actionAllowed(actions, opportunity ? 'update_opportunity' : 'create_opportunity')) {
        const lead = await checked(store.db.from('crm_ai_leads').select('*').eq('id', state.lead_id).eq('tenant_id', conversation.tenant_id).single());
        await syncOpportunity({ store, zpro, commands, conversation, envelope, lead, opportunity, route: rule, userId, turnKey: job.id });
      }
    }
    await scheduleFollowup({ store, conversation: { ...conversation, state }, policy, ticket, actions, attempt: job.attempt + 1 });
    await checked(store.db.from('crm_ai_conversations').update({ history: [...(conversation.history || []).filter((h) => h.followup_id !== job.id),
      { role: 'assistant', content: message, followup_id: job.id }].slice(-40) }).eq('id', conversation.id).eq('lease_owner', owner));
    await release('sent', null, state);
    logInfo('turn.followup_sent', { conversationId: conversation.id, jobId: job.id, attempt: job.attempt });
  } catch (error) {
    await release(['FOLLOWUP_CANCELLED', 'TURN_SUPERSEDED'].includes(error.code) ? 'cancelled' : 'failed', error.code || 'FOLLOWUP_FAILED',
      { ...state, followup_eligible: false });
    throw error;
  }
}
