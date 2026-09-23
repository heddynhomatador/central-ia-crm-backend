import { actionAllowed, followupEligible } from '../conversation/state.js';
import { checked } from '../operations/store.js';
import { logInfo } from '../lib/logging.js';

export function followupMessage(policy, attempt) {
  const item = policy?.messages?.[attempt - 1];
  return typeof item === 'string' ? item.trim() : String(item?.message || item?.text || '').trim();
}
export async function scheduleFollowup({ store, conversation, policy, ticket, actions, attempt = null }) {
  if (!policy?.enabled || policy.tenant_id !== conversation.tenant_id || !actionAllowed(actions, 'schedule_followup')
    || !followupEligible(conversation.state, ticket)) return null;
  const current = await store.current(conversation);
  if (Number(current.received_version) !== Number(conversation.processed_version)
    || (current.cycle !== conversation.cycle && current.lease_owner !== conversation.lease_owner)) return null;
  if (attempt == null) {
    attempt = 1;
    if (!policy.reset_attempts_on_reply) {
      const previous = await checked(store.db.from('crm_ai_followup_runs').select('attempt').eq('conversation_id', conversation.id)
        .eq('cycle', conversation.cycle).eq('policy_id', policy.id).eq('status', 'sent').order('attempt', { ascending: false }).limit(1));
      attempt = Number(previous[0]?.attempt || 0) + 1;
    }
  }
  if (attempt > Number(policy.max_attempts || 3) || !followupMessage(policy, attempt)) return null;
  const delay = Math.max(1, Number(policy.delays_minutes?.[attempt - 1] || 60));
  const job = { tenant_id: conversation.tenant_id, conversation_id: conversation.id, cycle: conversation.cycle,
    turn_version: conversation.processed_version, policy_id: policy.id, attempt, status: 'pending',
    run_at: new Date(Date.now() + delay * 60000).toISOString() };
  const { data, error } = await store.db.from('crm_ai_followup_runs').upsert(job, {
    onConflict: 'conversation_id,cycle,turn_version,policy_id,attempt', ignoreDuplicates: true,
  }).select('*').maybeSingle();
  if (error) throw error;
  if (data) logInfo('turn.followup_scheduled', { conversationId: conversation.id, jobId: data.id, attempt, turnVersion: job.turn_version });
  return data;
}
