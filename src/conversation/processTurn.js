import { mergeCurrentMessages } from '../inbound/normalizeInboundMessage.js';
import { generateTurnDecision } from './decisionEngine.js';
import { validateTurnDecision } from './policyValidator.js';
import { actionAllowed, engineMode, initialState, transitionState } from './state.js';
import { loadResources, ensureLead, routeResourcesValid } from '../crm/resources.js';
import { ticketSnapshot } from '../crm/zproData.js';
import { selectAssignee, moveTicket } from '../crm/routingService.js';
import { syncOpportunity } from '../crm/opportunityService.js';
import { applyAppointmentWorkflow } from '../appointments/appointmentService.js';
import { CommandExecutor } from '../operations/commandExecutor.js';
import { checked, engineError } from '../operations/store.js';
import { ZproService, messageExternalKey } from '../services/zproService.js';
import { scheduleFollowup } from '../followup/scheduler.js';
import { logInfo, logWarn } from '../lib/logging.js';

export async function zproFor(store, integration) {
  const token = await store.rpc('crm_ai_service_get_zpro_token', { p_integration_id: integration.id });
  return new ZproService({ baseUrl: integration.base_url, token });
}
export async function processTurn({ batch, store, model = generateTurnDecision, resourcesLoader = loadResources, zproFactory = zproFor }) {
  const conversation = batch.conversation; const owner = conversation.lease_owner;
  const envelope = mergeCurrentMessages(batch.turns); const head = batch.turns[0]; const turnKey = head.id;
  const ids = { tenantId: conversation.tenant_id, integrationId: conversation.integration_id,
    conversationId: conversation.id, ticketId: conversation.ticket_id, turnId: head.id };
  const resources = await resourcesLoader(store.db, conversation);
  const { agent, integration, actions, rules, references, followupPolicy } = resources;
  let opportunity = resources.opportunity;
  const configuredMode = engineMode(agent);
  const mode = configuredMode === 'legacy' ? 'legacy'
    : configuredMode === 'shadow' || envelope.metadata.engine_mode === 'shadow' ? 'shadow' : 'v2';
  if (!agent.enabled || !integration.active || agent.settings?.safe_mode || mode === 'legacy' || (process.env.APP_MODE || 'live') !== 'live') {
    await store.finish(batch, conversation.state, conversation.history); return;
  }
  const previous = { ...initialState(conversation.cycle), ...conversation.state };
  let history = conversation.history || [];
  if (mode === 'shadow') {
    const rows = await checked(store.db.from('crm_ai_ticket_context').select('role,content')
      .eq('tenant_id', conversation.tenant_id).eq('integration_id', conversation.integration_id)
      .eq('external_ticket_id', conversation.ticket_id).lt('created_at', head.created_at)
      .order('created_at', { ascending: false }).limit(24));
    history = (rows || []).reverse().filter((r) => ['user', 'assistant'].includes(r.role));
  }
  const zpro = mode === 'shadow' ? null : await zproFactory(store, integration);
  let ticket = mode === 'shadow' ? { id: envelope.ticket_id, status: envelope.ticket_context.status,
    userId: envelope.ticket_context.user_id, queueId: envelope.ticket_context.queue_id, channelId: envelope.metadata.channel_id }
    : ticketSnapshot(await zpro.showTicket(envelope.ticket_id));
  if (ticket.phone && String(ticket.phone).replace(/\D/g, '') !== envelope.metadata.phone) throw engineError('TICKET_CONTACT_MISMATCH');
  logInfo('turn.context_loaded', { ...ids, previous_state: previous.status, messageCount: batch.turns.length });
  const proposed = head.decision || await model({ agent, envelope, state: previous, history,
    capabilities: { ...resources.capabilities, audio_policy: agent.settings?.audio_policy }, rules });
  if (!head.decision) await store.saveDecision(head, owner, proposed);
  logInfo('turn.decision_generated', { ...ids, intent: proposed.intent, confidence: proposed.confidence,
    previous_state: previous.status, next_state: proposed.conversation.next_state, proposed_action: proposed.crm.action });
  const earlierCommands = head.attempts > 1 ? await checked(store.db.from('crm_ai_commands').select('*')
    .eq('conversation_id', conversation.id).eq('kind', 'move_ticket').eq('status', 'completed')) : [];
  const ownedTicketResult = earlierCommands.some((c) => c.command_key.startsWith(`ticket:${turnKey}:`)
    && c.result?.status === ticket.status && String(c.result?.userId || '') === String(ticket.userId || '')
    && String(c.result?.queueId || '') === String(ticket.queueId || ''));
  const validated = validateTurnDecision({ ...resources, envelope, state: previous, ticket, decision: proposed, ownedTicketResult });
  logInfo('turn.policy_validated', { ...ids, intent: proposed.intent, allowed: validated.allowed, blocked_reason: validated.blocked });
  if (mode === 'shadow') {
    const old = await checked(store.db.from('crm_ai_ticket_context').select('metadata').eq('tenant_id', conversation.tenant_id)
      .eq('integration_id', conversation.integration_id).eq('external_ticket_id', conversation.ticket_id).eq('role', 'assistant')
      .gte('created_at', head.created_at).order('created_at', { ascending: true }).limit(1));
    logInfo('turn.shadow_comparison', { ...ids, old_action: old?.[0]?.metadata?.decision?.action || null,
      new_intent: proposed.intent, new_action: validated.decision.crm.action, blocked_reason: validated.blocked });
    await store.finish(batch, previous, history); return;
  }
  if (!validated.allowed && !head.result) {
    await store.finish(batch, { ...previous, followup_eligible: false }, history); return;
  }
  const decision = validated.decision; const rule = validated.rule;
  let state = transitionState(previous, decision);
  conversation.cycle = state.cycle;
  const commands = new CommandExecutor(store, conversation, owner);
  conversation.expected_version = batch.turns.at(-1).version;
  if (Number((await store.current(conversation)).received_version) !== Number(conversation.expected_version)) {
    await store.finish(batch, previous, [...history, { role: 'user', content: envelope.current_message.text, turn_id: head.id }].slice(-40));
    logInfo('turn.superseded', ids); return;
  }
  const lead = await ensureLead(store.db, envelope);
  let reply = decision.reply; let failedAction = null; const executed = [];
  const done = head.result;
  if (done) { state = done.state; reply = done.reply; }
  else {
    try {
      if (previous.status === 'closed' && decision.intent === 'acknowledgement') { reply = ''; state = previous; }
      else {
        if (ticket.status === 'closed' && state.cycle > previous.cycle) {
          if (!actionAllowed(actions, 'transfer_ticket')) throw engineError('TICKET_REOPEN_NOT_ALLOWED');
          ticket = await moveTicket({ zpro, commands, conversation, turnKey, queueId: ticket.queueId, userId: null, status: 'pending' });
        }
        if (['offer', 'select_slot', 'change_preferences', 'check'].includes(decision.appointment.action)) {
          try {
            const appointment = await applyAppointmentWorkflow({ decision, state, envelope, agent, zpro, store, commands, conversation, turnKey });
            state = appointment.state; reply = appointment.reply;
            if (appointment.created) executed.push('create_appointment');
          } catch (error) {
            if (error.code !== 'APPOINTMENT_CONFLICT') throw error;
            const alternatives = await applyAppointmentWorkflow({ decision: { ...decision, appointment: { ...decision.appointment, action: 'offer', time: '', slot_id: '' } },
              state, envelope, agent, zpro, store, commands, conversation, turnKey });
            state = alternatives.state; reply = `Esse horário acabou de ficar indisponível.\n\n${alternatives.reply}`;
          }
        }
        const pending = state.status === 'appointment_pending';
        let userId = ticket.userId;
        if (decision.handoff.required && !pending) {
          const queueId = rule?.external_queue_id || integration.sales_queue_id;
          if (!queueId || !references.queues.some((q) => String(q.external_queue_id) === String(queueId) && q.active !== false)) throw engineError('HANDOFF_QUEUE_NOT_CONFIGURED');
          userId = await selectAssignee({ rule, references, store, conversation, commands, turnKey, zpro });
          ticket = await moveTicket({ zpro, commands, conversation, turnKey, queueId, userId, status: userId ? 'open' : 'pending' });
          state.status = 'human_handoff'; state.followup_eligible = false; executed.push('handoff');
          reply = [executed.includes('create_appointment') ? reply : decision.reply,
            rule?.handoff_message || agent.handoff_message || 'Seu atendimento foi encaminhado para nossa equipe.'].filter(Boolean).join('\n\n');
        }
        if (decision.close) {
          ticket = await moveTicket({ zpro, commands, conversation, turnKey, status: 'closed' });
          state.status = 'closed'; state.followup_eligible = false; executed.push('close_ticket');
          reply = 'Tudo certo, seu atendimento foi encerrado. Obrigado pelo contato!';
        }
        const initialRoute = { external_pipeline_id: integration.pipeline_id, external_stage_id: integration.initial_stage_id };
        const route = !pending && decision.crm.action === 'route' ? rule : null;
        const autoCreate = !opportunity?.external_opportunity_id && integration.auto_create_opportunity && actionAllowed(actions, 'create_opportunity') && routeResourcesValid(initialRoute, references);
        const ownerSync = opportunity && actionAllowed(actions, 'update_opportunity') && String(opportunity.assigned_external_user_id || '') !== String(userId || '');
        if (route || autoCreate || ownerSync) {
          const target = route || (opportunity ? { external_pipeline_id: opportunity.pipeline_id, external_stage_id: opportunity.stage_id } : initialRoute);
          try {
            opportunity = await syncOpportunity({ store, zpro, commands, conversation, envelope, lead, opportunity,
              route: target, userId, turnKey });
            executed.push('sync_opportunity');
          } catch (error) {
            failedAction = error.code || 'CRM_BACKGROUND_SYNC_FAILED';
            state = { ...state, followup_eligible: false, failed_background_action: failedAction };
            logWarn('turn.background_action_failed', { ...ids, error_code: failedAction, action: 'sync_opportunity' });
          }
        }
      }
    } catch (error) {
      if (error.code === 'TURN_SUPERSEDED') {
        await store.finish(batch, { ...state, followup_eligible: false }, [...history, { role: 'user', content: envelope.current_message.text, turn_id: head.id }].slice(-40));
        logInfo('turn.superseded', ids); return;
      }
      failedAction = error.code || 'EXTERNAL_ACTION_FAILED';
      state = { ...state, status: executed.includes('handoff') ? 'human_handoff' : executed.includes('close_ticket') ? 'closed' : 'failed_action',
        followup_eligible: false, failed_action: failedAction };
      // No fabricated commercial answer and no assertion that a failed operation succeeded.
      if (!executed.includes('handoff') && !executed.includes('close_ticket') && !executed.includes('create_appointment')) {
        reply = 'Não consegui concluir essa solicitação agora. Você pode tentar novamente ou pedir atendimento humano.';
      }
      logWarn('turn.action_failed', { ...ids, error_code: failedAction, executed_action: executed });
    }
    await checked(store.db.from('crm_ai_turns').update({ result: { state, reply, executed, failedAction } }).eq('id', head.id).eq('owner', owner));
  }
  if (reply) {
    if (Number((await store.current(conversation)).received_version) !== Number(conversation.expected_version)) {
      await store.finish(batch, { ...state, followup_eligible: false }, [...history, { role: 'user', content: envelope.current_message.text, turn_id: head.id }].slice(-40));
      logInfo('turn.superseded', ids); return;
    }
    const payload = { number: envelope.metadata.phone, body: reply, ticketId: envelope.ticket_id,
      channelId: envelope.metadata.channel_id, requireTicket: true, externalKey: messageExternalKey('v2_reply', integration.id, head.id) };
    await commands.run(`reply:${turnKey}`, 'send_message', payload, () => zpro.sendMessage(payload));
    logInfo('turn.reply_sent', ids);
  }
  const nextHistory = [...history, { role: 'user', content: envelope.current_message.text || '[midia]', turn_id: head.id },
    ...(reply ? [{ role: 'assistant', content: reply, turn_id: head.id }] : [])].slice(-40);
  state.last_envelope = { ...envelope, ad_context: null, quoted_message: null };
  state.lead_id = lead.id;
  await checked(store.db.from('crm_ai_leads').update({ status: state.status === 'closed' ? 'archived' : state.status === 'human_handoff' ? 'transferred' : 'ai_attending',
    assigned_external_user_id: ticket.userId || null, metadata: { ...lead.metadata, conversation_engine: 'v2', ai_agent_id: agent.id,
      ai_state: { stopped: ['closed', 'human_handoff'].includes(state.status), ticket_id: envelope.ticket_id } } })
    .eq('id', lead.id).eq('tenant_id', conversation.tenant_id));
  await scheduleFollowup({ store, conversation: { ...conversation, state, processed_version: batch.turns.at(-1).version },
    policy: followupPolicy, ticket, actions });
  await store.finish(batch, state, nextHistory);
  logInfo('turn.completed', { ...ids, intent: decision.intent, previous_state: previous.status, next_state: state.status,
    proposed_action: proposed.crm.action, executed_action: executed, blocked_reason: validated.blocked });
}
