export const STATES = ['discovery', 'information', 'qualification', 'negotiation', 'appointment_pending',
  'appointment_confirmed', 'human_handoff', 'resolved', 'closed', 'failed_action'];
export const APPOINTMENT_ACTIONS = ['none', 'pause', 'decline', 'offer', 'select_slot', 'change_preferences', 'check'];
export function engineMode(agent) {
  const mode = agent?.settings?.conversation_engine || 'legacy';
  return ['legacy', 'shadow', 'v2'].includes(mode) ? mode : 'legacy';
}
export function actionAllowed(actions, key) {
  return Array.isArray(actions) && actions.some((a) => a.action_key === key && a.enabled === true);
}
export function initialState(cycle = 1) {
  return { status: 'discovery', cycle, topic: '', appointment: { status: 'idle', options: [] }, followup_eligible: false };
}
export function transitionState(previous, decision) {
  const state = structuredClone(previous || initialState());
  state.status = decision.conversation.next_state;
  state.topic = decision.topic;
  state.current_intent = decision.intent;
  state.followup_eligible = decision.followup.eligible;
  state.appointment ||= { status: 'idle', options: [] };
  if (decision.appointment.action === 'pause') state.appointment.status = 'paused';
  if (decision.appointment.action === 'decline') state.appointment = { status: 'declined', options: [] };
  if (previous?.status === 'closed' && decision.intent !== 'acknowledgement' && decision.intent !== 'conversation_close') {
    return { ...initialState(Number(previous.cycle || 1) + 1), ...state,
      cycle: Number(previous.cycle || 1) + 1, appointment: { status: 'idle', options: [] } };
  }
  return state;
}
export function followupEligible(state, ticket = {}) {
  return state?.followup_eligible === true
    && ['discovery', 'information', 'qualification', 'negotiation'].includes(state.status)
    && !['collecting', 'conflict', 'awaiting_slot', 'confirmed', 'uncertain'].includes(state.appointment?.status)
    && ticket.status === 'pending' && !ticket.userId;
}
