import { DateTime } from 'luxon';

function dayLabel(date, zone) {
  return DateTime.fromISO(date, { zone }).setLocale('pt-BR').toFormat("cccc, 'dia' d 'de' LLLL");
}
function hourLabel(time) {
  const [hour, minute] = time.split(':');
  return `${Number(hour)}h${minute === '00' ? '' : minute}`;
}
export function appointmentOptionsReply(options, period = '', zone = 'America/Sao_Paulo') {
  if (!options.length) return 'Não encontrei um horário livre nesse período. Qual outro dia ou período funciona pra você?';
  const groups = new Map();
  for (const slot of options.slice(0, 3)) groups.set(slot.date, [...(groups.get(slot.date) || []), slot]);
  const periodLabel = { morning: ' de manhã', afternoon: ' à tarde', evening: ' à noite' }[period] || '';
  if (groups.size === 1) {
    const [date, slots] = [...groups][0];
    return `Para ${dayLabel(date, zone)}${periodLabel}, tenho:\n\n${slots.map((s) => `• ${hourLabel(s.time)}`).join('\n')}\n\nAlgum desses horários funciona pra você?`;
  }
  return `Tenho estes horários disponíveis:\n\n${options.slice(0, 3).map((s) => `• ${dayLabel(s.date, zone)}, às ${hourLabel(s.time)}`).join('\n')}\n\nQual deles fica melhor pra você?`;
}
export function appointmentConfirmedReply(slot, zone) {
  return `Combinado! Seu agendamento foi confirmado para ${dayLabel(slot.date, zone)}, às ${hourLabel(slot.time)}.`;
}
