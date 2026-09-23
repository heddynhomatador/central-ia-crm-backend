import { actionAllowed } from './state.js';

export function validateTurnDecision({ decision, agent, integration, envelope, state, actions, rules, references, ticket, opportunity, followupPolicy, ownedTicketResult = false }) {
  const d = structuredClone(decision);
  const blocked = [];
  const scopeValid = integration.tenant_id === envelope.tenant_id && integration.id === envelope.integration_id
    && agent.tenant_id === envelope.tenant_id && (!agent.settings?.integration_id || agent.settings.integration_id === integration.id)
    && (!agent.settings?.channel_id || String(agent.settings.channel_id) === String(envelope.metadata.channel_id));
  if (!scopeValid) return { allowed: false, blocked: ['scope_mismatch'], decision: d };
  if (!agent.enabled || !integration.active || agent.settings?.safe_mode) return { allowed: false, blocked: ['inactive_or_safe_mode'], decision: d };
  if (String(ticket.id) !== String(envelope.ticket_id) || (ticket.channelId && String(ticket.channelId) !== String(envelope.metadata.channel_id))) {
    return { allowed: false, blocked: ['ticket_scope_mismatch'], decision: d };
  }
  if (ticket.userId && !ownedTicketResult && !agent.settings?.allow_assigned_tickets) return { allowed: false, blocked: ['human_active'], decision: d };
  if (state.status === 'human_handoff') return { allowed: false, blocked: ['human_active'], decision: d };
  if (ticket.status === 'closed' && state.status !== 'closed' && !ownedTicketResult) return { allowed: false, blocked: ['ticket_closed'], decision: d };

  let rule = rules.find((r) => r.id === d.crm.rule_id) || null;
  if (d.crm.action === 'route' && !rule) { blocked.push('unknown_rule'); d.crm.action = 'none'; }
  if (rule) {
    const validPipeline = references.pipelines.some((p) => String(p.external_pipeline_id) === String(rule.external_pipeline_id));
    const validStage = references.stages.some((s) => String(s.external_stage_id) === String(rule.external_stage_id)
      && String(s.external_pipeline_id) === String(rule.external_pipeline_id));
    const validQueue = !rule.external_queue_id || references.queues.some((q) => String(q.external_queue_id) === String(rule.external_queue_id) && q.active !== false);
    if (!validPipeline || !validStage || !validQueue) { blocked.push('invalid_route_resources'); rule = null; d.crm.action = 'none'; }
  }
  const evidence = d.evidence.some((e) => e.trim() && envelope.current_message.text.toLocaleLowerCase().includes(e.toLocaleLowerCase()));
  const operational = d.crm.action !== 'none' || d.handoff.required || d.close || ['offer', 'select_slot', 'change_preferences', 'check'].includes(d.appointment.action);
  if (operational && (d.confidence < 0.85 || !evidence)) {
    blocked.push('insufficient_evidence'); rule = null; d.crm.action = 'none'; d.handoff.required = false; d.close = false; d.appointment.action = 'pause';
  }
  if (rule?.stop_ai_after_match && d.crm.action === 'route') d.handoff.required = true;
  if (d.handoff.required && !actionAllowed(actions, 'transfer_ticket')) { blocked.push('transfer_disabled'); d.handoff.required = false; }
  if (d.close && (d.intent !== 'conversation_close' || !actionAllowed(actions, 'close_ticket'))) { blocked.push('close_not_allowed'); d.close = false; }
  if (d.crm.action === 'route' && !actionAllowed(actions, opportunity?.external_opportunity_id ? 'update_opportunity' : 'create_opportunity')) { blocked.push('crm_action_disabled'); d.crm.action = 'none'; }
  const scheduleEnabled = agent.settings?.schedule_policy?.enabled === true && actionAllowed(actions, 'schedule_appointment');
  const appointmentIntents = ['appointment_request', 'appointment_slot_selection', 'appointment_reschedule'];
  if (['offer', 'select_slot', 'change_preferences', 'check'].includes(d.appointment.action) && (!scheduleEnabled || !appointmentIntents.includes(d.intent))) {
    blocked.push(scheduleEnabled ? 'appointment_intent_required' : 'appointment_disabled'); d.appointment.action = 'pause';
  }
  if (!appointmentIntents.includes(d.intent) && !['none', 'decline'].includes(d.appointment.action)) d.appointment.action = 'pause';
  if (d.intent === 'appointment_declined') { d.appointment.action = 'decline'; d.close = false; }
  if (d.appointment.action === 'select_slot' && (!d.appointment.confirmed || d.intent !== 'appointment_slot_selection')) {
    blocked.push('slot_not_confirmed'); d.appointment.action = 'check';
  }
  if (state.appointment?.status === 'awaiting_slot' && !appointmentIntents.includes(d.intent) && d.appointment.action === 'none') d.appointment.action = 'pause';
  // Terminal states are committed only after external success.
  if (['closed', 'human_handoff', 'appointment_confirmed', 'failed_action'].includes(d.conversation.next_state)) d.conversation.next_state = 'information';
  if (!appointmentIntents.includes(d.intent) && d.conversation.next_state === 'appointment_pending') d.conversation.next_state = 'information';
  if (d.close) d.handoff.required = false;
  d.followup.eligible = d.followup.eligible && !!followupPolicy?.enabled && actionAllowed(actions, 'schedule_followup') && blocked.length === 0;
  return { allowed: true, decision: d, rule, blocked };
}
