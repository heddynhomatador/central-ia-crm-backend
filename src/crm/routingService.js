import { allPages, ticketSnapshot } from './zproData.js';
import { validAssignees } from './resources.js';
import { engineError } from '../operations/store.js';

export function chooseLeastLoaded(users, tickets) {
  const counts = Object.fromEntries(users.map((id) => [id, 0]));
  for (const t of tickets) {
    const user = String(t.userId || t.user_id || t.user?.id || '');
    if (Object.hasOwn(counts, user) && t.status !== 'closed') counts[user]++;
  }
  return counts;
}
export async function selectAssignee({ rule, references, store, conversation, commands, turnKey, zpro }) {
  if (!rule) return null;
  const users = validAssignees(rule, references);
  const mode = rule.distribution_mode || 'balanced_rotation';
  if (mode === 'manual') return null;
  if (!users.length) throw engineError('ROUTE_USERS_NOT_CONFIGURED');
  const result = await commands.run(`assignee:${turnKey}`, 'choose_assignee', { rule_id: rule.id, mode, users }, async () => {
    const loads = mode === 'least_load'
      ? chooseLeastLoaded(users, await allPages((f) => zpro.listTickets(f), { status: 'open', queueId: rule.external_queue_id }, 200, false)) : {};
    const userId = await store.rpc('crm_ai_next_distribution', { p_tenant: conversation.tenant_id,
      p_integration: conversation.integration_id, p_rule: rule.id, p_users: users, p_mode: mode,
      p_loads: loads, p_assignment: `${conversation.id}:${conversation.cycle}:${turnKey}` });
    return { userId };
  });
  return result.userId;
}
export async function moveTicket({ zpro, commands, conversation, turnKey, queueId, userId, status }) {
  const payload = { ticketId: conversation.ticket_id, queueId: queueId || null, userId: userId || null, status,
    chatgptStatus: false, typebotStatus: false, dialogflowStatus: false, difyStatus: false, n8nStatus: false };
  const verify = async () => {
    const ticket = ticketSnapshot(await zpro.showTicket(conversation.ticket_id));
    return ticket.status === status && (status === 'closed' || (String(ticket.queueId || '') === String(queueId || '')
      && String(ticket.userId || '') === String(userId || ''))) ? ticket : null;
  };
  return commands.run(`ticket:${turnKey}:${status}`, 'move_ticket', payload, async () => {
    await zpro.updateTicketAssignment(payload);
    const ticket = await verify();
    if (!ticket) throw engineError('TICKET_UPDATE_NOT_VERIFIED');
    return ticket;
  }, verify);
}
