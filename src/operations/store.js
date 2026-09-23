import { randomUUID } from 'node:crypto';

export function engineError(code) { return Object.assign(new Error(code), { code }); }
export async function checked(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

export class EngineStore {
  constructor(db) { this.db = db; }
  rpc(name, args) { return checked(this.db.rpc(name, args)); }
  enqueue(envelope) {
    return this.rpc('crm_ai_enqueue_turn', { p_tenant: envelope.tenant_id, p_integration: envelope.integration_id,
      p_agent: envelope.agent_id, p_ticket: envelope.ticket_id, p_event: envelope.external_event_id, p_envelope: envelope });
  }
  claim(owner = randomUUID()) { return this.rpc('crm_ai_claim_turn', { p_owner: owner }); }
  async assertLease(conversation, owner) {
    const valid = await this.rpc('crm_ai_renew_lease', { p_conversation: conversation.id, p_owner: owner });
    if (!valid) throw engineError('ENGINE_LEASE_LOST');
  }
  saveDecision(turn, owner, decision) {
    return checked(this.db.from('crm_ai_turns').update({ decision }).eq('id', turn.id).eq('owner', owner).select('id').single());
  }
  finish(batch, state, history, error = null) {
    return this.rpc('crm_ai_finish_turn', { p_conversation: batch.conversation.id,
      p_owner: batch.conversation.lease_owner, p_ids: batch.turns.map((t) => t.id), p_state: state, p_history: history, p_error: error });
  }
  async current(conversation) {
    return checked(this.db.from('crm_ai_conversations').select('*').eq('id', conversation.id)
      .eq('tenant_id', conversation.tenant_id).single());
  }
  claimCommand(conversation, owner, key, kind, payload) {
    return this.rpc('crm_ai_claim_command', { p_conversation: conversation.id, p_owner: owner,
      p_cycle: conversation.cycle, p_key: key, p_kind: kind, p_payload: payload });
  }
  async finishCommand(command, owner, status, result, code = null) {
    const current = await checked(this.db.from('crm_ai_commands').update({ status, result, error_code: code, updated_at: new Date().toISOString() })
      .eq('id', command.id).eq('owner', owner).select('id').maybeSingle());
    if (!current) throw engineError('ENGINE_COMMAND_OWNERSHIP_LOST');
  }
  reserveSlot(conversation, owner, key, start, end) {
    return this.rpc('crm_ai_reserve_slot', { p_conversation: conversation.id, p_owner: owner, p_key: key, p_start: start, p_end: end });
  }
  updateSlot(id, status, externalId = null) {
    return checked(this.db.from('crm_ai_slot_reservations').update({ status, external_id: externalId }).eq('id', id));
  }
}
