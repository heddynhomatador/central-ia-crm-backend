import { DateTime } from 'luxon';
import { allPages, recordData } from '../crm/zproData.js';
import { checked, engineError } from '../operations/store.js';
import { definitiveFailure } from '../operations/commandExecutor.js';
import { appointmentOptionsReply, appointmentConfirmedReply } from './appointmentRenderer.js';

export function schedulePolicy(agent) {
  const p = agent.settings?.schedule_policy || {};
  const bounded = (v, fallback, min, max) => Number.isFinite(Number(v)) ? Math.max(min, Math.min(max, Number(v))) : fallback;
  return { ...p, timezone: p.timezone || 'America/Sao_Paulo', duration_minutes: bounded(p.duration_minutes, 60, 5, 480),
    buffer_minutes: bounded(p.buffer_minutes, 15, 0, 240), advance_notice_minutes: bounded(p.advance_notice_minutes, 60, 0, 43200),
    horizon_days: bounded(p.horizon_days, 21, 1, 90), business_hours: p.business_hours || {} };
}
export function slotFor(date, time, policy) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
  const start = DateTime.fromISO(`${date}T${time}`, { zone: policy.timezone });
  if (!start.isValid || start.toFormat('HH:mm') !== time) return null;
  const end = start.plus({ minutes: policy.duration_minutes });
  return { id: `${date}T${time}`, date, time, start_at: start.toUTC().toISO(), end_at: end.toUTC().toISO() };
}
export function slotValid(slot, policy, now = Date.now()) {
  if (!slot) return false;
  const start = DateTime.fromISO(slot.start_at).setZone(policy.timezone);
  const end = DateTime.fromISO(slot.end_at).setZone(policy.timezone);
  const hours = policy.business_hours[String(start.weekday % 7)] || [];
  return start.toMillis() >= now + policy.advance_notice_minutes * 60000
    && start.toMillis() <= now + policy.horizon_days * 86400000 && start.toISODate() === end.toISODate()
    && hours.some(([a, b]) => slot.time >= a && end.toFormat('HH:mm') <= b);
}
export function slotFree(slot, busy, bufferMinutes) {
  const start = Date.parse(slot.start_at); const end = Date.parse(slot.end_at) + bufferMinutes * 60000;
  return !busy.some((b) => start < Date.parse(b.end_at) + (b.buffered ? 0 : bufferMinutes * 60000) && end > Date.parse(b.start_at));
}
async function busyPeriods(zpro, store, conversation, from, to) {
  const lists = await Promise.all(['pending', 'confirmed'].map((status) => allPages((f) => zpro.listAppointments(f),
    { status, startFrom: DateTime.fromISO(from).minus({ days: 1 }).toISO(), startTo: to })));
  const local = await checked(store.db.from('crm_ai_slot_reservations').select('*').eq('tenant_id', conversation.tenant_id)
    .eq('integration_id', conversation.integration_id).neq('status', 'released').lt('starts_at', to).gt('ends_at', from));
  const external = lists.flat().map((a) => ({ start_at: a.startAt || a.start_at, end_at: a.endAt || a.end_at }));
  if (external.some((a) => !Number.isFinite(Date.parse(a.start_at)) || !Number.isFinite(Date.parse(a.end_at)))) throw engineError('APPOINTMENT_DATA_INVALID');
  return [...external, ...local.map((a) => ({ start_at: a.starts_at, end_at: a.ends_at, buffered: true }))];
}
export async function availableSlots({ zpro, store, conversation, policy, date = '', period = '', now = Date.now() }) {
  const today = DateTime.fromMillis(now, { zone: policy.timezone }).startOf('day');
  const first = date ? DateTime.fromISO(date, { zone: policy.timezone }) : today;
  if (!first.isValid) throw engineError('APPOINTMENT_DATE_INVALID');
  const days = date ? 1 : policy.horizon_days;
  const busy = await busyPeriods(zpro, store, conversation, first.toUTC().toISO(), first.plus({ days }).toUTC().toISO());
  const slots = [];
  for (let day = 0; day < days && slots.length < 3; day++) {
    const current = first.plus({ days: day });
    for (const [a, b] of policy.business_hours[String(current.weekday % 7)] || []) {
      let time = DateTime.fromISO(`${current.toISODate()}T${a}`, { zone: policy.timezone });
      const until = DateTime.fromISO(`${current.toISODate()}T${b}`, { zone: policy.timezone });
      while (time.plus({ minutes: policy.duration_minutes }) <= until && slots.length < 3) {
        const slot = slotFor(current.toISODate(), time.toFormat('HH:mm'), policy);
        const matches = !period || (period === 'morning' && time.hour < 12) || (period === 'afternoon' && time.hour >= 12 && time.hour < 18) || (period === 'evening' && time.hour >= 18);
        if (matches && slotValid(slot, policy, now) && slotFree(slot, busy, policy.buffer_minutes)) slots.push(slot);
        time = time.plus({ minutes: policy.duration_minutes + policy.buffer_minutes });
      }
    }
  }
  return slots;
}

export async function applyAppointmentWorkflow({ decision, state, envelope, agent, zpro, store, commands, conversation, turnKey }) {
  const a = decision.appointment; const policy = schedulePolicy(agent);
  const previous = state.appointment || {};
  if (['none', 'pause', 'decline'].includes(a.action)) return { state, reply: decision.reply, created: false };
  if (previous.external_id) {
    return { state: { ...state, status: 'appointment_confirmed', followup_eligible: false },
      reply: 'Sua reunião já está registrada. Para alterar ou cancelar essa reserva, preciso encaminhar você à equipe. Você deseja falar com um atendente?',
      created: false };
  }
  let slot = previous.options?.find((s) => s.id === a.slot_id);
  if (!slot && a.date && a.time) slot = slotFor(a.date, a.time, policy);
  if (a.action === 'select_slot' && a.confirmed && slotValid(slot, policy)) {
    const key = `appointment:${turnKey}`;
    const payload = { title: `Agendamento - ${envelope.metadata.contact_name || envelope.metadata.phone}`,
      description: decision.handoff.reason || 'Agendamento solicitado pelo cliente.', contactId: envelope.contact_id,
      contactName: envelope.metadata.contact_name, contactPhone: envelope.metadata.phone, whatsappId: envelope.metadata.channel_id,
      startAt: slot.start_at, endAt: slot.end_at, status: 'confirmed', notes: `Central IA: ${conversation.id}/${conversation.cycle}/${turnKey}` };
    const result = await commands.run(key, 'create_appointment', payload, async () => {
      const busy = await busyPeriods(zpro, store, conversation, slot.start_at, DateTime.fromISO(slot.end_at).plus({ minutes: policy.buffer_minutes }).toISO());
      if (!slotFree(slot, busy, policy.buffer_minutes)) throw Object.assign(engineError('APPOINTMENT_CONFLICT'), { status: 409 });
      const reservation = await store.reserveSlot(conversation, conversation.lease_owner, key, slot.start_at,
        DateTime.fromISO(slot.end_at).plus({ minutes: policy.buffer_minutes }).toISO());
      if (!reservation) throw Object.assign(engineError('APPOINTMENT_CONFLICT'), { status: 409 });
      try {
        const response = await zpro.createAppointment(payload);
        const data = recordData(response.data, 'appointment');
        const id = data.id || data.appointmentId;
        if (!id) throw engineError('APPOINTMENT_RESULT_UNCONFIRMED');
        await store.updateSlot(reservation.id, 'confirmed', String(id));
        return { id: String(id), slot };
      } catch (error) {
        await store.updateSlot(reservation.id, definitiveFailure(error) ? 'released' : 'uncertain');
        throw error;
      }
    }, async (p) => {
      const found = (await allPages((f) => zpro.listAppointments(f), { startFrom: p.startAt, startTo: p.endAt }))
        .filter((x) => x.notes === p.notes && x.startAt === p.startAt);
      if (found.length !== 1 || !found[0].id) return null;
      await checked(store.db.from('crm_ai_slot_reservations').update({ status: 'confirmed', external_id: String(found[0].id) })
        .eq('conversation_id', conversation.id).eq('command_key', key));
      return { id: String(found[0].id), slot };
    });
    return { created: true, reply: appointmentConfirmedReply(result.slot, policy.timezone),
      state: { ...state, status: 'appointment_confirmed', followup_eligible: false,
        appointment: { status: 'confirmed', external_id: result.id, slot: result.slot, options: [] } } };
  }
  const date = a.date || (a.action !== 'change_preferences' ? previous.preferred_date : '') || '';
  const period = a.period || previous.period || '';
  const options = await availableSlots({ zpro, store, conversation, policy, date, period });
  return { created: false, reply: appointmentOptionsReply(options, period, policy.timezone),
    state: { ...state, status: 'appointment_pending', followup_eligible: false,
      appointment: { status: options.length ? 'awaiting_slot' : 'conflict', options, preferred_date: date, period } } };
}
