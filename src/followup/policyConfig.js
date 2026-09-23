import { z } from 'zod';
import { routeResourcesValid, validAssignees } from '../crm/resources.js';

export const followupPolicySchema = z.object({
  enabled: z.boolean(), max_attempts: z.number().int().min(1).max(3),
  delays_minutes: z.array(z.number().int().min(1).max(43200)).min(1).max(3),
  messages: z.array(z.string().max(4000)).min(1).max(3),
  transfer_after_last: z.boolean(), reset_attempts_on_reply: z.boolean(),
  transfer_queue_id: z.string().nullable().optional(), transfer_pipeline_id: z.string().nullable().optional(),
  transfer_stage_id: z.string().nullable().optional(), transfer_user_order: z.array(z.string()).max(200),
});
export function validateFollowupPolicy(input, references) {
  const value = followupPolicySchema.parse(input);
  if (value.enabled && (value.messages.length < value.max_attempts || value.delays_minutes.length < value.max_attempts
    || value.messages.slice(0, value.max_attempts).some((m) => !m.trim()))) throw new Error('Preencha todas as mensagens e intervalos ativos');
  if (value.transfer_after_last) {
    const rule = { external_pipeline_id: value.transfer_pipeline_id, external_stage_id: value.transfer_stage_id,
      external_queue_id: value.transfer_queue_id, user_order: value.transfer_user_order };
    if (!routeResourcesValid(rule, references) || !references.queues.some((q) => q.active !== false && String(q.external_queue_id) === String(value.transfer_queue_id))) {
      throw new Error('Destino do follow-up invalido para esta integracao');
    }
    if (!validAssignees(rule, references).length) throw new Error('Selecione os usuarios que receberao o atendimento');
  }
  return value;
}
