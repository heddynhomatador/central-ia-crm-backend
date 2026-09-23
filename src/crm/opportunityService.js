import { checked, engineError } from '../operations/store.js';
import { allPages, recordData } from './zproData.js';

export function exactOpportunityMatch(item, conversation, marker) {
  const ticketId = item.ticketId || item.ticket_id || item.ticket?.id;
  return String(ticketId || '') === String(conversation.ticket_id) || String(item.description || '').includes(marker);
}
export async function findExistingExternalOpportunity(zpro, conversation, marker) {
  const candidates = (await allPages((f) => zpro.listOpportunities(f), { ticketId: conversation.ticket_id }))
    .filter((item) => exactOpportunityMatch(item, conversation, marker));
  if (candidates.length > 1) throw engineError('OPPORTUNITY_MATCH_AMBIGUOUS');
  return candidates[0] || null;
}
export async function syncOpportunity({ store, zpro, commands, conversation, envelope, lead, opportunity, route, userId, turnKey }) {
  const marker = `Central IA ref:${conversation.id}`;
  const pipelineId = String(route.external_pipeline_id); const stageId = String(route.external_stage_id);
  const title = opportunity?.title || `${lead.name || lead.phone} - WhatsApp`;
  let id = opportunity?.external_opportunity_id;
  if (!id) {
    const payload = { number: lead.phone, contactName: lead.name || lead.phone, name: title, value: opportunity?.value || 0,
      status: 'open', pipelineId, stageId, responsibleId: userId || undefined,
      description: marker, validateNumber: !/waba|cloud|oficial/i.test(envelope.metadata.channel_type || '') };
    const recover = async () => {
      const found = await findExistingExternalOpportunity(zpro, conversation, marker);
      return found?.id ? { id: String(found.id) } : null;
    };
    const created = await commands.run('opportunity:create', 'create_opportunity', payload, async () => {
      const response = await zpro.createOpportunity(payload);
      const data = recordData(response.data, 'opportunity');
      const externalId = data.id || data.opportunityId || data.opportunity_id;
      if (externalId) return { id: String(externalId) };
      const recovered = await recover();
      if (!recovered) throw engineError('OPPORTUNITY_RESULT_UNCONFIRMED');
      return recovered;
    }, recover);
    id = created.id;
  } else if (String(opportunity.pipeline_id) !== pipelineId || String(opportunity.stage_id) !== stageId
    || String(opportunity.assigned_external_user_id || '') !== String(userId || '')) {
    const payload = { opportunityId: id, name: title, value: opportunity.value || 0, status: opportunity.status || 'open',
      pipelineId, stageId, responsibleId: userId || undefined };
    const verify = async (response = null) => {
      let data = response ? recordData(response.data, 'opportunity') : null;
      if (!data?.stageId && !data?.stage_id) {
        data = (await allPages((f) => zpro.listOpportunities(f), { ticketId: conversation.ticket_id }))
          .find((x) => String(x.id || x.opportunityId) === String(id));
      }
      return data && String(data.stageId || data.stage_id) === stageId && String(data.pipelineId || data.pipeline_id) === pipelineId
        && String(data.responsibleId ?? data.responsible_id ?? data.userId ?? '') === String(userId || '')
        ? { id, pipelineId, stageId } : null;
    };
    await commands.run(`opportunity:move:${turnKey}`, 'move_opportunity', payload, async () => {
      const result = await verify(await zpro.moveOpportunity(payload));
      if (!result) throw engineError('OPPORTUNITY_MOVE_UNCONFIRMED');
      return result;
    }, () => verify());
  }
  const payload = { tenant_id: conversation.tenant_id, integration_id: conversation.integration_id, lead_id: lead.id,
    external_ticket_id: conversation.ticket_id, external_opportunity_id: id, title, pipeline_id: pipelineId, stage_id: stageId,
    assigned_external_user_id: userId || null, status: opportunity?.status || 'open', value: opportunity?.value || 0,
    raw_data: { ...opportunity?.raw_data, engine_v2: true, sync_status: 'confirmed', conversation_id: conversation.id,
      confirmed_at: new Date().toISOString() }, updated_at: new Date().toISOString() };
  // Commit the local projection only after the external operation is confirmed.
  return checked((opportunity ? store.db.from('crm_ai_opportunities').update(payload).eq('id', opportunity.id).eq('tenant_id', conversation.tenant_id)
    : store.db.from('crm_ai_opportunities').insert(payload)).select('*').single());
}
