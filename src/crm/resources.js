import { checked, engineError } from '../operations/store.js';
import { actionAllowed } from '../conversation/state.js';

export async function loadResources(db, conversation) {
  const tenant = conversation.tenant_id; const integrationId = conversation.integration_id;
  const scoped = (table) => db.from(table).select('*').eq('tenant_id', tenant).eq('integration_id', integrationId);
  const [integration, agent, rules, pipelines, stages, queues, users, policies, opportunity] = await Promise.all([
    checked(db.from('crm_ai_integrations').select('*').eq('id', integrationId).eq('tenant_id', tenant).single()),
    checked(db.from('crm_ai_agents').select('*').eq('id', conversation.agent_id).eq('tenant_id', tenant).single()),
    checked(scoped('crm_ai_stage_assignment_rules').eq('active', true)),
    checked(scoped('crm_ai_zpro_pipelines_cache')), checked(scoped('crm_ai_zpro_stages_cache')),
    checked(scoped('crm_ai_zpro_queues_cache')), checked(scoped('crm_ai_zpro_users_cache')),
    checked(db.from('crm_ai_followup_policies').select('*').eq('tenant_id', tenant).eq('enabled', true)),
    checked(scoped('crm_ai_opportunities').eq('external_ticket_id', conversation.ticket_id).maybeSingle()),
  ]);
  const actions = await checked(db.from('crm_ai_actions').select('*').eq('tenant_id', tenant).eq('agent_id', agent.id));
  const references = { pipelines, stages, queues, users };
  const followupPolicy = policies.find((p) => p.agent_id === agent.id) || policies.find((p) => !p.agent_id) || null;
  return { integration, agent, actions, references, followupPolicy, opportunity,
    rules: rules.filter((r) => r.routing_instruction?.trim()).map((r) => ({ ...r,
      pipeline_name: pipelines.find((p) => p.external_pipeline_id === r.external_pipeline_id)?.name,
      stage_name: stages.find((s) => s.external_pipeline_id === r.external_pipeline_id && s.external_stage_id === r.external_stage_id)?.name,
    })),
    capabilities: { actions: actions.filter((a) => a.enabled).map((a) => a.action_key),
      appointment_enabled: !!agent.settings?.schedule_policy?.enabled && actionAllowed(actions, 'schedule_appointment'),
      followup_enabled: !!followupPolicy && actionAllowed(actions, 'schedule_followup') },
  };
}
export async function ensureLead(db, envelope) {
  return checked(db.rpc('crm_ai_engine_lead', { p_envelope: envelope }));
}
export function routeResourcesValid(route, references) {
  return references.pipelines.some((p) => String(p.external_pipeline_id) === String(route.external_pipeline_id))
    && references.stages.some((s) => String(s.external_stage_id) === String(route.external_stage_id) && String(s.external_pipeline_id) === String(route.external_pipeline_id));
}
export function validAssignees(rule, references) {
  const selected = [...new Set((rule.user_order || []).map(String))];
  const users = references.users.filter((u) => u.active !== false && selected.includes(String(u.external_user_id)));
  if (users.length !== selected.length) throw engineError('ROUTE_USER_INVALID');
  const queue = references.queues.find((q) => String(q.external_queue_id) === String(rule.external_queue_id));
  const queueUsers = queue?.raw_data?.users || queue?.raw_data?.members;
  for (const user of users) {
    const memberships = user.raw_data?.queues || user.raw_data?.queueIds;
    const known = Array.isArray(memberships) ? memberships.map((q) => String(q.id ?? q.queueId ?? q))
      : Array.isArray(queueUsers) ? (queueUsers.some((u) => String(u.id ?? u.userId ?? u) === String(user.external_user_id)) ? [String(rule.external_queue_id)] : [])
      : null;
    if (known && !known.includes(String(rule.external_queue_id))) throw engineError('ROUTE_USER_OUTSIDE_QUEUE');
  }
  return selected;
}
