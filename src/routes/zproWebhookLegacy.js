import express from 'express';
import OpenAI from 'openai';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { ZproService, messageExternalKey, zproRequiresSession } from '../services/zproService.js';
import {
  cancelPendingFollowups,
  scheduleFollowupAfterAiReply,
} from '../services/followupWorker.js';
import {
  getRawBodyForLog,
  logError,
  logInfo,
  logWarn,
  sanitizeHeaders,
  sanitizeObject,
} from '../lib/logging.js';
import { APP_RELEASE } from '../lib/buildInfo.js';

export const zproWebhookRouter = express.Router();

let optionalLeadColumnsAvailable = true;
let optionalLeadColumnsNextRetryAt = 0;
let ticketContextTableAvailable = true;
let ticketContextNextRetryAt = 0;
let openaiClient = null;

function onlyDigits(value = '') {
  return String(value || '').replace(/\D/g, '');
}

function parseTimestamp(value) {
  if (!value) return null;

  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    const millis = numeric > 9999999999 ? numeric : numeric * 1000;
    return new Date(millis).toISOString();
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function pickFirst(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function pickFirstText(...values) {
  const value = values.find((item) => typeof item === 'string' && item.trim());
  return value ? value.trim() : '';
}

function pickValue(item = {}, paths = []) {
  for (const path of paths) {
    const value = String(path)
      .split('.')
      .reduce((acc, key) => (acc && typeof acc === 'object' ? acc[key] : undefined), item);

    if (value !== undefined && value !== null && value !== '') return value;
  }

  return null;
}

function normalizeId(value = '') {
  return String(value || '').trim().toLowerCase();
}

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

const DEFAULT_SCHEDULE_HOURS = {
  0: [],
  1: [['09:00', '12:00'], ['13:00', '18:00']],
  2: [['09:00', '12:00'], ['13:00', '18:00']],
  3: [['09:00', '12:00'], ['13:00', '18:00']],
  4: [['09:00', '12:00'], ['13:00', '18:00']],
  5: [['09:00', '12:00'], ['13:00', '18:00']],
  6: [],
};

function validTime(value = '') {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''));
}

function normalizedSchedulePolicy(input = {}) {
  const policy = input && typeof input === 'object' ? input : {};
  const hours = {};

  for (let day = 0; day <= 6; day += 1) {
    const rawIntervals = policy.business_hours?.[day] || policy.business_hours?.[String(day)] || DEFAULT_SCHEDULE_HOURS[day];
    hours[day] = (Array.isArray(rawIntervals) ? rawIntervals : [])
      .map((interval) => Array.isArray(interval) ? interval : [interval?.start, interval?.end])
      .filter((interval) => validTime(interval?.[0]) && validTime(interval?.[1]) && interval[0] < interval[1])
      .map((interval) => [String(interval[0]), String(interval[1])]);
  }

  return {
    enabled: policy.enabled === true,
    timezone: String(policy.timezone || 'America/Sao_Paulo'),
    duration_minutes: boundedNumber(policy.duration_minutes, 60, 15, 480),
    buffer_minutes: boundedNumber(policy.buffer_minutes, 15, 0, 240),
    advance_notice_minutes: boundedNumber(policy.advance_notice_minutes, 60, 0, 10080),
    horizon_days: boundedNumber(policy.horizon_days, 21, 1, 90),
    business_hours: hours,
  };
}

function normalizeExternalList(data) {
  const keys = ['appointments', 'opportunities', 'kanbans', 'cards', 'items', 'results', 'rows', 'records', 'data'];
  const visited = new Set();

  function visit(value, depth = 0) {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== 'object' || depth > 4 || visited.has(value)) return [];
    visited.add(value);

    for (const key of keys) {
      if (Array.isArray(value[key])) return value[key];
    }
    for (const key of keys) {
      const nested = visit(value[key], depth + 1);
      if (nested.length > 0) return nested;
    }
    return [];
  }

  return visit(data);
}

let appointmentSchedulingQueue = Promise.resolve();

async function withAppointmentSchedulingLock(task) {
  const previous = appointmentSchedulingQueue;
  let release;
  appointmentSchedulingQueue = new Promise((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    return await task();
  } finally {
    release();
  }
}

function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}

function localDateKey(date, timeZone) {
  const parts = zonedParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addDaysToDateKey(dateKey, days) {
  const base = new Date(`${dateKey}T12:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

function zonedDateTimeToUtc(dateKey, time, timeZone) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || !validTime(time)) return null;
  const [year, month, day] = dateKey.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const desiredUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let candidate = new Date(desiredUtc);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const actual = zonedParts(candidate, timeZone);
    const actualAsUtc = Date.UTC(
      Number(actual.year),
      Number(actual.month) - 1,
      Number(actual.day),
      Number(actual.hour),
      Number(actual.minute),
      Number(actual.second),
    );
    candidate = new Date(candidate.getTime() + (desiredUtc - actualAsUtc));
  }

  return candidate;
}

function timeMinutes(value = '') {
  if (!validTime(value)) return null;
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function appointmentPeriod(item = {}) {
  const startValue = pickValue(item, [
    'startAt',
    'start_at',
    'start',
    'data.startAt',
    'appointment.startAt',
  ]);
  const endValue = pickValue(item, [
    'endAt',
    'end_at',
    'end',
    'data.endAt',
    'appointment.endAt',
  ]);
  const start = startValue ? new Date(startValue) : null;
  const end = endValue ? new Date(endValue) : null;
  if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return { start, end };
}

async function loadBusyAppointments(zpro, start, end) {
  const filters = {
    page: 1,
    limit: 200,
    startFrom: start.toISOString(),
    startTo: end.toISOString(),
  };
  const responses = await Promise.all([
    zpro.listAppointments({ ...filters, status: 'pending' }),
    zpro.listAppointments({ ...filters, status: 'confirmed' }),
  ]);

  const periods = responses
    .flatMap((response) => normalizeExternalList(response.data))
    .map(appointmentPeriod)
    .filter(Boolean);

  return { periods, responses };
}

function slotIsFree(start, end, busyPeriods = [], bufferMinutes = 0) {
  const bufferMs = bufferMinutes * 60 * 1000;
  return !busyPeriods.some((busy) => (
    start.getTime() < busy.end.getTime() + bufferMs &&
    end.getTime() + bufferMs > busy.start.getTime()
  ));
}

function slotInsideBusinessHours(dateKey, time, durationMinutes, policy) {
  const day = new Date(`${dateKey}T12:00:00.000Z`).getUTCDay();
  const startMinute = timeMinutes(time);
  if (startMinute === null) return false;
  return (policy.business_hours[day] || []).some(([from, to]) => {
    const fromMinute = timeMinutes(from);
    const toMinute = timeMinutes(to);
    return startMinute >= fromMinute && startMinute + durationMinutes <= toMinute;
  });
}

function formatAppointmentSlot(date, timeZone) {
  const day = new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(date);
  const time = new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
  const [hour, minute] = time.split(':');
  return `${day}, às ${hour}h${minute === '00' ? '' : minute}`;
}

function formatAppointmentOptionTime(option = {}) {
  const [hour = '', minute = ''] = String(option.time || '').split(':');
  return `${Number(hour)}h${minute === '00' ? '' : minute}`;
}

function appointmentOptionsReply(options = [], period = '') {
  if (options.length === 0) return '';
  const dateLabels = new Map();
  for (const option of options) {
    const dateLabel = String(option.label || '').split(', às ')[0];
    if (!dateLabels.has(option.date)) dateLabels.set(option.date, dateLabel);
  }
  const periodText = period ? ` no período ${appointmentPeriodLabel(period)}` : '';
  const lines = options.map((option, index) => {
    const includeDate = dateLabels.size > 1;
    const rawDateLabel = String(option.label || '').split(', às ')[0];
    const dateLabel = rawDateLabel.charAt(0).toUpperCase() + rawDateLabel.slice(1);
    return `${index + 1}. ${includeDate ? `${dateLabel}, às ` : ''}${formatAppointmentOptionTime(option)}`;
  });
  const onlyDate = Array.from(dateLabels.values())[0] || '';
  const capitalizedDate = onlyDate.charAt(0).toUpperCase() + onlyDate.slice(1);
  const dateText = dateLabels.size === 1 ? ` para ${capitalizedDate}` : '';
  return `Encontrei estes horários${dateText}${periodText}:\n\n${lines.join('\n')}\n\nQual opção funciona melhor para você?`;
}

export function appointmentPeriodPreference(text = '') {
  const current = normalizeText(text);
  const candidates = [
    { period: 'morning', index: current.lastIndexOf('manha') },
    { period: 'afternoon', index: current.lastIndexOf('tarde') },
    { period: 'night', index: current.lastIndexOf('noite') },
  ].filter((item) => item.index >= 0).sort((a, b) => b.index - a.index);
  return candidates[0]?.period || '';
}

const APPOINTMENT_WEEKDAYS = {
  domingo: 0,
  dom: 0,
  segunda: 1,
  seg: 1,
  terca: 2,
  ter: 2,
  quarta: 3,
  qua: 3,
  quinta: 4,
  qui: 4,
  sexta: 5,
  sex: 5,
  sabado: 6,
  sab: 6,
};

const APPOINTMENT_MONTHS = {
  janeiro: 1,
  fevereiro: 2,
  marco: 3,
  abril: 4,
  maio: 5,
  junho: 6,
  julho: 7,
  agosto: 8,
  setembro: 9,
  outubro: 10,
  novembro: 11,
  dezembro: 12,
};

const PT_NUMBER_UNITS = {
  zero: 0,
  um: 1,
  uma: 1,
  dois: 2,
  duas: 2,
  tres: 3,
  quatro: 4,
  cinco: 5,
  seis: 6,
  sete: 7,
  oito: 8,
  nove: 9,
  dez: 10,
  onze: 11,
  doze: 12,
  treze: 13,
  quatorze: 14,
  catorze: 14,
  quinze: 15,
  dezesseis: 16,
  dezasseis: 16,
  dezessete: 17,
  dezassete: 17,
  dezoito: 18,
  dezenove: 19,
  dezanove: 19,
};

const PT_NUMBER_TENS = {
  vinte: 20,
  trinta: 30,
  quarenta: 40,
  cinquenta: 50,
};

function parsePortugueseNumber(value = '', max = 59) {
  const current = normalizeText(value).replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
  if (!current) return null;
  if (/^\d{1,2}$/.test(current)) {
    const numeric = Number(current);
    return numeric <= max ? numeric : null;
  }
  if (Object.hasOwn(PT_NUMBER_UNITS, current)) {
    const numeric = PT_NUMBER_UNITS[current];
    return numeric <= max ? numeric : null;
  }
  const compound = current.match(/^(vinte|trinta|quarenta|cinquenta)(?:\s+e\s+)?(um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove)?$/);
  if (!compound) return null;
  const numeric = PT_NUMBER_TENS[compound[1]] + (compound[2] ? PT_NUMBER_UNITS[compound[2]] : 0);
  return numeric <= max ? numeric : null;
}

const PT_NUMBER_PATTERN = '(?:\\d{1,2}|zero|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|treze|quatorze|catorze|quinze|dezesseis|dezasseis|dezessete|dezassete|dezoito|dezenove|dezanove|vinte(?:\\s+e\\s+(?:um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove))?|trinta(?:\\s+e\\s+(?:um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove))?|quarenta(?:\\s+e\\s+(?:um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove))?|cinquenta(?:\\s+e\\s+(?:um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove))?)';

function dateKeyInsideScheduleHorizon(dateKey, now, timeZone, horizonDays) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ''))) return false;
  const today = localDateKey(now, timeZone);
  return dateKey >= today && dateKey <= addDaysToDateKey(today, horizonDays);
}

export function appointmentDatePreference(
  text = '',
  { now = new Date(), timeZone = 'America/Sao_Paulo', horizonDays = 90 } = {},
) {
  const current = normalizeText(text).replace(/\s+/g, ' ').trim();
  if (!current) return '';
  if (/\b(primeira|segunda|terceira)\s+opcao\b/i.test(current)) return '';
  const today = localDateKey(now, timeZone);

  if (/\bdepois de amanha\b/i.test(current)) return addDaysToDateKey(today, 2);
  const tomorrowRejected = /\bamanha\b.{0,20}\b(nao|nao consigo|nao posso|nao da)\b/i.test(current)
    || /\b(nao consigo|nao posso|nao da)\b.{0,20}\bamanha\b/i.test(current);
  if (/\bamanha\b/i.test(current) && !tomorrowRejected) return addDaysToDateKey(today, 1);
  if (/\bhoje\b/i.test(current)) return today;

  const numericDate = Array.from(current.matchAll(/\b([0-3]?\d)[/-]([01]?\d)(?:[/-](\d{2}|\d{4}))?\b/g)).at(-1);
  if (numericDate) {
    const todayParts = today.split('-').map(Number);
    const yearText = numericDate[3];
    let year = yearText ? Number(yearText.length === 2 ? `20${yearText}` : yearText) : todayParts[0];
    const month = Number(numericDate[2]);
    const day = Number(numericDate[1]);
    let candidate = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (!yearText && candidate < today) {
      year += 1;
      candidate = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    const parsed = new Date(`${candidate}T12:00:00.000Z`);
    if (
      !Number.isNaN(parsed.getTime())
      && parsed.toISOString().slice(0, 10) === candidate
      && dateKeyInsideScheduleHorizon(candidate, now, timeZone, horizonDays)
    ) return candidate;
  }

  const monthNames = Object.keys(APPOINTMENT_MONTHS).join('|');
  const namedDatePattern = new RegExp(`\\b(?:dia\\s+)?(${PT_NUMBER_PATTERN})\\s+de\\s+(${monthNames})(?:\\s+de\\s+(\\d{4}))?\\b`, 'g');
  const namedDate = Array.from(current.matchAll(namedDatePattern)).at(-1);
  if (namedDate) {
    const day = parsePortugueseNumber(namedDate[1], 31);
    const month = APPOINTMENT_MONTHS[namedDate[2]];
    const todayYear = Number(today.slice(0, 4));
    let year = namedDate[3] ? Number(namedDate[3]) : todayYear;
    let candidate = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (!namedDate[3] && candidate < today) {
      year += 1;
      candidate = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    const parsed = new Date(`${candidate}T12:00:00.000Z`);
    if (
      day !== null
      && !Number.isNaN(parsed.getTime())
      && parsed.toISOString().slice(0, 10) === candidate
      && dateKeyInsideScheduleHorizon(candidate, now, timeZone, horizonDays)
    ) return candidate;
  }

  const dayOfMonthPattern = new RegExp(`\\b(?:dia)\\s+(${PT_NUMBER_PATTERN})\\b`, 'g');
  const dayOfMonth = Array.from(current.matchAll(dayOfMonthPattern)).at(-1);
  if (dayOfMonth) {
    const day = parsePortugueseNumber(dayOfMonth[1], 31);
    const [year, month] = today.split('-').map(Number);
    for (let monthOffset = 0; day !== null && monthOffset <= 1; monthOffset += 1) {
      const candidateDate = new Date(Date.UTC(year, month - 1 + monthOffset, day, 12));
      const candidate = candidateDate.toISOString().slice(0, 10);
      if (
        candidateDate.getUTCDate() === day
        && dateKeyInsideScheduleHorizon(candidate, now, timeZone, horizonDays)
      ) return candidate;
    }
  }

  const weekdayMatches = Array.from(current.matchAll(/\b(domingo|segunda(?:-feira)?|terca(?:-feira)?|quarta(?:-feira)?|quinta(?:-feira)?|sexta(?:-feira)?|sabado|dom|seg|ter|qua|qui|sex|sab)\b/g));
  const weekdayMatch = weekdayMatches.at(-1);
  if (weekdayMatch) {
    const weekdayToken = weekdayMatch[1].split('-')[0];
    const targetWeekday = APPOINTMENT_WEEKDAYS[weekdayToken];
    const todayWeekday = new Date(`${today}T12:00:00.000Z`).getUTCDay();
    let offset = (targetWeekday - todayWeekday + 7) % 7;
    if (offset === 0 && !/\bhoje\b/i.test(current)) offset = 7;
    return addDaysToDateKey(today, offset);
  }

  return '';
}

export function appointmentTimePreference(text = '') {
  const current = normalizeText(text).replace(/\s+/g, ' ').trim();
  if (!current) return '';

  const explicit = current.match(/\b([01]?\d|2[0-3])(?::([0-5]\d)|h([0-5]\d)?)\b/)
    || current.match(/\b(?:as|para|por volta das)\s+([01]?\d|2[0-3])(?:\s*horas?)?\b/);
  const short = current.match(/^([01]?\d|2[0-3])\s*[.!?]*$/);
  const match = explicit || short;
  if (match) {
    const hour = String(Number(match[1])).padStart(2, '0');
    const minute = match[2] || match[3] || '00';
    return `${hour}:${minute}`;
  }

  const wordTimePattern = new RegExp(
    `(?:^|\\b(?:as|para|por volta das)\\s+)(${PT_NUMBER_PATTERN})(?:\\s*(?:h|horas?))?(?:\\s+e\\s+(meia|${PT_NUMBER_PATTERN}))?[.!?]*$`,
  );
  const wordTime = current.match(wordTimePattern);
  if (!wordTime) return '';
  const hour = parsePortugueseNumber(wordTime[1], 23);
  const minute = wordTime[2] === 'meia' ? 30 : parsePortugueseNumber(wordTime[2] || 'zero', 59);
  if (hour === null || minute === null) return '';
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function appointmentOptionsRejected(text = '') {
  const current = normalizeText(text).replace(/\s+/g, ' ').trim();
  if (!current) return false;
  if (/\bnao daria para (?:fazer|ser|marcar|agendar)\b/i.test(current)) return false;
  const lastSegment = current.split(/[,;]/).at(-1)?.trim() || '';
  const positivePreferenceInLastSegment = !/\b(nao|nem|indisponivel)\b/i.test(lastSegment)
    && Boolean(
      appointmentDatePreference(lastSegment)
      || appointmentTimePreference(lastSegment)
      || appointmentPeriodPreference(lastSegment),
    );
  const alternativeSegment = current.split(/\b(?:mas|porem|prefiro|consigo|pode ser)\b/i).at(-1)?.trim() || '';
  const hasParsedAlternative = alternativeSegment !== current
    && !/\b(nao|nem|indisponivel)\b/i.test(alternativeSegment)
    && Boolean(
      appointmentDatePreference(alternativeSegment)
      || appointmentTimePreference(alternativeSegment)
      || appointmentPeriodPreference(alternativeSegment),
    );
  const hasPositiveAlternative = /\b(mas|porem|entao|pode ser|prefiro|consigo)\b.{0,35}\b(hoje|amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo|dia\s+\d{1,2}|manha|tarde|noite|\d{1,2}(?::\d{2}|h))\b/i.test(current)
    || /\b(hoje|amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo|dia\s+\d{1,2}|manha|tarde|noite|\d{1,2}(?::\d{2}|h))\b.{0,20}\b(pode|serve|funciona)\b/i.test(current)
    || /\b(mas|porem|prefiro|consigo|pode ser)\b.{0,45}\b(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b.{0,20}\b(pode|serve|funciona)\b/i.test(current)
    || positivePreferenceInLastSegment
    || hasParsedAlternative;
  if (hasPositiveAlternative) return false;
  return /\b(outro dia|outra data|outro horario|esses horarios nao|nenhum desses|nao consigo|nao posso|nao da para mim|esse dia nao|essa data nao|esse horario nao|amanha nao da|nao serve)\b/i.test(current);
}

function appointmentCancelled(text = '') {
  const current = normalizeText(text).trim();
  return /\b(nao quero|desisti|deixa|deixe|esquece|cancela)\b.{0,30}\b(agendar|agenda|agendamento|marcar|reuniao|demonstracao|demo|isso|pra la)\b/i.test(current)
    || /^(deixa pra la|esquece|cancela|nao quero mais)[.!?]*$/i.test(current);
}

function appointmentFrustrationDetected(text = '') {
  return /\b(pessimo|horrivel|maldit[oa]|nao entende|nao esta entendendo|atendimento ruim|que dificuldade|ja falei|pela amor)\b/i
    .test(normalizeText(text));
}

function slotMatchesAppointmentPeriod(time, period = '') {
  if (!period) return true;
  const minute = timeMinutes(time);
  if (minute === null) return false;
  if (period === 'morning') return minute >= 6 * 60 && minute < 12 * 60;
  if (period === 'afternoon') return minute >= 12 * 60 && minute < 18 * 60;
  if (period === 'night') return minute >= 18 * 60;
  return true;
}

async function findAvailableAppointmentSlots({
  zpro,
  policy,
  from = new Date(),
  limit = 3,
  period = '',
  dateKey = '',
  excludedDateKeys = [],
}) {
  const availabilityFloor = new Date(Date.now() + policy.advance_notice_minutes * 60 * 1000);
  const minimumStart = from > availabilityFloor ? from : availabilityFloor;
  const firstDateKey = dateKey || localDateKey(minimumStart, policy.timezone);
  const windowEnd = zonedDateTimeToUtc(
    dateKey ? firstDateKey : addDaysToDateKey(firstDateKey, policy.horizon_days),
    '23:59',
    policy.timezone,
  );
  const { periods } = await loadBusyAppointments(zpro, minimumStart, windowEnd);
  const slots = [];
  const stepMinutes = Math.max(15, policy.duration_minutes + policy.buffer_minutes);

  const lastOffset = dateKey ? 0 : policy.horizon_days;
  const excluded = new Set(excludedDateKeys.map(String));
  for (let offset = 0; offset <= lastOffset && slots.length < limit; offset += 1) {
    const dateKey = addDaysToDateKey(firstDateKey, offset);
    if (excluded.has(dateKey)) continue;
    const day = new Date(`${dateKey}T12:00:00.000Z`).getUTCDay();
    for (const [fromTime, toTime] of policy.business_hours[day] || []) {
      const fromMinute = timeMinutes(fromTime);
      const toMinute = timeMinutes(toTime);
      for (let minute = fromMinute; minute + policy.duration_minutes <= toMinute; minute += stepMinutes) {
        const hour = String(Math.floor(minute / 60)).padStart(2, '0');
        const minuteText = String(minute % 60).padStart(2, '0');
        if (!slotMatchesAppointmentPeriod(`${hour}:${minuteText}`, period)) continue;
        const start = zonedDateTimeToUtc(dateKey, `${hour}:${minuteText}`, policy.timezone);
        const end = new Date(start.getTime() + policy.duration_minutes * 60 * 1000);
        if (start < minimumStart) continue;
        if (!slotIsFree(start, end, periods, policy.buffer_minutes)) continue;
        slots.push({ start, end, dateKey, time: `${hour}:${minuteText}` });
        if (slots.length >= limit) break;
      }
      if (slots.length >= limit) break;
    }
  }

  return slots;
}

function isAppointmentRoutingRule(rule = null) {
  if (!rule) return false;
  return /\b(reuniao|agendamento|agendada|agendado|demonstracao|demo|consulta)\b/i.test(normalizeText([
    rule.stage_name,
    rule.pipeline_name,
    rule.routing_instruction,
  ].join(' ')));
}

function findAppointmentRule(decision = {}, routingRules = []) {
  const exact = findRoutingRule(decision, routingRules);
  if (exact && isAppointmentRoutingRule(exact)) return exact;

  return routingRules.find(isAppointmentRoutingRule) || null;
}

function appointmentOptionsFromContext(context = []) {
  const pending = pendingAppointmentDecisionFromContext(context);
  return Array.isArray(pending?.appointment_options) ? pending.appointment_options : [];
}

function appointmentPeriodLabel(period = '') {
  if (period === 'morning') return 'da manha';
  if (period === 'afternoon') return 'da tarde';
  if (period === 'night') return 'da noite';
  return '';
}

async function appointmentEscalationResult({
  decision,
  agent,
  actions,
  routingRules,
  reason,
  reply = 'Desculpe pela dificuldade para encontrar um horário. Vou encaminhar você para nossa equipe concluir o agendamento.',
}) {
  const appointmentRule = findAppointmentRule(decision, routingRules);
  const transferAllowed = canExecuteAction(actions, 'transfer_ticket');
  const targetUserId = transferAllowed ? await selectRuleUser(appointmentRule) : '';
  const routedDecision = appointmentRule
    ? applyRoutingRuleToDecision({
      ...decision,
      action: transferAllowed ? 'handoff' : 'reply',
      reply,
      appointment_intent: false,
      appointment_confirmed: false,
    }, appointmentRule, agent)
    : {
      ...decision,
      action: transferAllowed ? 'handoff' : 'reply',
      reply: transferAllowed
        ? reply
        : 'Nao consegui concluir o agendamento automaticamente. Nossa equipe precisara finalizar esse horario com voce.',
      appointment_intent: false,
      appointment_confirmed: false,
    };

  return {
    decision: {
      ...routedDecision,
      action: transferAllowed ? 'handoff' : 'reply',
      user_id: targetUserId || '',
      reason,
      appointment_intent: false,
      appointment_confirmed: false,
      appointment_escalation: true,
      appointment_options: [],
    },
    rule: appointmentRule,
    appointment: { status: transferAllowed ? 'escalated' : 'needs_human' },
  };
}

export function appointmentWithoutAutomationDecision({
  decision = {},
  routingRules = [],
  agent = {},
  integration = {},
  actions = [],
} = {}) {
  const appointmentRule = findAppointmentRule(decision, routingRules);
  const transferAllowed = canExecuteAction(actions, 'transfer_ticket');
  const baseDecision = {
    ...decision,
    action: transferAllowed ? 'handoff' : 'reply',
    appointment_intent: false,
    appointment_confirmed: false,
    appointment_options: [],
    reason: decision.reason || 'Pedido de agendamento deve ser tratado pela equipe humana',
  };

  if (appointmentRule) {
    const routed = applyRoutingRuleToDecision(baseDecision, appointmentRule, agent);
    return {
      decision: {
        ...routed,
        action: transferAllowed ? routed.action : 'reply',
        reply: appointmentRule.handoff_message
          || decision.route_reply
          || (transferAllowed ? defaultHandoffMessage(agent) : decision.reply || defaultHandoffMessage(agent)),
      },
      rule: appointmentRule,
      appointment: { status: transferAllowed ? 'routed_to_human' : 'automation_disabled' },
    };
  }

  return {
    decision: {
      ...baseDecision,
      pipeline_id: decision.pipeline_id || '',
      stage_id: decision.stage_id || '',
      queue_id: decision.queue_id || integration.sales_queue_id || '',
      user_id: decision.user_id || '',
      reply: decision.route_reply
        || (transferAllowed
          ? defaultHandoffMessage(agent)
          : 'Nossa equipe precisara concluir esse agendamento com voce.'),
    },
    rule: null,
    appointment: { status: transferAllowed ? 'routed_to_human' : 'automation_disabled' },
  };
}

export function humanHandoffDecisionForRequest({
  agent = {},
  integration = {},
  routingRules = [],
  parsed = {},
  context = [],
} = {}) {
  const appointmentRequested = appointmentIntentDetected({ parsed, context });
  const appointmentRule = appointmentRequested ? findAppointmentRule({}, routingRules) : null;
  const baseDecision = {
    reply: appointmentRule?.handoff_message || defaultHandoffMessage(agent),
    action: 'handoff',
    pipeline_id: '',
    stage_id: '',
    queue_id: integration.sales_queue_id || '',
    user_id: '',
    appointment_intent: false,
    appointment_confirmed: false,
    appointment_options: [],
    reason: appointmentRule
      ? 'Cliente pediu atendimento humano para realizar um agendamento'
      : 'Cliente pediu atendimento humano ou assunto sensivel',
    confidence: 1,
  };

  return {
    decision: appointmentRule
      ? applyRoutingRuleToDecision(baseDecision, appointmentRule, agent)
      : baseDecision,
    rule: appointmentRule,
  };
}

async function applyAppointmentWorkflow({ zpro, agent, actions, parsed, lead, decision, routingRules, context = [] }) {
  if (!decision?.appointment_intent) return { decision, rule: null, appointment: null };

  const policy = normalizedSchedulePolicy(agent.settings?.schedule_policy);
  if (!policy.enabled || !canExecuteAction(actions, 'schedule_appointment')) {
    return appointmentWithoutAutomationDecision({ decision, routingRules, agent, actions });
  }

  const previous = pendingAppointmentDecisionFromContext(context) || {};
  const previousOptions = appointmentOptionsFromContext(context);
  const turnCount = Number(previous.appointment_turn_count || 0) + 1;
  let failureCount = Number(previous.appointment_failure_count || 0);
  const rejectedDates = new Set(
    Array.isArray(previous.appointment_rejected_dates)
      ? previous.appointment_rejected_dates.map(String)
      : [],
  );
  const selectedOption = selectedAppointmentOptionFromContext(context, parsed.text);
  const currentDate = selectedOption?.date || appointmentDatePreference(parsed.text, {
    timeZone: policy.timezone,
    horizonDays: policy.horizon_days,
  });
  const currentTime = selectedOption?.time || appointmentTimePreference(parsed.text);
  const currentPeriod = appointmentPeriodPreference(parsed.text);

  if (appointmentCancelled(parsed.text)) {
    return {
      decision: {
        ...decision,
        action: 'reply',
        pipeline_id: '',
        stage_id: '',
        queue_id: '',
        user_id: '',
        reply: 'Tudo bem, não vou agendar. Posso ajudar em outro ponto?',
        reason: 'Cliente cancelou somente o fluxo de agendamento',
        appointment_intent: false,
        appointment_cancelled: true,
        appointment_confirmed: false,
        appointment_options: [],
      },
      rule: null,
      appointment: { status: 'cancelled' },
    };
  }

  if (appointmentFrustrationDetected(parsed.text) || turnCount > 8) {
    return appointmentEscalationResult({
      decision: { ...decision, appointment_turn_count: turnCount },
      agent,
      actions,
      routingRules,
      reason: appointmentFrustrationDetected(parsed.text)
        ? 'Cliente demonstrou frustracao durante o agendamento'
        : 'Limite de interacoes do agendamento atingido',
    });
  }

  if (appointmentOptionsRejected(parsed.text)) {
    for (const option of previousOptions) {
      if (option?.date) rejectedDates.add(String(option.date));
    }
    if (currentDate) rejectedDates.add(currentDate);
    failureCount += 1;
    if (failureCount >= 3) {
      return appointmentEscalationResult({
        decision: {
          ...decision,
          appointment_turn_count: turnCount,
          appointment_failure_count: failureCount,
          appointment_rejected_dates: Array.from(rejectedDates),
        },
        agent,
        actions,
        routingRules,
        reason: 'Tres tentativas de agenda recusadas ou sem disponibilidade',
      });
    }
    return {
      decision: {
        ...decision,
        action: 'reply',
        pipeline_id: '',
        stage_id: '',
        queue_id: '',
        user_id: '',
        reply: 'Tudo bem. Qual outro dia funciona melhor para você?',
        reason: 'Cliente recusou as opcoes de data ou horario anteriores',
        appointment_confirmed: false,
        appointment_options: [],
        appointment_preferred_date: '',
        appointment_preferred_time: '',
        appointment_preferred_period: currentPeriod || previous.appointment_preferred_period || '',
        appointment_rejected_dates: Array.from(rejectedDates),
        appointment_turn_count: turnCount,
        appointment_failure_count: failureCount,
      },
      rule: null,
      appointment: { status: 'collecting_date' },
    };
  }

  let dateKey = String(currentDate || decision.appointment_date || previous.appointment_preferred_date || '').trim();
  let time = String(currentTime || decision.appointment_time || previous.appointment_preferred_time || '').trim();
  const period = currentPeriod || previous.appointment_preferred_period || '';
  if (currentDate && currentDate !== previous.appointment_preferred_date && !currentTime) time = '';
  if (!dateKeyInsideScheduleHorizon(dateKey, new Date(), policy.timezone, policy.horizon_days)) dateKey = '';
  if (!validTime(time)) time = '';
  const hasExactSlot = Boolean(dateKey && time);
  const customerSelectedExactSlot = Boolean(
    decision.appointment_confirmed
    || (currentTime && dateKey)
    || selectedOption,
  );

  const baseState = {
    appointment_preferred_date: dateKey,
    appointment_preferred_time: time,
    appointment_preferred_period: period,
    appointment_rejected_dates: Array.from(rejectedDates),
    appointment_turn_count: turnCount,
    appointment_failure_count: failureCount,
  };

  if (!customerSelectedExactSlot || !hasExactSlot) {
    const isStatusFollowup = /^(ok|certo|beleza|blz|conseguiu|conferiu|verificou|e ai|e agora|pode ser|nao entendi)$/i
      .test(normalizeText(parsed.text || '').trim());
    const hasNewPreference = Boolean(currentDate || currentTime || currentPeriod);
    if (!hasNewPreference && previousOptions.length > 0) {
      const labels = previousOptions.map((option) => option.label).filter(Boolean);
      const replyPrefix = isStatusFollowup
        ? 'Os horários abaixo continuam disponíveis.'
        : 'Você pode escolher uma opção abaixo ou me dizer outro dia.';
      return {
        decision: {
          ...decision,
          ...baseState,
          action: 'reply',
          pipeline_id: '',
          stage_id: '',
          queue_id: '',
          user_id: '',
          appointment_confirmed: false,
          appointment_options: previousOptions,
          reply: `${replyPrefix}\n\n${appointmentOptionsReply(previousOptions, period)}`,
          reason: 'Aguardando o cliente escolher uma opcao ja validada',
        },
        rule: null,
        appointment: { status: 'collecting', options: labels },
      };
    }

    const requestedDateStart = dateKey ? zonedDateTimeToUtc(dateKey, '00:00', policy.timezone) : null;
    let slots = await findAvailableAppointmentSlots({
      zpro,
      policy,
      from: requestedDateStart || new Date(),
      period,
      dateKey,
      excludedDateKeys: Array.from(rejectedDates),
    });
    let usedAlternativePeriod = false;
    if (slots.length === 0 && dateKey && period) {
      slots = await findAvailableAppointmentSlots({
        zpro,
        policy,
        from: requestedDateStart || new Date(),
        dateKey,
        excludedDateKeys: Array.from(rejectedDates),
      });
      usedAlternativePeriod = slots.length > 0;
    }
    const appointmentOptions = slots.map((slot) => ({
      date: slot.dateKey,
      time: slot.time,
      start_at: slot.start.toISOString(),
      end_at: slot.end.toISOString(),
      label: formatAppointmentSlot(slot.start, policy.timezone),
    }));
    const options = appointmentOptions.map((option) => option.label);

    if (options.length === 0) {
      failureCount += 1;
      if (dateKey) rejectedDates.add(dateKey);
      if (failureCount >= 3) {
        return appointmentEscalationResult({
          decision: {
            ...decision,
            ...baseState,
            appointment_failure_count: failureCount,
            appointment_rejected_dates: Array.from(rejectedDates),
          },
          agent,
          actions,
          routingRules,
          reason: 'Agenda sem disponibilidade apos tres tentativas',
        });
      }
    }

    return {
      decision: {
        ...decision,
        ...baseState,
        action: 'reply',
        pipeline_id: '',
        stage_id: '',
        queue_id: '',
        user_id: '',
        appointment_confirmed: false,
        appointment_options: appointmentOptions,
        appointment_failure_count: failureCount,
        appointment_rejected_dates: Array.from(rejectedDates),
        appointment_preferred_date: options.length > 0 ? dateKey : '',
        reply: options.length > 0
          ? `${usedAlternativePeriod ? `Não encontrei horários ${appointmentPeriodLabel(period)} nessa data, mas tenho estas opções:\n\n` : ''}${appointmentOptionsReply(appointmentOptions, usedAlternativePeriod ? '' : period)}`
          : `Não encontrei horário livre${dateKey ? ' nessa data' : ''}${period ? ` ${appointmentPeriodLabel(period)}` : ''}. Qual outro dia ou período funciona para você?`,
        reason: options.length > 0
          ? 'Opcoes consultadas e validadas no Z-PRO'
          : 'Data ou periodo sem disponibilidade',
      },
      rule: null,
      appointment: { status: options.length > 0 ? 'collecting' : 'no_availability', options },
    };
  }

  const start = zonedDateTimeToUtc(dateKey, time, policy.timezone);
  const end = start ? new Date(start.getTime() + policy.duration_minutes * 60 * 1000) : null;
  const minimumStart = new Date(Date.now() + policy.advance_notice_minutes * 60 * 1000);
  const insideHours = start && end && slotInsideBusinessHours(dateKey, time, policy.duration_minutes, policy);

  let created = null;
  if (start && end && start >= minimumStart && insideHours) {
    created = await withAppointmentSchedulingLock(async () => {
      const dayStart = zonedDateTimeToUtc(dateKey, '00:00', policy.timezone);
      const dayEnd = zonedDateTimeToUtc(dateKey, '23:59', policy.timezone);
      const { periods } = await loadBusyAppointments(zpro, dayStart, dayEnd);
      if (!slotIsFree(start, end, periods, policy.buffer_minutes)) return null;

      const title = decision.appointment_title || `Reuniao com ${lead.name || parsed.name || lead.phone || parsed.phone}`;
      const response = await zpro.createAppointment({
        title,
        description: decision.reason || 'Agendamento criado pela Central IA CRM.',
        contactId: parsed.contactId || lead.external_contact_id,
        contactName: lead.name || parsed.name || lead.phone || parsed.phone,
        contactPhone: lead.phone || parsed.phone,
        whatsappId: parsed.whatsappId || parsed.channelId,
        startAt: start.toISOString(),
        endAt: end.toISOString(),
        status: 'confirmed',
        notes: `Criado automaticamente pelo agente ${agent.name || agent.id}. Ticket ${parsed.ticketId || 'nao informado'}.`,
      });
      return { response, title };
    });
  }

  if (!created) {
    let slots = await findAvailableAppointmentSlots({
      zpro,
      policy,
      from: start && start > new Date() ? start : new Date(),
      dateKey,
      excludedDateKeys: Array.from(rejectedDates),
    });
    if (slots.length === 0) {
      failureCount += 1;
      rejectedDates.add(dateKey);
      if (failureCount >= 3) {
        return appointmentEscalationResult({
          decision: {
            ...decision,
            ...baseState,
            appointment_failure_count: failureCount,
            appointment_rejected_dates: Array.from(rejectedDates),
          },
          agent,
          actions,
          routingRules,
          reason: 'Horario em conflito apos tres tentativas',
        });
      }
      slots = [];
    }
    const appointmentOptions = slots.map((slot) => ({
      date: slot.dateKey,
      time: slot.time,
      start_at: slot.start.toISOString(),
      end_at: slot.end.toISOString(),
      label: formatAppointmentSlot(slot.start, policy.timezone),
    }));
    const options = appointmentOptions.map((option) => option.label);
    return {
      decision: {
        ...decision,
        action: 'reply',
        pipeline_id: '',
        stage_id: '',
        queue_id: '',
        user_id: '',
        appointment_confirmed: false,
        appointment_options: appointmentOptions,
        appointment_preferred_date: options.length > 0 ? dateKey : '',
        appointment_preferred_time: '',
        appointment_preferred_period: period,
        appointment_rejected_dates: Array.from(rejectedDates),
        appointment_turn_count: turnCount,
        appointment_failure_count: failureCount,
        reply: options.length > 0
          ? `Esse horário não está disponível.\n\n${appointmentOptionsReply(appointmentOptions)}`
          : 'Esse horário não está disponível nessa data. Qual outro dia ou período funciona para você?',
        reason: 'Horario fora da agenda, com pouca antecedencia ou em conflito',
      },
      rule: null,
      appointment: { status: 'conflict', options },
    };
  }

  const { response: appointmentResponse, title } = created;
  const rule = findAppointmentRule(decision, routingRules);
  const confirmation = `Perfeito, ${lead.name || parsed.name || 'tudo certo'}. Seu agendamento foi confirmado para ${formatAppointmentSlot(start, policy.timezone)}.`;
  const shouldHandoff = Boolean(
    rule
    && (
      rule.stop_ai_after_match === true
      || rule.external_queue_id
      || ruleUserIds(rule).length > 0
    )
  );
  const handoffText = shouldHandoff ? rule.handoff_message || defaultHandoffMessage(agent) : '';

  return {
    decision: {
      ...decision,
      action: shouldHandoff ? 'handoff' : rule ? 'move_stage' : 'reply',
      pipeline_id: rule?.external_pipeline_id || '',
      stage_id: rule?.external_stage_id || '',
      queue_id: rule?.external_queue_id || '',
      user_id: '',
      reply: [confirmation, handoffText].filter(Boolean).join(' '),
      reason: `Compromisso criado no Z-PRO: ${decision.reason || title}`,
      appointment_created: true,
      appointment_start_at: start.toISOString(),
      appointment_end_at: end.toISOString(),
      appointment_endpoint: appointmentResponse.endpoint,
      appointment_options: [],
      appointment_preferred_date: dateKey,
      appointment_preferred_time: time,
      appointment_preferred_period: period,
      appointment_rejected_dates: Array.from(rejectedDates),
      appointment_turn_count: turnCount,
      appointment_failure_count: failureCount,
    },
    rule,
    appointment: {
      status: 'created',
      endpoint: appointmentResponse.endpoint,
      data: sanitizeObject(appointmentResponse.data),
      start_at: start.toISOString(),
      end_at: end.toISOString(),
    },
  };
}

function getMessageType(message = {}, payload = {}) {
  const explicit = pickFirst(
    payload.messageType,
    payload.type,
    payload.mediaType,
    payload.msg?.messageType,
    payload.msg?.type,
    payload.msg?.mediaType,
  );

  if (explicit) return String(explicit);

  const knownTypes = [
    'audioMessage',
    'conversation',
    'extendedTextMessage',
    'imageMessage',
    'videoMessage',
    'documentMessage',
    'stickerMessage',
    'locationMessage',
    'contactMessage',
  ];

  return knownTypes.find((key) => message?.[key]) || 'unknown';
}

function detectAudioMessage(message = {}, payload = {}) {
  const messageType = normalizeText(getMessageType(message, payload));
  return Boolean(
    message?.audioMessage ||
    message?.pttMessage ||
    messageType.includes('audio') ||
    messageType.includes('ptt') ||
    messageType.includes('voice')
  );
}

function getTagNames(contact = {}) {
  const tags = Array.isArray(contact.tags) ? contact.tags : [];
  return tags
    .map((tag) => pickFirst(tag.name, tag.tag, tag.label, tag.title, tag))
    .filter(Boolean)
    .map(String);
}

function classifyContactType({ text, contact }) {
  const tagText = normalizeText(getTagNames(contact).join(' '));
  const searchableText = normalizeText(`${tagText} ${text}`);

  if (
    /\b(cliente|pos venda|pos-venda|suporte|financeiro|boleto|pagamento|mensalidade|regularizar|regularizacao|mais informacoes|segunda via|remarcar|agendamento|consulta|cancelamento)\b/.test(searchableText)
  ) {
    return 'customer';
  }

  if (
    /\b(comprar|contratar|preco|preco|valor|orcamento|plano|promocao|promo|quero saber|tenho interesse|interesse)\b/.test(searchableText)
  ) {
    return 'lead';
  }

  return 'unknown';
}

export function normalizePayload(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body;
  }

  const raw = Buffer.isBuffer(req.body)
    ? req.body.toString('utf8')
    : String(req.body || req.rawBody || '');

  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    return { body: raw };
  }
}

function officialInteractiveText(msg = {}, payload = {}) {
  const interactive = msg.interactive || payload.interactive || {};
  const buttonReply = interactive.button_reply || interactive.buttonReply || {};
  const listReply = interactive.list_reply || interactive.listReply || {};
  const nativeButton = msg.button || payload.button || {};
  const buttonsResponse = msg.buttonsResponseMessage || payload.buttonsResponseMessage || {};
  const listResponse = msg.listResponseMessage || payload.listResponseMessage || {};

  return pickFirstText(
    nativeButton.text,
    nativeButton.payload,
    buttonReply.title,
    buttonReply.id,
    listReply.title,
    listReply.description,
    listReply.id,
    buttonsResponse.selectedDisplayText,
    buttonsResponse.selectedButtonId,
    listResponse.title,
    listResponse.description,
    listResponse.singleSelectReply?.selectedRowId,
  );
}

function isOutboundWebhookMethod(method = '') {
  return /^message[_-](?:sent|send)(?:[_-]|$)/i.test(String(method || ''));
}

export function extractPayload(payload = {}) {
  const msg = payload.msg || {};
  const key = msg.key || {};
  const ticket = payload.ticket || msg.ticket || {};
  const contact = ticket.contact || msg.contact || payload.contact || {};
  const message = msg.message && typeof msg.message === 'object'
    ? msg.message
    : payload.message && typeof payload.message === 'object'
      ? payload.message
      : {};
  const method = String(payload.method || payload.event || payload.type || 'message');
  const messageType = getMessageType(message, payload);

  const messageText = pickFirstText(
    typeof payload.body === 'string' ? payload.body : '',
    typeof payload.text === 'string' ? payload.text : '',
    typeof msg.body === 'string' ? msg.body : '',
    typeof msg.text === 'string' ? msg.text : '',
    msg.text?.body,
    officialInteractiveText(msg, payload),
    message.conversation,
    message?.extendedTextMessage?.text,
    message?.imageMessage?.caption,
    message?.videoMessage?.caption,
  );
  const text = messageText;
  const hasMessageContent = Boolean(messageText || detectAudioMessage(message, payload)
    || msg.mediaUrl || msg.audio || msg.image || msg.video || msg.document || msg.sticker
    || msg.location || msg.contacts || message.imageMessage || message.videoMessage
    || message.documentMessage || message.stickerMessage || message.locationMessage || message.contactMessage);

  const phone = onlyDigits(
    contact.number ||
    key.sender_pn ||
    msg.sender_pn ||
    msg.from ||
    msg.phone ||
    payload.number ||
    payload.phone ||
    ''
  );

  const fromMe = Boolean(
    key.fromMe === true ||
    msg.fromMe === true ||
    payload.fromMe === true ||
    isOutboundWebhookMethod(method)
  );

  const eventTimestamp = pickFirst(
    msg.messageTimestamp,
    msg.timestamp,
    payload.messageTimestamp,
    payload.timestamp,
    ticket.lastMessageAt,
    ticket.updatedAt,
  );
  const ticketId = pickFirst(ticket.id, msg.ticketId, payload.ticketId);
  const eventId = String(
    key.id ||
    msg.id ||
    msg.messageId ||
    msg.wamid ||
    payload.id ||
    payload.eventId ||
    `${ticketId || phone || 'unknown'}-${eventTimestamp || 'no-time'}-${messageType}-${normalizeText(text).slice(0, 120) || 'no-text'}`
  );

  return {
    method,
    hasMessageContent,
    isStatusEvent: Boolean(payload.statuses || msg.statuses || (
      /(?:^|[_.-])(status|ack|receipt|read|delivered|update|updated|delete|deleted)(?:$|[_.-])/i.test(method)
    )),
    eventId,
    fromMe,
    isGroup: Boolean(
      ticket.isGroup === true
      || contact.isGroup === true
      || String(key.remoteJid || '').endsWith('@g.us')
    ),
    text,
    phone,
    name: contact.name || contact.pushname || msg.pushName || msg.pushname || '',
    contactId: pickFirst(contact.id, msg.contactId, payload.contactId)
      ? String(pickFirst(contact.id, msg.contactId, payload.contactId))
      : null,
    ticketId: ticketId ? String(ticketId) : null,
    ticketProtocol: ticket.protocol ? String(ticket.protocol) : null,
    ticketStatus: ticket.status ? String(ticket.status) : null,
    whatsappId: pickFirst(ticket.whatsappId, msg.whatsappId, payload.whatsappId)
      ? String(pickFirst(ticket.whatsappId, msg.whatsappId, payload.whatsappId))
      : null,
    channelId: pickFirst(ticket.channelId, ticket.whatsappId, msg.channelId, msg.whatsappId, payload.channelId, payload.whatsappId)
      ? String(pickFirst(ticket.channelId, ticket.whatsappId, msg.channelId, msg.whatsappId, payload.channelId, payload.whatsappId))
      : null,
    whatsappName: ticket?.whatsapp?.name || '',
    channelName: ticket?.whatsapp?.name || ticket.channel || '',
    channelType: ticket.channel || ticket?.whatsapp?.type || '',
    queueId: ticket.queueId ? String(ticket.queueId) : null,
    assignedExternalUserId: ticket.userId ? String(ticket.userId) : null,
    assignedExternalUserName: ticket?.user?.name || '',
    messageType,
    isAudio: detectAudioMessage(message, payload),
    contactType: classifyContactType({ text, contact }),
    messageAt: parseTimestamp(eventTimestamp),
    ticketCreatedAt: parseTimestamp(ticket.createdAt),
    ticketUpdatedAt: parseTimestamp(ticket.updatedAt),
    rawTenantId: ticket.tenantId ? String(ticket.tenantId) : null,
  };
}

export function isOfficialWhatsAppChannel(parsed = {}) {
  const channel = normalizeText([
    parsed.channelType,
    parsed.channelName,
    parsed.whatsappName,
  ].filter(Boolean).join(' '));
  return /\b(waba|cloud api|api oficial|whatsapp oficial)\b/.test(channel);
}

export function webhookIgnoreReason(parsed) {
  if (parsed.fromMe) return 'Mensagem enviada pelo sistema';
  if (parsed.isGroup) return 'Mensagem de grupo';
  if (!parsed.phone) return 'Payload sem telefone';
  if (parsed.isStatusEvent || !parsed.hasMessageContent) {
    return isOfficialWhatsAppChannel(parsed) ? 'Evento WABA sem nova mensagem do cliente' : 'Evento sem nova mensagem do cliente';
  }
  return null;
}

function getAgentChannelId(agent = {}) {
  return pickFirst(
    agent.settings?.channel_id,
    agent.settings?.whatsapp_id,
    agent.settings?.channel?.id,
    agent.settings?.whatsapp?.id,
  );
}

function agentMatchesChannel(agent = {}, parsed = {}) {
  const expectedId = normalizeId(getAgentChannelId(agent));
  if (!expectedId) return false;

  const actualIds = [
    parsed.whatsappId,
    parsed.channelId,
    parsed.channelName,
    parsed.whatsappName,
  ].map(normalizeId);

  return actualIds.includes(expectedId);
}

export function selectAgentForChannel(agents = [], integrationId, parsed = {}) {
  if (agents.length === 0) {
    return { agent: null, ignored: false, reason: null };
  }

  const exactIntegrationAgents = agents.filter((agent) => (
    String(agent.settings?.integration_id || '') === String(integrationId || '')
  ));
  const legacyAgents = agents.filter((agent) => !agent.settings?.integration_id);
  const eligibleAgents = exactIntegrationAgents.length > 0 ? exactIntegrationAgents : legacyAgents;
  if (eligibleAgents.length === 0) {
    return {
      agent: null,
      ignored: true,
      reason: 'Nenhum agente ativo vinculado a esta integracao',
    };
  }

  const channelAgents = eligibleAgents.filter((agent) => getAgentChannelId(agent));
  const matchedAgent = channelAgents.find((agent) => agentMatchesChannel(agent, parsed));
  if (matchedAgent) {
    return { agent: matchedAgent, ignored: false, reason: null };
  }

  const allChannelsAgent = eligibleAgents.find((agent) => !getAgentChannelId(agent));
  if (allChannelsAgent) {
    return { agent: allChannelsAgent, ignored: false, reason: null };
  }

  if (channelAgents.length > 0) {
    return {
      agent: null,
      ignored: true,
      reason: 'Nenhum agente ativo configurado para este canal',
    };
  }
  return { agent: null, ignored: true, reason: 'Nenhum agente ativo configurado para este canal' };
}

async function resolveWebhookAgent(tenantId, integrationId, parsed = {}) {
  const { data, error } = await supabaseAdmin
    .from('crm_ai_agents')
    .select('id, name, enabled, settings, system_prompt, model, temperature, welcome_message, handoff_message, created_at')
    .eq('tenant_id', tenantId)
    .eq('enabled', true)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return selectAgentForChannel(data || [], integrationId, parsed);
}

async function createZproService(integration) {
  const { data: token, error } = await supabaseAdmin.rpc('crm_ai_service_get_zpro_token', {
    p_integration_id: integration.id,
  });

  if (error) throw error;

  return new ZproService({
    baseUrl: integration.base_url,
    token,
  });
}

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!openaiClient) openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openaiClient;
}

async function loadAgentActions(agentId) {
  if (!agentId) return [];

  const { data, error } = await supabaseAdmin
    .from('crm_ai_actions')
    .select('action_key, enabled, config')
    .eq('agent_id', agentId);

  if (error) throw error;
  return data || [];
}

function actionEnabled(actions = [], actionKey) {
  return actions.some((action) => action.action_key === actionKey && action.enabled === true);
}

function canExecuteAction(actions = [], actionKey) {
  if (!Array.isArray(actions) || actions.length === 0) return false;
  const matchingActions = actions.filter((action) => action.action_key === actionKey);
  if (matchingActions.length === 0) return false;
  return matchingActions.some((action) => action.enabled === true);
}

function leadStopStatusFor(reasonOrAction = '') {
  const value = normalizeId(reasonOrAction);
  return value.includes('closed') || value.includes('close') || value.includes('acknowledgement')
    ? 'archived'
    : 'transferred';
}

function contextTtlHours() {
  return Math.min(72, Math.max(1, Number(process.env.AI_CONTEXT_TTL_HOURS || 24)));
}

function contextExpiresAt() {
  return new Date(Date.now() + contextTtlHours() * 60 * 60 * 1000).toISOString();
}

async function purgeExpiredTicketContext(tenantId) {
  if (!ticketContextTableAvailable && Date.now() < ticketContextNextRetryAt) return;

  try {
    const { error } = await supabaseAdmin
      .from('crm_ai_ticket_context')
      .delete()
      .eq('tenant_id', tenantId)
      .lt('expires_at', new Date().toISOString());

    if (error) throw error;
    ticketContextTableAvailable = true;
    ticketContextNextRetryAt = 0;
  } catch (err) {
    ticketContextTableAvailable = false;
    ticketContextNextRetryAt = Date.now() + 10 * 60 * 1000;
    logWarn('zpro.webhook.context_purge_skipped', {
      tenantId,
      error: err.message || String(err),
    });
  }
}

async function rememberTicketContext({
  tenantId,
  integrationId,
  leadId,
  ticketId,
  role,
  content,
  eventType,
  externalEventId = null,
  metadata = {},
}) {
  const trimmed = String(content || '').trim();
  if (!trimmed) return;
  if (!ticketContextTableAvailable && Date.now() < ticketContextNextRetryAt) return;

  try {
    const { error } = await supabaseAdmin
      .from('crm_ai_ticket_context')
      .insert({
        tenant_id: tenantId,
        integration_id: integrationId,
        lead_id: leadId,
        external_ticket_id: ticketId || null,
        role,
        content: trimmed.slice(0, 4000),
        event_type: eventType,
        external_event_id: externalEventId,
        metadata,
        expires_at: contextExpiresAt(),
      });

    if (error) throw error;
    ticketContextTableAvailable = true;
    ticketContextNextRetryAt = 0;
  } catch (err) {
    ticketContextTableAvailable = false;
    ticketContextNextRetryAt = Date.now() + 10 * 60 * 1000;
    logWarn('zpro.webhook.context_insert_skipped', {
      tenantId,
      leadId,
      ticketId,
      error: err.message || String(err),
    });
  }
}

function eventToContextRow(event = {}) {
  const role = ['ai_response_sent', 'followup_sent'].includes(event.event_type) ? 'assistant' : 'user';
  return {
    role,
    content: event.summary || event.payload?.parsed?.text || '',
    created_at: event.created_at,
    event_type: event.event_type,
    metadata: event.payload || {},
  };
}

async function loadFallbackContext({ tenantId, leadId, ticketId }) {
  if (!ticketId) return [];
  const since = new Date(Date.now() - contextTtlHours() * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabaseAdmin
    .from('crm_ai_lead_events')
    .select('event_type, summary, payload, created_at')
    .eq('payload->parsed->>ticketId', String(ticketId))
    .eq('tenant_id', tenantId)
    .eq('lead_id', leadId)
    .in('event_type', ['message_received', 'audio_received', 'ai_response_sent', 'followup_sent'])
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(18);

  if (error) {
    logWarn('zpro.webhook.context_fallback_failed', {
      tenantId,
      leadId,
      error: error.message || String(error),
    });
    return [];
  }

  return (data || [])
    .map(eventToContextRow)
    .filter((row) => row.content)
    .reverse();
}

async function loadTicketContext({ tenantId, leadId, ticketId }) {
  if (!ticketContextTableAvailable && Date.now() < ticketContextNextRetryAt) {
    return loadFallbackContext({ tenantId, leadId, ticketId });
  }

  try {
    let query = supabaseAdmin
      .from('crm_ai_ticket_context')
      .select('role, content, event_type, created_at, metadata')
      .eq('tenant_id', tenantId)
      .eq('lead_id', leadId)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(18);

    if (ticketId) query = query.eq('external_ticket_id', ticketId);

    const { data, error } = await query;
    if (error) throw error;

    ticketContextTableAvailable = true;
    ticketContextNextRetryAt = 0;

    const rows = (data || []).reverse();
    return rows.length > 0 ? rows : loadFallbackContext({ tenantId, leadId, ticketId });
  } catch (err) {
    ticketContextTableAvailable = false;
    ticketContextNextRetryAt = Date.now() + 10 * 60 * 1000;
    logWarn('zpro.webhook.context_load_skipped', {
      tenantId,
      leadId,
      ticketId,
      error: err.message || String(err),
    });
    return loadFallbackContext({ tenantId, leadId, ticketId });
  }
}

function recentUserMessageCount(context = [], windowMinutes = 3) {
  const since = Date.now() - windowMinutes * 60 * 1000;
  return context.filter((row) => {
    if (row.role !== 'user') return false;
    const createdAt = new Date(row.created_at).getTime();
    return Number.isFinite(createdAt) && createdAt >= since;
  }).length;
}

function recentUserBurstCount(context = [], windowMinutes = 3) {
  const since = Date.now() - windowMinutes * 60 * 1000;
  let count = 0;

  for (const row of [...context].reverse()) {
    const createdAt = new Date(row.created_at).getTime();
    if (!Number.isFinite(createdAt) || createdAt < since) break;
    if (row.role === 'assistant') break;
    if (row.role === 'system' && /ai_response|ai_action/i.test(row.event_type || '')) break;
    if (row.role === 'user') count += 1;
  }

  return count;
}

function contextShowsAiHandoff(context = []) {
  return context.some((row) => {
    if (row.event_type !== 'ai_action_executed') return false;
    const action = normalizeId(row.metadata?.action || '');
    if (action === 'stop_ai') return row.metadata?.local_ai_stopped === true;
    if (!['handoff', 'close_ticket'].includes(action)) return false;
    return row.metadata?.ticket_verified === true;
  });
}

function isStopAction(action = '') {
  return ['handoff', 'close_ticket', 'stop_ai'].includes(normalizeId(action));
}

export function applyRoutingRuleToDecision(decision = {}, rule = null, agent = {}) {
  if (!rule) return decision;

  let action = normalizeId(decision.action);
  if (!['reply', 'handoff', 'move_stage', 'close_ticket', 'stop_ai', 'schedule_appointment'].includes(action)) {
    action = 'move_stage';
  }
  if (rule.close_ticket_on_match) {
    action = 'close_ticket';
  } else if (rule.stop_ai_after_match === true) {
    action = 'handoff';
  } else if (action === 'reply') {
    action = 'move_stage';
  }

  const shouldStop = isStopAction(action);

  return {
    ...decision,
    reply: shouldStop
      ? rule.handoff_message || decision.reply || defaultHandoffMessage(agent)
      : decision.reply || '',
    action,
    pipeline_id: rule.external_pipeline_id || decision.pipeline_id || '',
    stage_id: rule.external_stage_id || decision.stage_id || '',
    queue_id: rule.external_queue_id || decision.queue_id || '',
    reason: decision.reason || `Regra de etapa: ${rule.stage_name || rule.external_stage_id}`,
    confidence: Math.max(Number(decision.confidence || 0), 0.95),
  };
}

async function loadStageRoutingRules(integration) {
  const [rules, pipelines, stages, queues] = await Promise.all([
    supabaseAdmin
      .from('crm_ai_stage_assignment_rules')
      .select('*')
      .eq('tenant_id', integration.tenant_id)
      .eq('integration_id', integration.id)
      .eq('active', true),
    supabaseAdmin
      .from('crm_ai_zpro_pipelines_cache')
      .select('external_pipeline_id, name')
      .eq('tenant_id', integration.tenant_id)
      .eq('integration_id', integration.id),
    supabaseAdmin
      .from('crm_ai_zpro_stages_cache')
      .select('external_pipeline_id, external_stage_id, name, position')
      .eq('tenant_id', integration.tenant_id)
      .eq('integration_id', integration.id),
    supabaseAdmin
      .from('crm_ai_zpro_queues_cache')
      .select('external_queue_id, name')
      .eq('tenant_id', integration.tenant_id)
      .eq('integration_id', integration.id),
  ]);

  for (const result of [rules, pipelines, stages, queues]) {
    if (result.error) throw result.error;
  }

  const pipelineNameById = new Map((pipelines.data || []).map((item) => [item.external_pipeline_id, item.name]));
  const queueNameById = new Map((queues.data || []).map((item) => [item.external_queue_id, item.name]));
  const stageNameByKey = new Map(
    (stages.data || []).map((item) => [
      `${item.external_pipeline_id}:${item.external_stage_id}`,
      item.name,
    ]),
  );

  return (rules.data || [])
    .map((rule) => ({
      ...rule,
      pipeline_name: pipelineNameById.get(rule.external_pipeline_id) || rule.external_pipeline_id,
      stage_name: stageNameByKey.get(`${rule.external_pipeline_id}:${rule.external_stage_id}`) || rule.external_stage_id,
      queue_name: rule.external_queue_id ? queueNameById.get(rule.external_queue_id) || rule.external_queue_id : '',
    }))
    .filter((rule) => String(rule.routing_instruction || '').trim());
}

function routingRulesPrompt(rules = []) {
  if (rules.length === 0) return 'Nao ha regras de roteamento por etapa configuradas.';

  return rules.map((rule, index) => [
    `${index + 1}. Funil: ${rule.pipeline_name} (${rule.external_pipeline_id})`,
    `Etapa: ${rule.stage_name} (${rule.external_stage_id})`,
    rule.queue_name ? `Fila: ${rule.queue_name} (${rule.external_queue_id})` : 'Fila: nao definida',
    `Quando usar: ${rule.routing_instruction}`,
    rule.close_ticket_on_match
      ? 'Politica da regra: encerrar ticket quando a conversa pedir encerramento claro.'
      : rule.stop_ai_after_match
        ? 'Politica da regra: entrega humana obrigatoria. Ao combinar, transfira o ticket, pare a IA e mantenha funil, etapa, fila e responsavel sincronizados.'
        : 'Politica da regra: mover oportunidade para esta etapa e continuar a conversa.',
    rule.handoff_message ? `Mensagem sugerida: ${rule.handoff_message}` : '',
  ].filter(Boolean).join(' | ')).join('\n');
}

async function insertLeadEvent({ tenantId, leadId, eventType, externalEventId = null, summary = '', payload = {} }) {
  const { error } = await supabaseAdmin
    .from('crm_ai_lead_events')
    .insert({
      tenant_id: tenantId,
      lead_id: leadId,
      event_type: eventType,
      external_event_id: externalEventId,
      summary,
      payload,
    });

  if (error) {
    logWarn('zpro.webhook.lead_event_failed', {
      tenantId,
      leadId,
      eventType,
      error: error.message || String(error),
    });
  }
}

function shouldRunLiveAi(agent = null) {
  if (!agent?.enabled) return false;
  if (String(process.env.APP_MODE || 'live').toLowerCase() !== 'live') return false;
  if (agent.settings?.safe_mode === true) return false;
  return true;
}

function buildAiSystemPrompt(agent = {}, actions = [], routingRules = []) {
  const settings = agent.settings || {};
  const schedulePolicy = normalizedSchedulePolicy(settings.schedule_policy);
  const allowedActions = actions
    .filter((action) => action.enabled)
    .map((action) => action.action_key)
    .join(', ') || 'nenhuma';

  return [
    agent.system_prompt || 'Atenda leads do WhatsApp de forma objetiva e profissional.',
    settings.voice_tone ? `Tom de voz: ${settings.voice_tone}` : '',
    settings.allowed_actions_description ? `Pode fazer: ${settings.allowed_actions_description}` : '',
    settings.forbidden_actions_description ? `Nao pode fazer: ${settings.forbidden_actions_description}` : '',
    `Acoes habilitadas no sistema: ${allowedActions}.`,
    'Regras de roteamento por etapa:',
    routingRulesPrompt(routingRules),
    'Responda em portugues do Brasil.',
    'Seja breve, natural e util.',
    'Nao use emojis.',
    'Nao invente informacoes, valores, prazos ou promessas.',
    'Nao diga que e uma IA, a menos que o cliente pergunte diretamente.',
    'Use o historico da conversa para nao reiniciar o atendimento a cada mensagem.',
    'Diferencie rigorosamente Cliente e IA no historico. Uma pergunta, oferta ou sugestao escrita pela IA nao representa intencao do cliente.',
    'A mensagem atual do cliente tem prioridade. Responda ao que ele acabou de dizer sem repetir a ultima pergunta ou resposta.',
    'Nunca repita uma resposta ja enviada. Considere como fatos as respostas anteriores do cliente e nao pergunte novamente algo que ele ja informou.',
    'Se o cliente recusar, disser que nao quer continuar, se despedir ou pedir encerramento, respeite imediatamente. Nao tente reabrir a venda nem faca nova pergunta de qualificacao.',
    'Faca no maximo uma pergunta por resposta e so avance para agendamento quando o cliente demonstrar essa intencao.',
    'Quando houver regras de etapa, escolha pipeline_id, stage_id e queue_id somente entre os IDs listados nas regras. Nunca invente IDs.',
    'Se uma regra de etapa combinar com a necessidade do cliente, preencha os IDs exatos da regra.',
    'Use move_stage quando a oportunidade deve mudar de etapa, mas a IA ainda deve continuar qualificando ou explicando.',
    'Use handoff quando o cliente pedir humano, houver intencao clara de contratar/negociar, assunto sensivel ou a regra estiver marcada para entrega humana obrigatoria.',
    schedulePolicy.enabled && canExecuteAction(actions, 'schedule_appointment')
      ? 'Agendamento esta ativo. Preencha appointment_intent=true somente quando a mensagem atual do cliente pedir explicitamente para agendar/marcar ou responder a horarios que o sistema acabou de oferecer. Nao inicie agenda por interesse comercial generico, qualificacao, tamanho de base ou mencao de demonstracao feita apenas pela IA.'
      : 'Agendamento automatico esta desativado. Se o cliente pedir agenda e uma regra de etapa combinar, siga essa regra; nunca ofereca horarios nem diga que ajudara a escolher horario.',
    schedulePolicy.enabled && canExecuteAction(actions, 'schedule_appointment')
      ? 'Use schedule_appointment somente quando o historico tiver uma data e um horario inequivocos aceitos pelo cliente. Antes disso use reply, appointment_confirmed=false e deixe o backend oferecer horarios livres.'
      : '',
    schedulePolicy.enabled
      ? `Fuso da agenda: ${schedulePolicy.timezone}. Duracao padrao: ${schedulePolicy.duration_minutes} minutos. Intervalo minimo: ${schedulePolicy.buffer_minutes} minutos.`
      : '',
    'Se nenhuma regra combinar, deixe pipeline_id, stage_id, queue_id e user_id vazios.',
    'Se o cliente pedir humano, atendente, suporte humano, cancelamento, reclamacao ou financeiro, escolha uma acao de transferencia.',
    'Use close_ticket somente se o cliente pedir encerramento, disser que nao tem interesse, ou confirmar claramente que esta resolvido. Nunca encerre quando o cliente perguntou preco, como funciona, detalhes ou demonstrou interesse.',
    'Retorne exclusivamente um JSON valido conforme o schema solicitado.',
    'Valores aceitos em action: reply, handoff, move_stage, close_ticket, stop_ai, schedule_appointment.',
    'Para agenda, use appointment_date no formato YYYY-MM-DD e appointment_time no formato HH:mm. Nao invente data ou horario ausentes na conversa.',
    'Nunca escreva horarios livres por conta propria. A lista de disponibilidade e produzida somente pelo backend depois de um pedido explicito do cliente.',
    'Use strings vazias quando nao houver pipeline_id, stage_id, queue_id ou user_id.',
  ].filter(Boolean).join('\n');
}

function parseAiDecision(raw = '') {
  const text = String(raw || '').trim();
  if (!text) {
    return {
      reply: '',
      action: 'reply',
      pipeline_id: '',
      stage_id: '',
      queue_id: '',
      user_id: '',
      appointment_intent: false,
      appointment_confirmed: false,
      appointment_date: '',
      appointment_time: '',
      appointment_title: '',
      reason: 'Resposta vazia do modelo',
      confidence: 0,
    };
  }

  const cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    return {
      reply: String(parsed.reply || parsed.message || parsed.mensagem || '').trim(),
      action: String(parsed.action || parsed.acao || 'reply').trim() || 'reply',
      pipeline_id: String(parsed.pipeline_id || parsed.pipelineId || '').trim(),
      stage_id: String(parsed.stage_id || parsed.stageId || '').trim(),
      queue_id: String(parsed.queue_id || parsed.queueId || '').trim(),
      user_id: String(parsed.user_id || parsed.userId || '').trim(),
      appointment_intent:
        parsed.appointment_intent === true ||
        parsed.appointmentIntent === true ||
        normalizeId(parsed.action || parsed.acao) === 'schedule_appointment',
      appointment_confirmed: parsed.appointment_confirmed === true || parsed.appointmentConfirmed === true,
      appointment_date: String(parsed.appointment_date || parsed.appointmentDate || '').trim(),
      appointment_time: String(parsed.appointment_time || parsed.appointmentTime || '').trim(),
      appointment_title: String(parsed.appointment_title || parsed.appointmentTitle || '').trim(),
      reason: String(parsed.reason || parsed.motivo || '').trim(),
      confidence: Number(parsed.confidence ?? parsed.confianca ?? 0.5),
    };
  } catch {
    return {
      reply: text,
      action: 'reply',
      pipeline_id: '',
      stage_id: '',
      queue_id: '',
      user_id: '',
      appointment_intent: false,
      appointment_confirmed: false,
      appointment_date: '',
      appointment_time: '',
      appointment_title: '',
      reason: 'Modelo retornou texto livre',
      confidence: 0.3,
    };
  }
}

function stripEmoji(value = '') {
  return String(value || '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function looksLikeClosingReply(value = '') {
  return /\b(finalizando|encerrando|encerrar|obrigado pelo contato|excelente dia|ate logo)\b/i
    .test(normalizeText(value));
}

function looksLikeHandoffReply(value = '') {
  return /\b(encaminhar|encaminho|transferir|transferindo|atendente|humano|nossa equipe|setor de relacionamento)\b/i
    .test(normalizeText(value));
}

function looksLikeUnverifiedScheduleOffer(value = '') {
  return /\b(tenho estes horarios|tenho disponibilidade|horarios livres|horarios disponiveis|minha disponibilidade|posso marcar em|qual deles fica melhor|qual horario fica melhor)\b/i
    .test(normalizeText(value));
}

function looksLikeUnverifiedScheduleConfirmation(value = '') {
  return /\b(agendamento confirmado|ficou agendad[oa]|ficou marcado|esta agendad[oa]|reuniao confirmada|fechado.{0,30}(amanha|hoje|segunda|terca|quarta|quinta|sexta|sabado|domingo|\d{1,2}h))\b/i
    .test(normalizeText(value));
}

export function closingAcknowledgementDetected(text = '') {
  const current = normalizeText(text).replace(/[.!?,;:]+$/g, '').trim();
  return /^(isso|sim|certo|ok|okay|blz|beleza|combinado|fechado|obrigad[oa]|muito obrigad[oa]|valeu|tchau|ate mais|perfeito|show|ta bom|tudo bem)$/.test(current);
}

export function explicitCloseIntent({ parsed, context = [] }) {
  const current = normalizeText(parsed.text || '').trim();
  if (!current) return false;

  const directClose = /\b(nao tenho interesse|nao quero(?: saber)?|nao preciso|vou procurar outra|pode encerrar|encerra(?:r)?(?: o)? atendimento|finaliza(?:r)?(?: o)? atendimento|nao me chama|nao envie|pare de chamar|ja resolvi|resolvido|era so isso|obrigad[oa],? era so|tchau|adeus|pode parar)\b/i;
  const declinedOnlyAppointment = /\bnao quero\b.{0,25}\b(agendar|marcar|reuniao|demonstracao|demo)\b/i.test(current)
    && !/\b(encerrar|encerra|finalizar|finaliza|tchau|adeus|nao tenho interesse)\b/i.test(current);
  if (declinedOnlyAppointment) return false;
  if (directClose.test(current) || /^(sai|fim|encerra|finaliza)$/i.test(current)) return true;

  const lastAssistant = [...context].reverse().find((row) => row.role === 'assistant');
  const assistantAskedToFinish = /\b(mais alguma|alguma duvida|algo mais|posso ajudar em mais|gostaria de discutir|antes da (nossa )?reuniao)\b/i
    .test(normalizeText(lastAssistant?.content || ''));
  if (
    assistantAskedToFinish
    && /^(nenhum|nenhuma(?:,?\s+muito obrigad[oa])?|nada|nao|nao,?\s+obrigad[oa]|so isso|era isso)[.!?]*$/i.test(current)
  ) {
    return true;
  }

  if (!/^(nao|negativo)$/i.test(current)) return false;
  const recentUserText = normalizeText(
    context
      .filter((row) => row.role === 'user')
      .slice(-3)
      .map((row) => row.content)
      .join(' '),
  );
  return directClose.test(recentUserText);
}

function explicitRefusalIntent(text = '') {
  return /\b(nao tenho interesse|nao quero(?: saber)?|nao preciso|vou procurar outra|nao faz sentido|prefiro outra ferramenta)\b/i
    .test(normalizeText(text));
}

function strongHandoffIntent({ decision = {}, parsed, context = [] }) {
  if (humanRequestDetected(parsed.text)) return true;

  const text = normalizeText([
    ...context
      .filter((row) => row.role === 'user')
      .slice(-4)
      .map((row) => row.content),
    parsed.text || '',
    decision.reason || '',
  ].join(' '));

  if (/\b(contratar|contratacao|fechar|fechamento|contrato|pagamento|pagar|boleto|financeiro|regularizacao|regularizar|negociar|negociacao|desconto|condicao especial|suporte|cancelamento|cancelar|reclamacao|reclamar|pergunta tecnica|nao sei responder)\b/i.test(text)) {
    return true;
  }

  return false;
}

function replyAlreadyUsed(value = '', context = []) {
  const candidate = normalizeText(value).replace(/\s+/g, ' ').trim();
  if (!candidate) return false;
  return context
    .filter((row) => row.role === 'assistant')
    .slice(-6)
    .some((row) => normalizeText(row.content).replace(/\s+/g, ' ').trim() === candidate);
}

function closingReply(lead = {}, parsed = {}) {
  const name = lead?.name || parsed?.name || '';
  return `${name ? `${name}, ` : ''}tudo bem. Vou encerrar o atendimento por aqui.`;
}

export function fallbackContinuationReply({ parsed, lead, context = [] }) {
  const name = lead?.name || parsed?.name || '';
  const prefix = name ? `${name}, ` : '';
  const current = normalizeText(parsed?.text || '').trim();
  const candidates = [
    /\?$/.test(String(parsed?.text || '').trim())
      ? `${prefix}entendi sua pergunta. Vou responder exatamente esse ponto.`
      : `${prefix}entendi. Qual e a principal duvida que voce quer resolver agora?`,
    `${prefix}certo. Me diga qual ponto faz mais sentido esclarecer primeiro.`,
    `${prefix}vamos por partes. O que voce precisa saber neste momento?`,
  ];

  if (/\b(nao|negativo)\b/i.test(current)) {
    candidates.unshift(`${prefix}tudo bem. Posso encerrar o atendimento por aqui?`);
  }

  return candidates.find((candidate) => !replyAlreadyUsed(candidate, context)) || candidates.at(-1);
}

export function normalizeAiDecisionForWorkflow({
  decision = {},
  actions = [],
  rule = null,
  agent = {},
  parsed = {},
  lead = {},
  context = [],
  spamRisk = false,
}) {
  const normalized = {
    ...decision,
    action: normalizeId(decision.action || 'reply') || 'reply',
    reply: stripEmoji(decision.reply || ''),
  };

  if (!['reply', 'handoff', 'move_stage', 'close_ticket', 'stop_ai', 'schedule_appointment'].includes(normalized.action)) {
    normalized.action = 'reply';
  }

  const wantsHuman = humanRequestDetected(parsed.text);
  const wantsClose = explicitCloseIntent({ parsed, context });
  const closeAllowed = canExecuteAction(actions, 'close_ticket') && wantsClose;
  const transferAllowed = canExecuteAction(actions, 'transfer_ticket');
  const ruleAllowsHandoff = rule?.stop_ai_after_match === true;
  const appointmentEscalation = normalized.appointment_escalation === true;

  if (wantsHuman) {
    normalized.action = 'handoff';
    normalized.reply = defaultHandoffMessage(agent);
    normalized.reason = 'Cliente pediu explicitamente atendimento humano';
    normalized.confidence = 1;
  } else if (wantsClose) {
    normalized.action = closeAllowed ? 'close_ticket' : 'stop_ai';
    normalized.reply = closingReply(lead, parsed);
    normalized.reason = closeAllowed
      ? 'Cliente pediu explicitamente o encerramento'
      : 'Cliente pediu encerramento; IA interrompida porque close_ticket esta desabilitado';
    normalized.confidence = 1;
  }

  if (normalized.action === 'close_ticket' && !closeAllowed) {
    normalized.action = rule ? 'move_stage' : 'reply';
    normalized.reason = `${normalized.reason || 'Decisao ajustada'} | close_ticket bloqueado sem encerramento explicito`;
    if (!normalized.reply || looksLikeClosingReply(normalized.reply) || looksLikeHandoffReply(normalized.reply)) {
      normalized.reply = fallbackContinuationReply({ parsed, lead, context });
    }
  }

  if (normalized.action === 'handoff' && !transferAllowed) {
    normalized.action = rule ? 'move_stage' : 'reply';
    normalized.reason = `${normalized.reason || 'Decisao ajustada'} | handoff bloqueado porque transfer_ticket esta desabilitado`;
    if (!normalized.reply || looksLikeClosingReply(normalized.reply) || looksLikeHandoffReply(normalized.reply)) {
      normalized.reply = fallbackContinuationReply({ parsed, lead, context });
    }
  }

  if (normalized.action === 'handoff' && !rule && !wantsHuman && !spamRisk && !appointmentEscalation) {
    normalized.action = 'reply';
    normalized.reason = `${normalized.reason || 'Decisao ajustada'} | handoff bloqueado sem regra, pedido humano ou risco de spam`;
    if (!normalized.reply || looksLikeClosingReply(normalized.reply) || looksLikeHandoffReply(normalized.reply)) {
      normalized.reply = fallbackContinuationReply({ parsed, lead, context });
    }
  }

  if (
    normalized.action === 'handoff'
    && !spamRisk
    && !ruleAllowsHandoff
    && !appointmentEscalation
    && !strongHandoffIntent({ decision: normalized, parsed, context })
  ) {
    normalized.action = rule ? 'move_stage' : 'reply';
    normalized.reason = `${normalized.reason || 'Decisao ajustada'} | handoff bloqueado sem sinal forte de entrega humana`;
    if (!normalized.reply || looksLikeClosingReply(normalized.reply) || looksLikeHandoffReply(normalized.reply)) {
      normalized.reply = fallbackContinuationReply({ parsed, lead, context });
    }
  }

  if (!normalized.reply && normalized.action === 'move_stage') {
    normalized.reply = fallbackContinuationReply({ parsed, lead, context });
  }

  if (!isStopAction(normalized.action) && looksLikeHandoffReply(normalized.reply)) {
    normalized.reply = fallbackContinuationReply({ parsed, lead, context });
  }

  if (!normalized.appointment_intent && looksLikeUnverifiedScheduleOffer(normalized.reply)) {
    normalized.action = rule ? 'move_stage' : 'reply';
    normalized.reply = fallbackContinuationReply({ parsed, lead, context });
    normalized.reason = `${normalized.reason || 'Decisao ajustada'} | oferta de agenda bloqueada sem pedido explicito`;
  }

  if (!normalized.appointment_created && looksLikeUnverifiedScheduleConfirmation(normalized.reply)) {
    normalized.action = rule ? 'move_stage' : 'reply';
    normalized.reply = 'Antes de confirmar, preciso validar a data e o horario na agenda.';
    normalized.reason = `${normalized.reason || 'Decisao ajustada'} | confirmacao de agenda bloqueada sem compromisso criado`;
  }

  if (!isStopAction(normalized.action) && replyAlreadyUsed(normalized.reply, context)) {
    normalized.reply = fallbackContinuationReply({ parsed, lead, context });
    normalized.reason = `${normalized.reason || 'Decisao ajustada'} | resposta repetida substituida`;
  }

  return normalized;
}

function contextToPrompt(context = [], currentText = '') {
  const rows = [...context];
  const normalizedCurrent = normalizeText(currentText).trim();
  if (normalizedCurrent) {
    const currentIndex = rows.findLastIndex((row) => (
      row.role === 'user' && normalizeText(row.content).trim() === normalizedCurrent
    ));
    if (currentIndex >= 0) rows.splice(currentIndex, 1);
  }
  if (rows.length === 0) return 'Sem historico anterior.';

  return rows
    .slice(-18)
    .map((row) => {
      const who = row.role === 'assistant' ? 'IA' : row.role === 'system' ? 'Sistema' : 'Cliente';
      return `${who}: ${String(row.content || '').slice(0, 800)}`;
    })
    .join('\n');
}

function aiDecisionResponseFormat() {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'crm_ai_decision',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          reply: { type: 'string', description: 'Mensagem curta em portugues do Brasil para enviar ao cliente.' },
          action: {
            type: 'string',
            enum: ['reply', 'handoff', 'move_stage', 'close_ticket', 'stop_ai', 'schedule_appointment'],
            description: 'Acao operacional que o backend deve tentar executar.',
          },
          pipeline_id: { type: 'string', description: 'ID exato do funil Z-PRO, ou string vazia.' },
          stage_id: { type: 'string', description: 'ID exato da etapa Z-PRO, ou string vazia.' },
          queue_id: { type: 'string', description: 'ID exato da fila Z-PRO, ou string vazia.' },
          user_id: { type: 'string', description: 'ID exato do usuario Z-PRO, ou string vazia.' },
          appointment_intent: { type: 'boolean', description: 'True quando o cliente quer marcar, remarcar ou confirmar um compromisso.' },
          appointment_confirmed: { type: 'boolean', description: 'True somente quando data e horario foram aceitos inequivocamente pelo cliente.' },
          appointment_date: { type: 'string', description: 'Data local YYYY-MM-DD, ou string vazia.' },
          appointment_time: { type: 'string', description: 'Horario local HH:mm, ou string vazia.' },
          appointment_title: { type: 'string', description: 'Titulo curto do compromisso, ou string vazia.' },
          reason: { type: 'string', description: 'Motivo operacional da decisao.' },
          confidence: { type: 'number', description: 'Confianca de 0 a 1.' },
        },
        required: [
          'reply',
          'action',
          'pipeline_id',
          'stage_id',
          'queue_id',
          'user_id',
          'appointment_intent',
          'appointment_confirmed',
          'appointment_date',
          'appointment_time',
          'appointment_title',
          'reason',
          'confidence',
        ],
      },
    },
  };
}

function routeClassifierResponseFormat() {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'crm_route_classifier',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          rule_index: {
            type: 'number',
            description: 'Numero da regra escolhida, comecando em 1. Use -1 quando nenhuma regra combinar.',
          },
          action: {
            type: 'string',
            enum: ['none', 'handoff', 'move_stage', 'close_ticket'],
            description: 'Acao que a regra exige.',
          },
          reply: {
            type: 'string',
            description: 'Mensagem curta para o cliente quando a regra combinar. Vazio se nenhuma regra combinar.',
          },
          reason: {
            type: 'string',
            description: 'Por que a conversa combina ou nao com a regra.',
          },
          confidence: {
            type: 'number',
            description: 'Confianca de 0 a 1.',
          },
        },
        required: ['rule_index', 'action', 'reply', 'reason', 'confidence'],
      },
    },
  };
}

function parseRouteClassifierDecision(raw = '') {
  const text = String(raw || '').trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  try {
    const parsed = JSON.parse(text);
    return {
      rule_index: Number(parsed.rule_index ?? -1),
      action: String(parsed.action || 'none').trim(),
      reply: String(parsed.reply || '').trim(),
      reason: String(parsed.reason || '').trim(),
      confidence: Number(parsed.confidence ?? 0),
    };
  } catch {
    return {
      rule_index: -1,
      action: 'none',
      reply: '',
      reason: 'Classificador retornou texto invalido',
      confidence: 0,
    };
  }
}

function ruleAtIndex(ruleIndex, routingRules = []) {
  const index = Number(ruleIndex);
  if (!Number.isInteger(index)) return null;
  if (index < 1 || index > routingRules.length) return null;
  return routingRules[index - 1];
}

export function shouldRunRoutingClassifier({ routingRules = [], decisionRule = null, appointmentIntent = false } = {}) {
  return routingRules.length > 0 && (!decisionRule || appointmentIntent);
}

async function classifyRoutingRuleWithAi({ agent, parsed, lead, context, routingRules, currentDecision }) {
  if (!routingRules.length) {
    return {
      rule: null,
      classification: {
        rule_index: -1,
        action: 'none',
        reply: '',
        reason: 'Nao ha regras configuradas',
        confidence: 0,
      },
    };
  }

  const client = getOpenAIClient();
  if (!client) throw new Error('OPENAI_API_KEY ausente no backend');

  const rulesText = routingRules.map((rule, index) => [
    `REGRA ${index + 1}`,
    `Funil: ${rule.pipeline_name || rule.external_pipeline_id} | pipeline_id=${rule.external_pipeline_id}`,
    `Etapa: ${rule.stage_name || rule.external_stage_id} | stage_id=${rule.external_stage_id}`,
    `Fila: ${rule.queue_name || rule.external_queue_id || 'nao definida'} | queue_id=${rule.external_queue_id || ''}`,
    `Instrucao: ${rule.routing_instruction || 'sem instrucao'}`,
    `Entrega humana obrigatoria: ${rule.stop_ai_after_match ? 'sim' : 'nao'}`,
    `Pode encerrar ticket: ${rule.close_ticket_on_match ? 'sim' : 'nao'}`,
    rule.handoff_message ? `Mensagem da regra: ${rule.handoff_message}` : '',
  ].filter(Boolean).join('\n')).join('\n\n');

  const request = {
    model: agent.model || process.env.DEFAULT_OPENAI_MODEL || 'gpt-4o-mini',
    temperature: 0,
    max_tokens: boundedNumber(process.env.OPENAI_ROUTE_MAX_TOKENS, 220, 120, 400),
    response_format: routeClassifierResponseFormat(),
    messages: [
      {
        role: 'system',
        content: [
          'Voce e um classificador operacional de CRM. Sua unica tarefa e escolher uma regra de etapa do Z-PRO para a conversa.',
          'Use somente as regras listadas. Nao invente funil, etapa, fila ou usuario.',
          'Escolha -1 quando nenhuma regra combinar com seguranca.',
          'Considere o historico recente inteiro, nao apenas uma palavra solta.',
          'A mensagem atual do cliente tem prioridade sobre ofertas ou perguntas anteriores da IA.',
          'Se o cliente quer humano mas nenhuma regra especifica combina, use -1.',
          'Escolha move_stage quando a conversa pertence a uma etapa, mas a IA deve continuar conduzindo o lead.',
          'Escolha handoff somente quando o cliente pediu uma pessoa, quer negociar/contratar/fechar, ou a instrucao da regra exige humano naquele contexto.',
          'Se a regra escolhida esta marcada como "Entrega humana obrigatoria: sim", a acao deve ser handoff. Isso e obrigacao, nao sugestao.',
          'Escolha close_ticket somente quando houver recusa clara, pedido de encerramento ou resolucao confirmada.',
          'Perguntas como preco, como funciona, funcionalidades, detalhes, WhatsApp, ligacoes, CRM ou IA normalmente sao move_stage para etapa de informacoes, nao handoff.',
          'A resposta deve ser uma unica mensagem curta para o cliente. Quando a regra exigir entrega humana, inclua telefone, endereco ou orientacao operacional somente se estiverem escritos nas instrucoes do agente ou da regra.',
          'Nunca ofereca horarios se o contexto operacional disser que o agendamento automatico esta desativado.',
          'Use exatamente as chaves: rule_index, action, reply, reason, confidence.',
          'Valores aceitos em action: none, handoff, move_stage, close_ticket.',
          'Retorne somente JSON no schema pedido.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `Contato: ${lead.name || parsed.name || 'nao informado'} (${lead.phone || parsed.phone || 'sem telefone'})`,
          `Status do ticket: ${parsed.ticketStatus || 'nao informado'}`,
          'Instrucoes operacionais do agente:',
          String(agent.system_prompt || 'sem instrucoes adicionais').slice(0, 12000),
          agent.settings?.allowed_actions_description
            ? `Acoes permitidas: ${agent.settings.allowed_actions_description}`
            : '',
          agent.settings?.forbidden_actions_description
            ? `Acoes proibidas: ${agent.settings.forbidden_actions_description}`
            : '',
          normalizedSchedulePolicy(agent.settings?.schedule_policy).enabled
            ? 'Agenda automatica configurada: sim.'
            : 'Agenda automatica configurada: nao. Use a regra de etapa aplicavel para orientar ou entregar ao humano.',
          'Historico recente:',
          contextToPrompt(context, parsed.text),
          `Mensagem atual: ${parsed.text || '[sem texto]'}`,
          'Decisao preliminar da IA:',
          JSON.stringify(sanitizeObject(currentDecision || {})),
          'Regras disponiveis:',
          rulesText,
        ].filter(Boolean).join('\n'),
      },
    ],
  };

  let completion;
  try {
    completion = await client.chat.completions.create(request);
  } catch (err) {
    if (!/response_format|json_schema|schema/i.test(err.message || '')) throw err;
    const fallbackRequest = {
      ...request,
      response_format: { type: 'json_object' },
    };
    completion = await client.chat.completions.create(fallbackRequest);
  }

  const classification = parseRouteClassifierDecision(completion.choices?.[0]?.message?.content || '');
  const rule = classification.confidence >= 0.65
    ? ruleAtIndex(classification.rule_index, routingRules)
    : null;

  return {
    rule,
    classification,
  };
}

async function generateAiDecision({ agent, actions, parsed, lead, context, routingRules, spamRisk }) {
  const client = getOpenAIClient();
  if (!client) throw new Error('OPENAI_API_KEY ausente no backend');
  const schedulePolicy = normalizedSchedulePolicy(agent.settings?.schedule_policy);
  const localNow = new Intl.DateTimeFormat('sv-SE', {
    timeZone: schedulePolicy.timezone,
    dateStyle: 'short',
    timeStyle: 'short',
    hourCycle: 'h23',
  }).format(new Date());

  const request = {
    model: agent.model || process.env.DEFAULT_OPENAI_MODEL || 'gpt-4o-mini',
    temperature: Number(agent.temperature ?? 0.3),
    max_tokens: boundedNumber(agent.settings?.max_tokens || process.env.OPENAI_DECISION_MAX_TOKENS, 320, 160, 600),
    response_format: aiDecisionResponseFormat(),
    messages: [
      {
        role: 'system',
        content: buildAiSystemPrompt(agent, actions, routingRules),
      },
      {
        role: 'user',
        content: [
          `Nome do contato: ${lead.name || parsed.name || 'nao informado'}`,
          `Telefone: ${lead.phone || parsed.phone}`,
          `Canal: ${parsed.channelName || parsed.whatsappName || 'nao informado'}`,
          `Status do ticket no Z-PRO: ${parsed.ticketStatus || 'nao informado'}`,
          `Data e hora local atual (${schedulePolicy.timezone}): ${localNow}`,
          `Risco de muitas mensagens em pouco tempo: ${spamRisk ? 'sim' : 'nao'}`,
          'Historico recente:',
          contextToPrompt(context, parsed.text),
          `Mensagem recebida agora: ${parsed.text || '[sem texto]'}`,
        ].join('\n'),
      },
    ],
  };

  let completion;
  try {
    completion = await client.chat.completions.create(request);
  } catch (err) {
    if (!/response_format|json_schema|schema|json/i.test(err.message || '')) throw err;
    try {
      completion = await client.chat.completions.create({
        ...request,
        response_format: { type: 'json_object' },
      });
    } catch (fallbackErr) {
      if (!/response_format|json/i.test(fallbackErr.message || '')) throw fallbackErr;
      const fallbackRequest = { ...request };
      delete fallbackRequest.response_format;
      completion = await client.chat.completions.create(fallbackRequest);
    }
  }

  return parseAiDecision(completion.choices?.[0]?.message?.content || '');
}

function audioReplyFor(agent = {}, leadMetadata = {}) {
  const policy = agent.settings?.audio_policy || {};
  const mode = policy.mode || 'ask_once_then_transfer';
  const message = policy.message || 'Por enquanto nao consigo ouvir audio por aqui. Pode me mandar por texto?';
  const audioCount = Number(leadMetadata.audio_message_count || 0);

  if (mode === 'transfer_to_human') {
    return {
      shouldReply: Boolean(agent.handoff_message || message),
      text: agent.handoff_message || message,
      shouldTransfer: true,
    };
  }

  if (mode === 'ask_once_then_transfer' && audioCount >= 2) {
    return {
      shouldReply: Boolean(agent.handoff_message || message),
      text: agent.handoff_message || message,
      shouldTransfer: true,
    };
  }

  return {
    shouldReply: true,
    text: message,
    shouldTransfer: false,
  };
}

async function maybeTransferAudioTicket({ zpro, agent, actions, parsed, lead, leadMetadata, integration }) {
  const policy = agent?.settings?.audio_policy || {};
  const queueId = policy.transfer_queue_id;
  if (!parsed.ticketId || !queueId || !canExecuteAction(actions, 'transfer_ticket')) return null;

  const audioDecision = audioReplyFor(agent, leadMetadata);
  if (!audioDecision.shouldTransfer) return null;

  try {
    const result = await zpro.updateTicketAssignment({
      ticketId: parsed.ticketId,
      queueId,
      status: 'pending',
    });

    await insertLeadEvent({
      tenantId: integration.tenant_id,
      leadId: lead.id,
      eventType: 'zpro_ticket_transferred',
      summary: 'Ticket transferido por regra de audio.',
      payload: {
        ticket_id: parsed.ticketId,
        queue_id: queueId,
        endpoint: result.endpoint,
        data: result.data,
      },
    });

    return result;
  } catch (err) {
    await insertLeadEvent({
      tenantId: integration.tenant_id,
      leadId: lead.id,
      eventType: 'zpro_ticket_transfer_failed',
      summary: 'Falha ao transferir ticket por regra de audio.',
      payload: {
        ticket_id: parsed.ticketId,
        queue_id: queueId,
        error: err.message || String(err),
        attempts: err.attempts,
      },
    });
    return null;
  }
}

export function humanRequestDetected(text = '') {
  const current = normalizeText(text).trim();
  if (!current) return false;
  const explicit = /\b(falar|fala|conversar|conversa|passar|passa|encaminhar|encaminha|transferir|transfere|chamar|chama|quero|preciso|prefiro|cade)\b.{0,45}\b(humano|atendente|pessoa|alguem|consultor|vendedor|gerente)\b/i.test(current)
    || /\b(humano|atendente|suporte humano)\b.{0,25}\b(agora|por favor)\b/i.test(current)
    || /^(humano|atendente|quero um atendente|quero falar com alguem)$/i.test(current)
    || /\b(me liga|pode me ligar|ligue para mim)\b/i.test(current);
  if (explicit) return true;

  const request = current.match(/\b(falar|fala|conversar|conversa|passar|passa|encaminhar|encaminha|transferir|transfere|chamar|chama|quero|preciso|prefiro|cade)\b(.{0,55})/i);
  if (!request) return false;
  return request[2]
    .split(/[^a-z]+/)
    .filter(Boolean)
    .some((token) => token.length >= 7 && editDistanceAtMost(token, 'atendente', 2));
}

function editDistanceAtMost(left = '', right = '', limit = 2) {
  if (Math.abs(left.length - right.length) > limit) return false;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    let rowMinimum = row;
    for (let column = 1; column <= right.length; column += 1) {
      const value = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
      current.push(value);
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > limit) return false;
    previous = current;
  }
  return previous[right.length] <= limit;
}

function pendingAppointmentDecisionFromContext(context = []) {
  const decision = [...context].reverse().find((row) => {
    const candidate = row.role === 'assistant' ? row.metadata?.decision : null;
    return candidate && (
      candidate.appointment_intent === true
      || candidate.appointment_created === true
      || candidate.appointment_cancelled === true
      || candidate.appointment_escalation === true
    );
  })?.metadata?.decision;
  if (!decision) return null;
  if (
    decision.appointment_created === true
    || decision.appointment_cancelled === true
    || decision.appointment_escalation === true
  ) return null;
  return decision.appointment_intent === true ? decision : null;
}

export function appointmentIntentDetected({ parsed = {}, context = [] }) {
  const current = normalizeText(parsed.text || '');
  const explicitRequest = Boolean(
    /\b(quero|gostaria|queria|pode|podemos|posso|vamos|preciso|desejo)\b.{0,45}\b(agendar|agendamento|agenda|marcar|reuniao|demonstracao|demo)\b/i.test(current)
    || /\b(agendar|marcar)\b.{0,35}\b(reuniao|demonstracao|demo|conversa|horario|apresentacao)\b/i.test(current)
    || /\b(quais horarios|tem (algum |um |os )?horario|qual (e |a )?disponibilidade|qual horario tem)\b/i.test(current)
  );
  if (explicitRequest) return true;

  const pendingAppointment = Boolean(pendingAppointmentDecisionFromContext(context));
  const lastAssistant = [...context].reverse().find((row) => row.role === 'assistant');
  const assistantInScheduling = Boolean(
    pendingAppointment
    ||
    lastAssistant?.metadata?.decision?.appointment_intent === true
    || /\b(quer agendar|posso agendar|podemos agendar|agendar uma demonstracao|marcar uma demonstracao|qual periodo|qual data|qual dia|qual horario|tenho estes horarios livres|tenho disponibilidade|horarios disponiveis|posso marcar em|qual deles fica melhor)\b/i
      .test(normalizeText(lastAssistant?.content || ''))
  );
  const schedulingResponse = Boolean(
    /^(sim|pode ser|vamos|quero|fechado|confirmo|ok|certo|beleza|blz|conseguiu|conferiu|verificou|qual data|que dia|qual horario|manha|de manha|a tarde|tarde|noite|hoje|amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo|dia\s+\d{1,2}|\d{1,2}(?::\d{2})?|\d{1,2}h)\s*[?!.]*$/i.test(current.trim())
    || /\b(tem|quero|prefiro|pode ser|disponibilidade|horario|agenda|agendar|marcar)\b.{0,35}\b(manha|tarde|noite|dia|data|horario)\b/i.test(current)
    || /\b(que|quais|qual)\s+horas?\b/i.test(current)
    || /\b(hoje|amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo|\d{1,2}[/-]\d{1,2})\b.{0,25}\b(\d{1,2}(?::\d{2})?|\d{1,2}h|manha|tarde|noite)\b/i.test(current)
    || (pendingAppointment && Boolean(appointmentDatePreference(current)))
    || (pendingAppointment && Boolean(appointmentTimePreference(current)))
    || (pendingAppointment && appointmentOptionsRejected(current))
    || (pendingAppointment && /\b(?:[01]?\d|2[0-3])(?::[0-5]\d|h(?:[0-5]\d)?)\b/i.test(current))
  );
  return assistantInScheduling && schedulingResponse;
}

export function selectedAppointmentOptionFromContext(context = [], text = '') {
  const current = normalizeText(text).replace(/\s+/g, ' ').trim();
  if (!current) return null;

  const assistantWithOptions = [...context].reverse().find((row) => (
    row.role === 'assistant'
    && Array.isArray(row.metadata?.decision?.appointment_options)
    && row.metadata.decision.appointment_options.length > 0
  ));
  const options = assistantWithOptions?.metadata?.decision?.appointment_options || [];
  if (options.length === 0) return null;

  const exactLabelMatches = options.filter((option) => normalizeText(option.label || '') === current);
  if (exactLabelMatches.length === 1) return exactLabelMatches[0];

  const directOrdinal = current.match(/^(?:opcao\s*)?(1|2|3|um|uma|dois|duas|tres)\s*[.!?]*$/i);
  if (directOrdinal) {
    const optionNumber = parsePortugueseNumber(directOrdinal[1], 3);
    return options[optionNumber - 1] || null;
  }
  const ordinalWords = { primeira: 0, segunda: 1, terceira: 2 };
  const wordOrdinal = current.match(/\b(primeira|segunda|terceira)\s+opcao\b/i);
  if (wordOrdinal) return options[ordinalWords[wordOrdinal[1]]] || null;

  const timeMatches = [...current.matchAll(/\b([01]?\d|2[0-3])(?::([0-5]\d)|h([0-5]\d)?)?\b/gi)]
    .map((match) => ({
      hour: String(Number(match[1])).padStart(2, '0'),
      minute: match[2] || match[3] || '00',
    }))
    .filter((item, index, rows) => rows.findIndex((row) => row.hour === item.hour && row.minute === item.minute) === index);
  if (timeMatches.length === 1) {
    const [{ hour, minute }] = timeMatches;
    const matches = options.filter((option) => String(option.time || '') === `${hour}:${minute}`);
    if (matches.length === 1) return matches[0];
  }

  const naturalTime = appointmentTimePreference(current);
  if (naturalTime) {
    const matches = options.filter((option) => String(option.time || '') === naturalTime);
    if (matches.length === 1) return matches[0];
  }

  const ordinal = current.match(/(?:opcao|horario|o)\s*(?:numero\s*)?([1-9])\b/i);
  if (ordinal) return options[Number(ordinal[1]) - 1] || null;

  const containedMatches = options.filter((option) => (
    current.length >= 5 && normalizeText(option.label || '').includes(current)
  ));
  return containedMatches.length === 1 ? containedMatches[0] : null;
}

function aiStateStopped(metadata = {}, parsed = {}) {
  const state = metadata.ai_state || {};
  if (!state.stopped) return false;
  if (state.ticket_id && parsed.ticketId && String(state.ticket_id) !== String(parsed.ticketId)) return false;
  return true;
}

function ticketAutomationBlockReason(parsed = {}, metadata = {}) {
  const status = normalizeId(parsed.ticketStatus);
  if (status === 'open') return 'ticket_open_human';
  if (status === 'closed') return 'ticket_closed';
  if (aiStateStopped(metadata, parsed)) return metadata.ai_state?.reason || 'ai_stopped_for_ticket';
  return null;
}

function defaultHandoffMessage(agent = {}) {
  return agent.handoff_message ||
    'Vou encaminhar seu atendimento para nossa equipe. Eles vao continuar com voce.';
}

function getOpportunityExternalId(opportunity = {}) {
  return pickFirst(
    opportunity.external_opportunity_id,
    opportunity.raw_data?.external_opportunity_id,
    getExternalOpportunityId(opportunity.raw_data?.zpro_create_response || {}),
  );
}

function findRoutingRule(decision = {}, routingRules = [], fallback = {}) {
  const pipelineId = normalizeId(decision.pipeline_id || fallback.pipeline_id);
  const stageId = normalizeId(decision.stage_id || fallback.stage_id);
  if (!pipelineId && !stageId) return null;

  return routingRules.find((rule) => {
    const pipelineMatches = !pipelineId || normalizeId(rule.external_pipeline_id) === pipelineId;
    const stageMatches = !stageId || normalizeId(rule.external_stage_id) === stageId;
    return pipelineMatches && stageMatches;
  }) || null;
}

function findRefusalRoutingRule(routingRules = []) {
  return routingRules.find((rule) => {
    const description = normalizeText([
      rule.stage_name,
      rule.routing_instruction,
    ].filter(Boolean).join(' '));
    return /\b(sem interesse|nao tem interesse|recusa|recusou|desistencia|perdido)\b/i.test(description);
  }) || null;
}

function currentOpportunityRoutingFallback({ opportunity = {}, integration = {}, parsed = {}, decision = {} }) {
  return {
    pipeline_id: opportunity?.pipeline_id || integration?.pipeline_id || decision?.pipeline_id || '',
    stage_id: opportunity?.stage_id || integration?.initial_stage_id || decision?.stage_id || '',
    queue_id: decision?.queue_id || parsed?.queueId || integration?.sales_queue_id || '',
  };
}

function ruleUserIds(rule = null) {
  if (!rule) return [];
  let userOrder = rule.user_order;
  if (typeof userOrder === 'string') {
    try {
      userOrder = JSON.parse(userOrder);
    } catch {
      userOrder = [];
    }
  }
  return Array.isArray(userOrder)
    ? userOrder
      .map((item) => (
        item && typeof item === 'object'
          ? pickFirst(item.external_user_id, item.externalUserId, item.userId, item.id, item.value)
          : item
      ))
      .map((item) => String(item || '').trim())
      .filter(Boolean)
    : [];
}

async function selectRuleUser(rule = null, zpro, parsed = {}) {
  if (!rule) return null;
  const userOrder = ruleUserIds(rule);
  if (userOrder.length === 0 || rule.distribution_mode === 'manual') return null;
  const { chooseLeastLoaded } = await import('../crm/routingService.js');
  const { allPages } = await import('../crm/zproData.js');
  const loads = rule.distribution_mode === 'least_load'
    ? chooseLeastLoaded(userOrder, await allPages((f) => zpro.listTickets(f), { status: 'open', queueId: rule.external_queue_id }, 200, false)) : {};
  const { data, error } = await supabaseAdmin.rpc('crm_ai_next_distribution', {
    p_tenant: rule.tenant_id, p_integration: rule.integration_id, p_rule: rule.id, p_users: userOrder,
    p_mode: rule.distribution_mode || 'balanced_rotation', p_loads: loads,
    p_assignment: `legacy:${parsed.ticketId}:${parsed.eventId}`,
  });
  if (error) throw error;
  return data;
}

async function markLeadAiStopped({ lead, parsed, reason, status = 'transferred', extra = {} }) {
  const dbStatus = ['new', 'ai_attending', 'qualified', 'transferred', 'in_progress', 'won', 'lost', 'archived']
    .includes(status)
    ? status
    : leadStopStatusFor(reason);
  const metadata = {
    ...(lead.metadata || {}),
    ai_state: {
      ...(lead.metadata?.ai_state || {}),
      stopped: true,
      reason,
      ticket_id: parsed.ticketId || lead.external_ticket_id || null,
      stopped_at: new Date().toISOString(),
      ...extra,
    },
  };

  const { data, error } = await supabaseAdmin
    .from('crm_ai_leads')
    .update({
      status: dbStatus,
      metadata,
      updated_at: new Date().toISOString(),
    })
    .eq('id', lead.id)
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

async function resumeLeadAiAfterFailedHandoff({ lead, parsed, error }) {
  const metadata = {
    ...(lead.metadata || {}),
    ai_state: {
      ...(lead.metadata?.ai_state || {}),
      stopped: false,
      reason: 'handoff_failed',
      ticket_id: parsed.ticketId || lead.external_ticket_id || null,
      handoff_error: error || 'Falha ao confirmar atribuicao no Z-PRO',
      resumed_at: new Date().toISOString(),
    },
  };

  const { data, error: updateError } = await supabaseAdmin
    .from('crm_ai_leads')
    .update({
      status: 'ai_attending',
      metadata,
      updated_at: new Date().toISOString(),
    })
    .eq('id', lead.id)
    .select('*')
    .single();

  if (updateError) throw updateError;
  return data;
}

async function updateLocalOpportunityStage({ opportunity, pipelineId, stageId, assignedExternalUserId, rawPatch = {} }) {
  if (!opportunity?.id) return opportunity;

  const payload = {
    pipeline_id: pipelineId || opportunity.pipeline_id,
    stage_id: stageId || opportunity.stage_id,
    raw_data: {
      ...(opportunity.raw_data || {}),
      ...rawPatch,
    },
    updated_at: new Date().toISOString(),
  };
  if (assignedExternalUserId !== undefined) {
    payload.assigned_external_user_id = assignedExternalUserId || null;
  }

  let { data, error } = await supabaseAdmin
    .from('crm_ai_opportunities')
    .update(payload)
    .eq('id', opportunity.id)
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

async function findLocalOpportunityForTicket({ integration, lead, ticketId = null }) {
  let query = supabaseAdmin
    .from('crm_ai_opportunities')
    .select('*')
    .eq('tenant_id', integration.tenant_id)
    .eq('integration_id', integration.id)
    .eq('lead_id', lead.id);

  query = ticketId
    ? query.eq('external_ticket_id', String(ticketId))
    : query.is('external_ticket_id', null);

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function ensureLocalOpportunityForAction({
  integration,
  lead,
  opportunity,
  pipelineId,
  stageId,
  assignedExternalUserId = null,
  externalTicketId = null,
}) {
  if (opportunity?.id) return opportunity;
  if (!pipelineId && !stageId) return opportunity;

  let { data, error } = await supabaseAdmin
    .from('crm_ai_opportunities')
    .insert({
      tenant_id: integration.tenant_id,
      lead_id: lead.id,
      integration_id: integration.id,
      external_ticket_id: externalTicketId ? String(externalTicketId) : null,
      title: `${lead.name || 'Lead ' + lead.phone} - WhatsApp`,
      pipeline_id: pipelineId || integration.pipeline_id || null,
      stage_id: stageId || integration.initial_stage_id || 'novo_lead',
      assigned_external_user_id: assignedExternalUserId || null,
      status: 'open',
      value: 0,
      raw_data: {
        created_by_ai_route: true,
        created_by_ai_route_at: new Date().toISOString(),
        zpro_ticket_sync_ticket_id: externalTicketId ? String(externalTicketId) : null,
      },
    })
    .select('*')
    .single();

  let created = true;
  if (error?.code === '23505' && externalTicketId) {
    data = await findLocalOpportunityForTicket({
      integration,
      lead,
      ticketId: externalTicketId,
    });
    error = data ? null : error;
    created = false;
  }
  if (error) throw error;

  if (created) await insertLeadEvent({
    tenantId: integration.tenant_id,
    leadId: lead.id,
    eventType: 'opportunity_created',
    summary: 'Oportunidade criada por regra da IA',
    payload: {
      opportunity_id: data.id,
      external_ticket_id: externalTicketId || null,
      pipeline_id: data.pipeline_id,
      stage_id: data.stage_id,
    },
  });

  return data;
}

async function recordAiActionFailure({ integration, lead, action, step, err, extra = {} }) {
  await insertLeadEvent({
    tenantId: integration.tenant_id,
    leadId: lead.id,
    eventType: 'ai_action_failed',
    summary: `Falha na acao ${action}: ${step}`,
    payload: {
      step,
      error: err.message || String(err),
      attempts: err.attempts,
      ...extra,
    },
  });

  logWarn('zpro.webhook.ai_action_failed', {
    integrationId: integration.id,
    tenantId: integration.tenant_id,
    leadId: lead.id,
    action,
    step,
    error: err.message || String(err),
    attempts: sanitizeObject(err.attempts || []),
    extra: sanitizeObject(extra),
  });
}

export async function createExternalOpportunityForRoute({
  zpro,
  integration,
  parsed,
  lead,
  opportunity,
  pipelineId,
  stageId,
  userId,
  reason,
}) {
  if (!getOpportunityExternalId(opportunity) && !externalOpportunityCreateRetryAllowed(opportunity)) {
    const error = new Error(`Criacao externa adiada ate ${opportunity.raw_data.zpro_create_retry_after}: ${opportunity.raw_data.zpro_create_error || 'falha anterior'}`);
    error.code = 'ZPRO_OPPORTUNITY_RETRY_DEFERRED';
    throw error;
  }
  let result;
  let recovered = null;
  let createError = null;
  try {
    result = await zpro.createOpportunity({
      number: lead.phone || parsed.phone,
      contactName: lead.name || parsed.name || lead.phone || parsed.phone,
      name: opportunity?.title || `${lead.name || 'Lead ' + lead.phone} - WhatsApp`,
      value: opportunity?.value ?? 0,
      status: 'open',
      pipelineId,
      stageId,
      responsibleId: userId || parsed.assignedExternalUserId || undefined,
      description: reason || parsed.text || 'Oportunidade criada por regra da IA.',
      validateNumber: !isOfficialWhatsAppChannel(parsed),
    });
  } catch (err) {
    createError = err;
    recovered = zproRequiresSession(err) ? null : await findExistingExternalOpportunity(zpro, { parsed, lead, pipelineId });
    if (!recovered?.id) {
      await recordExternalOpportunityCreateFailure(opportunity, err);
      throw err;
    }
    result = await zpro.moveOpportunity({
      opportunityId: recovered.id,
      name: opportunity?.title,
      value: opportunity?.value,
      status: 'open',
      pipelineId,
      stageId,
      responsibleId: userId || parsed.assignedExternalUserId || undefined,
      description: reason || 'Oportunidade existente recuperada e sincronizada pela IA.',
    });
  }

  const externalOpportunityId = recovered?.id || getExternalOpportunityId(result.data);
  if (opportunity?.id) {
    const rawData = {
      ...(opportunity.raw_data || {}),
      zpro_route_create_attempted_at: new Date().toISOString(),
      zpro_route_create_endpoint: result.endpoint,
      zpro_route_create_response: sanitizeObject(result.data),
      zpro_route_recovered: Boolean(recovered),
      zpro_route_recovery_error: createError?.message || null,
      zpro_create_error: null,
      zpro_create_retry_after: null,
      zpro_create_failure_count: 0,
    };
    const updatePayload = {
      raw_data: rawData,
      updated_at: new Date().toISOString(),
    };
    if (externalOpportunityId) {
      updatePayload.external_opportunity_id = String(externalOpportunityId);
    }

    await supabaseAdmin
      .from('crm_ai_opportunities')
      .update(updatePayload)
      .eq('id', opportunity.id);
  }

  await insertLeadEvent({
    tenantId: integration.tenant_id,
    leadId: lead.id,
    eventType: recovered ? 'zpro_opportunity_recovered' : 'zpro_opportunity_created',
    summary: recovered
      ? 'Oportunidade existente no Z-PRO foi recuperada e sincronizada pela regra da IA.'
      : 'Oportunidade criada no Z-PRO por regra da IA.',
    payload: {
      endpoint: result.endpoint,
      external_opportunity_id: externalOpportunityId,
      pipeline_id: pipelineId,
      stage_id: stageId,
      data: sanitizeObject(result.data),
    },
  });

  return {
    result,
    externalOpportunityId,
    recovered: Boolean(recovered),
  };
}

function externalOpportunityCanBeRecreated(err) {
  const message = String(err?.message || err || '');
  return /ERR_UPDATE_OPPORTUNITY|oportunidade.*(nao encontrada|invalida)|opportunity.*(not found|invalid)|Z-PRO 404/i
    .test(message);
}

function ticketStateFromResponse(data = {}) {
  return {
    userId: pickValue(data, [
      'userId', 'user_id', 'data.userId', 'data.user_id', 'ticket.userId', 'ticket.user_id',
      'data.ticket.userId', 'data.ticket.user_id', 'user.id', 'data.user.id',
      'ticket.user.id', 'data.ticket.user.id',
    ]),
    queueId: pickValue(data, [
      'queueId', 'queue_id', 'data.queueId', 'data.queue_id', 'ticket.queueId', 'ticket.queue_id',
      'data.ticket.queueId', 'data.ticket.queue_id', 'queue.id', 'data.queue.id',
      'ticket.queue.id', 'data.ticket.queue.id',
    ]),
    status: pickValue(data, ['status', 'data.status', 'ticket.status', 'data.ticket.status']),
  };
}

function ticketStateMatches(state, { userId, queueId, status }) {
  const userMatches = !userId || String(state.userId || '') === String(userId);
  const queueMatches = !queueId || String(state.queueId || '') === String(queueId);
  const statusMatches = !status || normalizeId(state.status) === normalizeId(status);
  return userMatches && queueMatches && statusMatches;
}

async function verifyTicketState(zpro, ticketId, expected, attempts = 3) {
  let verification = null;
  let state = {};

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    verification = await zpro.showTicket(ticketId);
    state = ticketStateFromResponse(verification.data || {});
    if (ticketStateMatches(state, expected)) {
      return { verification, state, matched: true };
    }
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  return { verification, state, matched: false };
}

async function executeAiDecision({ zpro, integration, agent, actions, parsed, lead, opportunity, decision, routingRules }) {
  const action = String(decision?.action || 'reply').toLowerCase();
  const stopAction = isStopAction(action);
  const rule = decision?.appointment_escalation === true
    ? null
    : findRoutingRule(decision, routingRules)
    || (stopAction
      ? findRoutingRule(
        {},
        routingRules,
        currentOpportunityRoutingFallback({ opportunity, integration, parsed, decision }),
      )
      : null);
  const selectedRuleUserId = ['handoff', 'stop_ai'].includes(action) ? await selectRuleUser(rule, zpro, parsed) : null;

  if (!['handoff', 'move_stage', 'close_ticket', 'stop_ai'].includes(action)) {
    return { executed: false, action };
  }

  const targetPipelineId = rule?.external_pipeline_id || decision.pipeline_id || opportunity?.pipeline_id || integration.pipeline_id || '';
  const targetStageId = rule?.external_stage_id || decision.stage_id || opportunity?.stage_id || integration.initial_stage_id || '';
  const targetQueueId = rule?.external_queue_id || decision.queue_id || integration.sales_queue_id || parsed.queueId || '';
  let targetUserId = stopAction
    ? selectedRuleUserId || decision.user_id || parsed.assignedExternalUserId || opportunity?.assigned_external_user_id || ''
    : parsed.assignedExternalUserId || opportunity?.assigned_external_user_id || lead.assigned_external_user_id || '';
  if (stopAction && rule?.distribution_mode === 'manual') targetUserId = '';
  const result = {
    executed: false,
    action,
    rule_id: rule?.id || null,
    pipeline_id: targetPipelineId || null,
    stage_id: targetStageId || null,
    queue_id: targetQueueId || null,
    user_id: targetUserId || null,
    opportunity: null,
    opportunity_error: null,
    ticket: null,
    ticket_verification: null,
    ticket_verified: false,
    ticket_error: null,
    ticket_effective_user_id: null,
    ticket_effective_queue_id: null,
    ticket_effective_status: null,
    local_ai_stopped: false,
    local_ai_stop_error: null,
  };

  if (stopAction) {
    try {
      lead = await markLeadAiStopped({
        lead,
        parsed,
        reason: action === 'close_ticket' ? 'ticket_closed_by_ai' : 'human_handoff_by_ai',
        status: leadStopStatusFor(action),
        extra: {
          action,
          rule_id: rule?.id || null,
          pipeline_id: targetPipelineId || null,
          stage_id: targetStageId || null,
          queue_id: targetQueueId || null,
          user_id: targetUserId || null,
        },
      });
      result.local_ai_stopped = true;
    } catch (err) {
      result.local_ai_stop_error = err.message || String(err);
      await recordAiActionFailure({ integration, lead, action, step: 'local_ai_stop', err });
    }

    const ticketStatus = action === 'close_ticket' ? 'closed' : targetUserId ? 'open' : 'pending';
    const actionKey = action === 'close_ticket' ? 'close_ticket' : 'transfer_ticket';
    const ticketPayload = {
      ticketId: parsed.ticketId,
      queueId: action === 'close_ticket' ? null : targetQueueId || null,
      userId: action === 'close_ticket' ? null : targetUserId || null,
      status: ticketStatus,
      chatgptStatus: false,
      typebotStatus: false,
      dialogflowStatus: false,
      difyStatus: false,
      n8nStatus: false,
    };

    if (parsed.ticketId && canExecuteAction(actions, actionKey)) {
      try {
        const candidateUserIds = action === 'close_ticket'
          ? ['']
          : Array.from(new Set([targetUserId, ...ruleUserIds(rule)].filter(Boolean)));
        if (candidateUserIds.length === 0) candidateUserIds.push('');
        let state = {};

        for (const candidateUserId of candidateUserIds) {
          const candidatePayload = {
            ...ticketPayload,
            userId: action === 'close_ticket' ? null : candidateUserId || null,
            status: action === 'close_ticket' ? 'closed' : candidateUserId ? 'open' : 'pending',
          };
          result.ticket = await zpro.updateTicketAssignment(candidatePayload);
          const verified = await verifyTicketState(zpro, parsed.ticketId, candidatePayload);
          result.ticket_verification = verified.verification;
          state = verified.state;
          if (verified.matched) {
            targetUserId = candidateUserId;
            Object.assign(ticketPayload, candidatePayload);
            break;
          }
        }

        result.ticket_effective_user_id = state.userId;
        result.ticket_effective_queue_id = state.queueId;
        result.ticket_effective_status = state.status;
        result.ticket_verified = ticketStateMatches(state, ticketPayload);
        result.user_id = targetUserId || null;
        if (!result.ticket_verified) {
          throw new Error(
            `Z-PRO respondeu, mas o ticket ${parsed.ticketId} permaneceu com usuario=${state.userId || 'vazio'}, fila=${state.queueId || 'vazia'} e status=${state.status || 'vazio'}.`,
          );
        }
      } catch (err) {
        result.ticket_error = err.message || String(err);
        await recordAiActionFailure({
          integration,
          lead,
          action,
          step: 'ticket_update_or_verification',
          err,
          extra: sanitizeObject(ticketPayload),
        });
      }
    } else if (parsed.ticketId) {
      result.ticket_error = `Acao ${actionKey} desabilitada`;
    } else {
      result.ticket_error = 'Payload sem ticketId';
    }

    if (action === 'handoff' && !result.ticket_verified) {
      try {
        lead = await resumeLeadAiAfterFailedHandoff({
          lead,
          parsed,
          error: result.ticket_error,
        });
        result.local_ai_stopped = false;
      } catch (err) {
        result.local_ai_stop_error = err.message || String(err);
      }
    }
  }

  if (action === 'move_stage' || action === 'handoff' || action === 'close_ticket') {
    const canMove = canExecuteAction(actions, 'update_opportunity');
    const existingOpportunityUserId = opportunity?.assigned_external_user_id
      || lead.assigned_external_user_id
      || parsed.assignedExternalUserId
      || '';
    const mirroredUserId = action === 'handoff'
      ? result.ticket_verified ? targetUserId : existingOpportunityUserId
      : existingOpportunityUserId;

    try {
      opportunity = await ensureLocalOpportunityForAction({
        integration,
        lead,
        opportunity,
        pipelineId: targetPipelineId,
        stageId: targetStageId,
        assignedExternalUserId: mirroredUserId || null,
        externalTicketId: parsed.ticketId || null,
      });

      if (opportunity && (targetPipelineId || targetStageId || mirroredUserId)) {
        opportunity = await updateLocalOpportunityStage({
          opportunity,
          pipelineId: targetPipelineId,
          stageId: targetStageId,
          assignedExternalUserId: mirroredUserId || opportunity.assigned_external_user_id || null,
          rawPatch: {
            ai_last_route_at: new Date().toISOString(),
            ai_last_route_reason: decision.reason || '',
            ai_last_route_rule_id: rule?.id || null,
            ai_last_route_target_user_id: targetUserId || null,
            ai_ticket_assignment_verified: result.ticket_verified,
            ai_ticket_assignment_error: result.ticket_error || null,
          },
        });
      }
    } catch (err) {
      result.opportunity_error = err.message || String(err);
      await recordAiActionFailure({
        integration,
        lead,
        action,
        step: 'local_opportunity_route',
        err,
        extra: {
          pipeline_id: targetPipelineId || null,
          stage_id: targetStageId || null,
          user_id: mirroredUserId || null,
          rule_id: rule?.id || null,
        },
      });
    }

    try {
      let externalOpportunityId = getOpportunityExternalId(opportunity);
      let createdExternalAtTarget = false;
      if (!externalOpportunityId && canExecuteAction(actions, 'create_opportunity') && targetPipelineId && targetStageId) {
        const created = await createExternalOpportunityForRoute({
          zpro,
          integration,
          parsed,
          lead,
          opportunity,
          pipelineId: targetPipelineId,
          stageId: targetStageId,
          userId: mirroredUserId,
          reason: decision.reason,
        });
        externalOpportunityId = created.externalOpportunityId;
        result.opportunity = created.result;
        createdExternalAtTarget = true;
      }

      if (!createdExternalAtTarget && canMove && externalOpportunityId && targetPipelineId && targetStageId) {
        result.opportunity = await zpro.moveOpportunity({
          opportunityId: externalOpportunityId,
          name: opportunity?.title,
          value: opportunity?.value,
          status: 'open',
          pipelineId: targetPipelineId,
          stageId: targetStageId,
          responsibleId: mirroredUserId || undefined,
          description: decision.reason || undefined,
        });
      }

      if (opportunity && result.opportunity) {
        opportunity = await updateLocalOpportunityStage({
          opportunity,
          pipelineId: targetPipelineId,
          stageId: targetStageId,
          assignedExternalUserId: mirroredUserId || opportunity.assigned_external_user_id || null,
          rawPatch: {
            ai_last_route_external_result: sanitizeObject(result.opportunity?.data || {}),
          },
        });
      }
    } catch (err) {
      let recovered = false;
      let finalError = err;
      if (
        externalOpportunityCanBeRecreated(err)
        && canExecuteAction(actions, 'create_opportunity')
        && targetPipelineId
        && targetStageId
      ) {
        try {
          const replacement = await createExternalOpportunityForRoute({
            zpro,
            integration,
            parsed,
            lead,
            opportunity,
            pipelineId: targetPipelineId,
            stageId: targetStageId,
            userId: mirroredUserId,
            reason: `${decision.reason || 'Rota da IA'} | recuperacao de oportunidade externa invalida`,
          });
          result.opportunity = replacement.result;
          result.opportunity_recreated = true;
          result.previous_external_opportunity_id = getOpportunityExternalId(opportunity) || null;
          opportunity = {
            ...opportunity,
            external_opportunity_id: replacement.externalOpportunityId || opportunity?.external_opportunity_id,
          };
          recovered = true;
        } catch (repairError) {
          finalError = repairError;
        }
      }

      if (!recovered) {
        result.opportunity_error = finalError.message || String(finalError);
        await recordAiActionFailure({
          integration,
          lead,
          action,
          step: 'external_opportunity_route',
          err: finalError,
          extra: {
            original_error: err.message || String(err),
            external_opportunity_id: getOpportunityExternalId(opportunity) || null,
            pipeline_id: targetPipelineId || null,
            stage_id: targetStageId || null,
            user_id: mirroredUserId || null,
            rule_id: rule?.id || null,
          },
        });
      }
    }
  }

  result.executed = Boolean(result.local_ai_stopped || result.opportunity || result.ticket_verified || action === 'stop_ai');

  await insertLeadEvent({
    tenantId: integration.tenant_id,
    leadId: lead.id,
    eventType: 'ai_action_executed',
    summary: `Acao da IA: ${action}`,
    payload: sanitizeObject({ decision, result }),
  });

  await rememberTicketContext({
    tenantId: integration.tenant_id,
    integrationId: integration.id,
    leadId: lead.id,
    ticketId: parsed.ticketId,
    role: 'system',
    content: `Acao executada: ${action}. Motivo: ${decision.reason || 'sem motivo informado'}`,
    eventType: 'ai_action_executed',
    metadata: sanitizeObject(result),
  });

  return result;
}

export async function maybeSendAiReply({ zpro, integration, agent, actions, parsed, lead, leadMetadata, opportunity }) {
  if (!shouldRunLiveAi(agent)) {
    await insertLeadEvent({
      tenantId: integration.tenant_id,
      leadId: lead.id,
      eventType: 'ai_response_skipped',
      summary: 'IA nao respondeu porque o modo seguro esta ativo ou o backend nao esta em live.',
      payload: {
        app_mode: process.env.APP_MODE || 'live',
        safe_mode: agent?.settings?.safe_mode,
        agent_id: agent?.id || null,
      },
    });
    return { skippedReason: 'safe_mode_or_backend_not_live' };
  }

  const blockReason = ticketAutomationBlockReason(parsed, leadMetadata);
  if (blockReason) {
    await markLeadAiStopped({
      lead,
      parsed,
      reason: blockReason,
      status: leadStopStatusFor(blockReason),
    });
    if (
      blockReason === 'post_close_acknowledgement'
      && parsed.ticketId
      && canExecuteAction(actions, 'close_ticket')
    ) {
      try {
        const closeResult = await zpro.updateTicketAssignment({
          ticketId: parsed.ticketId,
          status: 'closed',
          chatgptStatus: false,
          typebotStatus: false,
          dialogflowStatus: false,
          difyStatus: false,
          n8nStatus: false,
        });
        await insertLeadEvent({
          tenantId: integration.tenant_id,
          leadId: lead.id,
          eventType: 'post_close_acknowledgement_closed',
          summary: 'Novo ticket de confirmacao encerrado sem reativar a IA.',
          payload: {
            ticket_id: parsed.ticketId,
            endpoint: closeResult.endpoint,
          },
        });
      } catch (err) {
        await recordAiActionFailure({
          integration,
          lead,
          action: 'close_ticket',
          step: 'post_close_acknowledgement',
          err,
          extra: { ticket_id: parsed.ticketId },
        });
      }
    }
    await insertLeadEvent({
      tenantId: integration.tenant_id,
      leadId: lead.id,
      eventType: 'ai_response_skipped',
      summary: 'IA nao respondeu porque o ticket nao esta pendente para automacao.',
      payload: {
        ticket_status: parsed.ticketStatus,
        reason: blockReason,
      },
    });
    return { skippedReason: blockReason };
  }

  const perfStartedAt = Date.now();
  const perf = { started_at: new Date(perfStartedAt).toISOString() };
  const markPerf = (key) => { perf[key] = Date.now() - perfStartedAt; };
  let failedStep = 'context_and_decision';
  try {
    const [context, routingRules] = await Promise.all([
      loadTicketContext({
        tenantId: integration.tenant_id,
        leadId: lead.id,
        ticketId: parsed.ticketId,
      }),
      loadStageRoutingRules(integration),
    ]);
    markPerf('context_and_rules_ms');

    if (contextShowsAiHandoff(context)) {
      await markLeadAiStopped({
        lead,
        parsed,
        reason: 'ai_handoff_already_sent',
        status: 'transferred',
        extra: {
          action: 'handoff',
        },
      });
      await insertLeadEvent({
        tenantId: integration.tenant_id,
        leadId: lead.id,
        eventType: 'ai_response_skipped',
        summary: 'IA nao respondeu porque ja tinha encaminhado este ticket.',
        payload: {
          ticket_id: parsed.ticketId,
          reason: 'ai_handoff_already_sent',
        },
      });
      return { skippedReason: 'ai_handoff_already_sent', perf };
    }

    const settings = agent.settings || {};
    const spamPolicy = settings.spam_policy || {};
    const spamWindowMinutes = Number(spamPolicy.window_minutes || 3);
    const spamMaxMessages = Number(spamPolicy.max_messages || 5);
    const spamBurstCount = recentUserBurstCount(context, spamWindowMinutes);
    const spamTotalCount = recentUserMessageCount(context, spamWindowMinutes);
    const spamRisk = spamBurstCount >= spamMaxMessages;
    const schedulePolicy = normalizedSchedulePolicy(settings.schedule_policy);
    const scheduleAutomationEnabled = Boolean(
      schedulePolicy.enabled && canExecuteAction(actions, 'schedule_appointment')
    );
    const wantsHuman = humanRequestDetected(parsed.text);
    const wantsClose = explicitCloseIntent({ parsed, context });
    let reply = '';
    let decision = null;
    let appointmentResult = null;
    if (parsed.isAudio) {
      const audioDecision = audioReplyFor(agent, leadMetadata);
      reply = audioDecision.shouldReply ? audioDecision.text : '';
      await maybeTransferAudioTicket({ zpro, agent, actions, parsed, lead, leadMetadata, integration });
      decision = {
        reply,
        action: audioDecision.shouldTransfer ? 'handoff' : 'reply',
        reason: parsed.isAudio ? 'audio recebido' : '',
      };
    } else if (wantsHuman) {
      const requestedHandoff = humanHandoffDecisionForRequest({
        agent,
        integration,
        routingRules,
        parsed,
        context,
      });
      decision = requestedHandoff.decision;
      reply = decision.reply;
    } else if (wantsClose) {
      const refusalRule = explicitRefusalIntent(parsed.text)
        ? findRefusalRoutingRule(routingRules)
        : null;
      decision = {
        reply: closingReply(lead, parsed),
        action: canExecuteAction(actions, 'close_ticket') ? 'close_ticket' : 'stop_ai',
        pipeline_id: refusalRule?.external_pipeline_id || '',
        stage_id: refusalRule?.external_stage_id || '',
        queue_id: refusalRule?.external_queue_id || '',
        user_id: '',
        reason: 'Cliente pediu explicitamente o encerramento',
        confidence: 1,
      };
      reply = decision.reply;
    } else if (spamRisk) {
      decision = {
        reply: defaultHandoffMessage(agent),
        action: 'handoff',
        pipeline_id: '',
        stage_id: '',
        queue_id: integration.sales_queue_id || '',
        user_id: '',
        reason: 'Muitas mensagens em pouco tempo',
        confidence: 1,
      };
      reply = decision.reply;
    } else if (scheduleAutomationEnabled && pendingAppointmentDecisionFromContext(context)) {
      const selectedOption = selectedAppointmentOptionFromContext(context, parsed.text);
      decision = {
        reply: '',
        action: 'reply',
        pipeline_id: '',
        stage_id: '',
        queue_id: '',
        user_id: '',
        reason: selectedOption
          ? 'Cliente escolheu um horario validado pelo backend'
          : 'Cliente continua escolhendo data ou horario',
        confidence: 1,
        appointment_intent: true,
        appointment_confirmed: Boolean(selectedOption),
        appointment_date: selectedOption?.date || '',
        appointment_time: selectedOption?.time || '',
      };

      const appointmentStartedAt = Date.now();
      const scheduled = await applyAppointmentWorkflow({
        zpro,
        agent,
        actions,
        parsed,
        lead,
        decision,
        routingRules,
        context,
      });
      perf.zpro_appointment_ms = Date.now() - appointmentStartedAt;
      decision = scheduled.decision;
      appointmentResult = scheduled.appointment;
      reply = decision.reply;

      await insertLeadEvent({
        tenantId: integration.tenant_id,
        leadId: lead.id,
        eventType: decision.appointment_created ? 'zpro_appointment_created' : 'zpro_appointment_pending',
        summary: decision.appointment_created
          ? 'Agendamento criado no Z-PRO.'
          : 'Agendamento aguardando data ou horario disponivel.',
        payload: sanitizeObject({ decision, appointment: appointmentResult }),
      });
    } else {
      const decisionStartedAt = Date.now();
      decision = await generateAiDecision({ agent, actions, parsed, lead, context, routingRules, spamRisk });
      perf.openai_decision_ms = Date.now() - decisionStartedAt;
      const appointmentIntent = appointmentIntentDetected({ parsed, context });
      decision.appointment_intent = appointmentIntent;
      if (appointmentIntent) {
        const selectedOption = selectedAppointmentOptionFromContext(context, parsed.text);
        if (selectedOption) {
          decision.appointment_confirmed = true;
          decision.appointment_date = selectedOption.date;
          decision.appointment_time = selectedOption.time;
          decision.reason = decision.reason || 'Cliente escolheu um horario validado pelo backend';
        }
      } else {
        if (normalizeId(decision.action) === 'schedule_appointment') decision.action = 'reply';
        decision.appointment_confirmed = false;
        decision.appointment_date = '';
        decision.appointment_time = '';
      }

      let decisionRule = findRoutingRule(decision || {}, routingRules);
      if (!decision.appointment_intent && isAppointmentRoutingRule(decisionRule)) {
        decisionRule = null;
        decision.pipeline_id = '';
        decision.stage_id = '';
        decision.queue_id = '';
        if (normalizeId(decision.action) === 'move_stage') decision.action = 'reply';
        decision.reason = `${decision.reason || 'Decisao ajustada'} | etapa de agenda bloqueada sem pedido explicito`;
      }
      const routeSecondPassEnabled = routingRules.length > 0;
      perf.openai_route_second_pass_enabled = routeSecondPassEnabled;
      if (routeSecondPassEnabled && shouldRunRoutingClassifier({
        routingRules,
        decisionRule,
        appointmentIntent: decision.appointment_intent,
      })) {
        const classifierStartedAt = Date.now();
        try {
          const routeChoice = await classifyRoutingRuleWithAi({
            agent,
            parsed,
            lead,
            context,
            routingRules,
            currentDecision: decision,
          });
          perf.openai_route_classifier_ms = Date.now() - classifierStartedAt;

          await insertLeadEvent({
            tenantId: integration.tenant_id,
            leadId: lead.id,
            eventType: 'ai_route_classified',
            summary: routeChoice.rule
              ? `Regra escolhida: ${routeChoice.rule.stage_name || routeChoice.rule.external_stage_id}`
              : 'Nenhuma regra de etapa escolhida',
            payload: sanitizeObject({
              classification: routeChoice.classification,
              rule_id: routeChoice.rule?.id || null,
              pipeline_id: routeChoice.rule?.external_pipeline_id || null,
              stage_id: routeChoice.rule?.external_stage_id || null,
              queue_id: routeChoice.rule?.external_queue_id || null,
            }),
          });

          logInfo('zpro.webhook.ai_route_classified', {
            integrationId: integration.id,
            tenantId: integration.tenant_id,
            leadId: lead.id,
            ticketId: parsed.ticketId || null,
            classification: routeChoice.classification,
            ruleId: routeChoice.rule?.id || null,
            pipelineId: routeChoice.rule?.external_pipeline_id || null,
            stageId: routeChoice.rule?.external_stage_id || null,
            queueId: routeChoice.rule?.external_queue_id || null,
          });

          if (routeChoice.rule) {
            decisionRule = routeChoice.rule;
            const classifiedAction = routeChoice.rule.close_ticket_on_match
              ? 'close_ticket'
              : routeChoice.rule.stop_ai_after_match
                ? 'handoff'
                : ['handoff', 'move_stage', 'close_ticket'].includes(routeChoice.classification.action)
                  ? routeChoice.classification.action
                  : 'move_stage';
            const classifiedReply = String(routeChoice.classification.reply || '').trim();
            decision = {
              ...decision,
              action: classifiedAction,
              reason: routeChoice.classification.reason || decision.reason || '',
              route_reply: classifiedReply,
              reply: isStopAction(classifiedAction)
                ? routeChoice.rule.handoff_message || classifiedReply || defaultHandoffMessage(agent)
                : decision.reply || routeChoice.classification.reply || '',
              confidence: Math.max(Number(decision.confidence || 0), Number(routeChoice.classification.confidence || 0)),
            };
          }
        } catch (routeError) {
          perf.openai_route_classifier_ms = Date.now() - classifierStartedAt;
          perf.openai_route_classifier_failed = true;
          logWarn('zpro.webhook.ai_route_classifier_failed', {
            integrationId: integration.id,
            tenantId: integration.tenant_id,
            leadId: lead.id,
            ticketId: parsed.ticketId || null,
            error: routeError.message || String(routeError),
          });
          await insertLeadEvent({
            tenantId: integration.tenant_id,
            leadId: lead.id,
            eventType: 'ai_route_classifier_failed',
            summary: 'Classificador de etapa falhou; fluxo principal preservado.',
            payload: sanitizeObject({ error: routeError.message || String(routeError) }),
          });
        }
      }

      if (decisionRule) {
        const hadAppointmentIntent = decision.appointment_intent === true;
        decision = applyRoutingRuleToDecision(decision, decisionRule, agent);
        if (hadAppointmentIntent && isStopAction(decision.action)) {
          decision = {
            ...decision,
            appointment_intent: false,
            appointment_confirmed: false,
            appointment_options: [],
            reply: decisionRule.handoff_message
              || decision.route_reply
              || defaultHandoffMessage(agent),
          };
        }
      }
      if (wantsHuman && (!decision.action || decision.action === 'reply')) {
        decision = {
          ...decision,
          reply: defaultHandoffMessage(agent),
          action: 'handoff',
          reason: decision.reason || 'Cliente pediu atendimento humano',
          confidence: Math.max(Number(decision.confidence || 0), 0.9),
        };
      }

      if (decision.appointment_intent && !scheduleAutomationEnabled) {
        const routed = appointmentWithoutAutomationDecision({
          decision,
          routingRules,
          agent,
          integration,
          actions,
        });
        decision = routed.decision;
        decisionRule = routed.rule || decisionRule;
        appointmentResult = routed.appointment;
      }

      if (decision.appointment_intent && scheduleAutomationEnabled) {
        const appointmentStartedAt = Date.now();
        const scheduled = await applyAppointmentWorkflow({
          zpro,
          agent,
          actions,
          parsed,
          lead,
          decision,
          routingRules,
          context,
        });
        perf.zpro_appointment_ms = Date.now() - appointmentStartedAt;
        decision = scheduled.decision;
        decisionRule = scheduled.rule || findRoutingRule(decision || {}, routingRules);
        appointmentResult = scheduled.appointment;

        await insertLeadEvent({
          tenantId: integration.tenant_id,
          leadId: lead.id,
          eventType: decision.appointment_created ? 'zpro_appointment_created' : 'zpro_appointment_pending',
          summary: decision.appointment_created
            ? 'Agendamento criado no Z-PRO.'
            : 'Agendamento aguardando data ou horario disponivel.',
          payload: sanitizeObject({
            decision,
            appointment: appointmentResult,
          }),
        });
      }
      reply = decision.reply;
    }

    let decisionRule = findRoutingRule(decision || {}, routingRules);
    if (!decisionRule && isStopAction(decision?.action)) {
      decisionRule = findRoutingRule(
        {},
        routingRules,
        currentOpportunityRoutingFallback({ opportunity, integration, parsed, decision }),
      );
      if (decisionRule) {
        decision = applyRoutingRuleToDecision(decision, decisionRule, agent);
      }
    }

    decision = normalizeAiDecisionForWorkflow({
      decision,
      actions,
      rule: decisionRule,
      agent,
      parsed,
      lead,
      context,
      spamRisk,
    });
    reply = decision.reply || reply;

    if (decisionRule && isStopAction(decision?.action) && !decision.appointment_created) {
      if (decision.action === 'handoff' && decisionRule.handoff_message) {
        reply = decisionRule.handoff_message;
      }
      if (!reply) {
        reply = decision.action === 'close_ticket'
          ? closingReply(lead, parsed)
          : defaultHandoffMessage(agent);
      }
      decision.reply = reply;
    }

    reply = stripEmoji(reply);
    decision.reply = reply;
    decision.spam = {
      risk: spamRisk,
      burst_count: spamBurstCount,
      total_recent_count: spamTotalCount,
      window_minutes: spamWindowMinutes,
      max_messages: spamMaxMessages,
    };

    if (!reply) return { skippedReason: 'empty_ai_reply', perf };

    let leadForAction = lead;
    let preStopError = null;
    if (decision && isStopAction(decision.action)) {
      try {
        leadForAction = await markLeadAiStopped({
          lead,
          parsed,
          reason: decision.action === 'close_ticket' ? 'ticket_closed_by_ai' : 'human_handoff_by_ai',
          status: leadStopStatusFor(decision.action),
          extra: {
            action: decision.action,
            pipeline_id: decision.pipeline_id || null,
            stage_id: decision.stage_id || null,
            queue_id: decision.queue_id || null,
            user_id: decision.user_id || null,
            pre_send: true,
          },
        });
      } catch (err) {
        preStopError = err.message || String(err);
        await recordAiActionFailure({
          integration,
          lead,
          action: decision.action,
          step: 'local_ai_stop_pre_send',
          err,
        });
      }
    }

    const sendStartedAt = Date.now();
    failedStep = 'send_message';
    const result = await zpro.sendMessage({
      number: lead.phone || parsed.phone,
      body: reply,
      ticketId: parsed.ticketId || undefined,
      channelId: parsed.whatsappId || parsed.channelId,
      requireTicket: isOfficialWhatsAppChannel(parsed),
      externalKey: messageExternalKey('ai_reply', integration.id, parsed.eventId),
      validateNumber: !isOfficialWhatsAppChannel(parsed),
    });
    perf.zpro_send_message_ms = Date.now() - sendStartedAt;
    failedStep = 'record_reply_and_execute_action';

    await insertLeadEvent({
      tenantId: integration.tenant_id,
      leadId: lead.id,
      eventType: 'ai_response_sent',
      summary: reply,
      payload: {
        agent_id: agent.id,
        endpoint: result.endpoint || 'base',
        data: result,
      },
    });

    await rememberTicketContext({
      tenantId: integration.tenant_id,
      integrationId: integration.id,
      leadId: lead.id,
      ticketId: parsed.ticketId,
      role: 'assistant',
      content: reply,
      eventType: 'ai_response_sent',
      metadata: {
        agent_id: agent.id,
        decision,
      },
    });

    let actionResult = null;
    if (decision && decision.action && decision.action !== 'reply') {
      try {
        const actionStartedAt = Date.now();
        actionResult = await executeAiDecision({
          zpro,
          integration,
          agent,
          actions,
          parsed,
          lead: leadForAction,
          opportunity,
          decision,
          routingRules,
        });
        perf.action_execution_ms = Date.now() - actionStartedAt;
        if (preStopError) actionResult.local_ai_stop_error = preStopError;
        const stopCompleted = decision.action === 'stop_ai' || actionResult?.ticket_verified === true;
        if (!preStopError && isStopAction(decision.action) && actionResult && stopCompleted) {
          actionResult.local_ai_stopped = true;
        }
      } catch (actionError) {
        actionResult = {
          executed: decision.action === 'stop_ai' && !preStopError,
          action: decision.action,
          local_ai_stopped: decision.action === 'stop_ai' && !preStopError,
          local_ai_stop_error: preStopError,
          ticket_error: null,
          opportunity_error: null,
        };
        await insertLeadEvent({
          tenantId: integration.tenant_id,
          leadId: lead.id,
          eventType: 'ai_action_failed',
          summary: 'Falha ao executar acao decidida pela IA.',
          payload: {
            decision,
            error: actionError.message || String(actionError),
            attempts: actionError.attempts,
          },
        });

        logWarn('zpro.webhook.ai_action_failed', {
          integrationId: integration.id,
          tenantId: integration.tenant_id,
          leadId: lead.id,
          action: decision.action,
          error: actionError.message || String(actionError),
        });
      }
    }

    markPerf('total_ms');
    logInfo('zpro.webhook.ai_perf', {
      integrationId: integration.id,
      tenantId: integration.tenant_id,
      leadId: lead.id,
      ticketId: parsed.ticketId || null,
      action: decision?.action || null,
      routeRuleId: actionResult?.rule_id || null,
      timings: perf,
      spam: decision?.spam || null,
    });

    return { reply, result, decision, actionResult, appointmentResult, perf };
  } catch (err) {
    markPerf('total_ms');
    await insertLeadEvent({
      tenantId: integration.tenant_id,
      leadId: lead.id,
      eventType: 'ai_response_failed',
      summary: 'Falha ao gerar ou enviar resposta da IA.',
      payload: {
        agent_id: agent?.id || null,
        step: failedStep,
        error_code: err.code || null,
        configuration_hint: err.configurationHint || null,
        error: err.message || String(err),
        attempts: err.attempts,
      },
    });

    logWarn('zpro.webhook.ai_response_failed', {
      integrationId: integration.id,
      tenantId: integration.tenant_id,
      leadId: lead.id,
      ticketId: parsed.ticketId || null,
      step: failedStep,
      errorCode: err.code || null,
      configurationHint: err.configurationHint || null,
      timings: perf,
      error: err.message || String(err),
    });

    return { error: err.message || String(err), errorCode: err.code || null, failedStep, perf };
  }
}

function getExternalOpportunityId(data = {}) {
  return pickValue(data, [
    'id',
    'opportunityId',
    'opportunity_id',
    'data.id',
    'data.opportunityId',
    'data.opportunity_id',
    'data.opportunity.id',
    'data.opportunity.opportunityId',
    'data.card.id',
    'data.card.opportunityId',
    'data.kanban.id',
    'opportunity.id',
    'card.id',
    'kanban.id',
  ]);
}

function externalOpportunityRecoverySnapshot(item = {}) {
  return {
    id: getExternalOpportunityId(item),
    ticketId: pickValue(item, [
      'ticketId', 'ticket_id', 'ticket.id', 'externalTicketId', 'external_ticket_id',
      'data.ticketId', 'data.ticket_id', 'raw_data.ticketId', 'raw_data.ticket_id',
    ]),
    contactId: pickValue(item, [
      'contactId', 'contact_id', 'contact.id', 'customerId', 'customer_id', 'customer.id',
      'lead.contactId', 'lead.contact_id',
    ]),
    phone: onlyDigits(pickValue(item, [
      'number', 'phone', 'contactNumber', 'contact_number', 'contact.number', 'contact.phone',
      'customer.number', 'customer.phone', 'lead.phone',
    ])),
    pipelineId: pickValue(item, ['pipelineId', 'pipeline_id', 'pipeline.id', 'kanbanId', 'kanban_id']),
    raw: item,
  };
}

async function findExistingExternalOpportunity(zpro, { parsed = {}, lead = {}, pipelineId = '' } = {}) {
  const phone = onlyDigits(lead.phone || parsed.phone);
  const contactId = String(parsed.contactId || lead.external_contact_id || '');
  const ticketId = String(parsed.ticketId || lead.external_ticket_id || '');
  const response = await zpro.listOpportunities({
    limit: 500,
    pipelineId: pipelineId || undefined,
    searchParam: phone || contactId || ticketId || undefined,
    number: phone || undefined,
    contactId: contactId || undefined,
    ticketId: ticketId || undefined,
  });
  const candidates = normalizeExternalList(response.data)
    .map(externalOpportunityRecoverySnapshot)
    .filter((item) => item.id)
    .map((item) => {
      let score = 0;
      if (ticketId && String(item.ticketId || '') === ticketId) score += 100;
      if (contactId && String(item.contactId || '') === contactId) score += 50;
      if (phone && item.phone === phone) score += 25;
      if (pipelineId && String(item.pipelineId || '') === String(pipelineId)) score += 5;
      return { ...item, score };
    })
    .filter((item) => item.score >= 25)
    .sort((left, right) => right.score - left.score);

  return candidates[0]
    ? { ...candidates[0], endpoint: response.endpoint }
    : null;
}

async function linkRecoveredExternalOpportunity({ opportunity, recovered, rawPatch = {} }) {
  if (!opportunity?.id || !recovered?.id) return opportunity;
  const now = new Date().toISOString();
  const rawData = {
    ...(opportunity.raw_data || {}),
    zpro_opportunity_recovered_at: now,
    zpro_opportunity_recovery_endpoint: recovered.endpoint || null,
    zpro_opportunity_recovery_snapshot: sanitizeObject(recovered.raw || {}),
    zpro_create_error: null,
    zpro_create_retry_after: null,
    ...rawPatch,
  };
  const { data, error } = await supabaseAdmin
    .from('crm_ai_opportunities')
    .update({
      external_opportunity_id: String(recovered.id),
      raw_data: rawData,
      updated_at: now,
    })
    .eq('id', opportunity.id)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export function externalOpportunityCreateRetryAllowed(opportunity = {}, now = new Date()) {
  if (getOpportunityExternalId(opportunity)) return false;
  const retryAfter = new Date(opportunity.raw_data?.zpro_create_retry_after || 0);
  return Number.isNaN(retryAfter.getTime()) || retryAfter <= now;
}

async function recordExternalOpportunityCreateFailure(opportunity, err) {
  if (!opportunity?.id) return opportunity;
  const now = new Date();
  const failureCount = Number(opportunity.raw_data?.zpro_create_failure_count || 0) + 1;
  const retryMinutes = Math.min(60, 15 * failureCount);
  const rawData = {
    ...(opportunity.raw_data || {}),
    zpro_create_attempted_at: now.toISOString(),
    zpro_create_error: err.message || String(err),
    zpro_create_failure_count: failureCount,
    zpro_create_retry_after: new Date(now.getTime() + retryMinutes * 60 * 1000).toISOString(),
  };
  const { data, error } = await supabaseAdmin
    .from('crm_ai_opportunities')
    .update({ raw_data: rawData, updated_at: now.toISOString() })
    .eq('id', opportunity.id)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function maybeCreateExternalOpportunity({ zpro, integration, actions, parsed, lead, opportunity }) {
  if (!integration.auto_create_opportunity) return null;
  if (!integration.pipeline_id || !integration.initial_stage_id) return null;
  if (!canExecuteAction(actions, 'create_opportunity')) return null;
  if (!externalOpportunityCreateRetryAllowed(opportunity)) return { opportunity, deferred: true };

  let updatedOpportunity = opportunity;

  try {
    const result = await zpro.createOpportunity({
      number: lead.phone || parsed.phone,
      contactName: lead.name || parsed.name || lead.phone || parsed.phone,
      name: opportunity?.title || `${lead.name || 'Lead ' + lead.phone} - WhatsApp`,
      value: opportunity?.value ?? 0,
      status: 'open',
      pipelineId: opportunity?.pipeline_id || integration.pipeline_id,
      stageId: opportunity?.stage_id || integration.initial_stage_id,
      responsibleId: parsed.assignedExternalUserId || undefined,
      description: parsed.text || 'Oportunidade criada automaticamente pela Central IA CRM.',
      validateNumber: !isOfficialWhatsAppChannel(parsed),
    });

    const externalOpportunityId = getExternalOpportunityId(result.data);
    if (opportunity?.id) {
      const rawData = {
        ...(opportunity.raw_data || {}),
        zpro_create_attempted_at: new Date().toISOString(),
        zpro_create_endpoint: result.endpoint,
        zpro_create_response: sanitizeObject(result.data),
        zpro_create_error: null,
        zpro_create_retry_after: null,
        zpro_create_failure_count: 0,
      };
      const updatePayload = {
        raw_data: rawData,
        updated_at: new Date().toISOString(),
      };
      if (externalOpportunityId) {
        updatePayload.external_opportunity_id = String(externalOpportunityId);
      }

      const { data, error } = await supabaseAdmin
        .from('crm_ai_opportunities')
        .update(updatePayload)
        .eq('id', opportunity.id)
        .select('*')
        .single();
      if (error) throw error;
      updatedOpportunity = data;
    }

    await insertLeadEvent({
      tenantId: integration.tenant_id,
      leadId: lead.id,
      eventType: 'zpro_opportunity_created',
      summary: 'Oportunidade criada no Z-PRO.',
      payload: {
        endpoint: result.endpoint,
        external_opportunity_id: externalOpportunityId,
        data: sanitizeObject(result.data),
      },
    });

    return {
      ...result,
      externalOpportunityId,
      opportunity: updatedOpportunity,
    };
  } catch (err) {
    try {
      const recovered = zproRequiresSession(err) ? null : await findExistingExternalOpportunity(zpro, {
        parsed,
        lead,
        pipelineId: integration.pipeline_id,
      });
      if (recovered?.id) {
        updatedOpportunity = await linkRecoveredExternalOpportunity({
          opportunity,
          recovered,
          rawPatch: {
            zpro_create_attempted_at: new Date().toISOString(),
            zpro_create_recovered_from_error: err.message || String(err),
          },
        });
        await insertLeadEvent({
          tenantId: integration.tenant_id,
          leadId: lead.id,
          eventType: 'zpro_opportunity_recovered',
          summary: 'Oportunidade existente no Z-PRO foi vinculada ao ticket.',
          payload: {
            external_opportunity_id: recovered.id,
            endpoint: recovered.endpoint,
            original_error: err.message || String(err),
          },
        });
        return {
          endpoint: recovered.endpoint,
          data: recovered.raw,
          externalOpportunityId: String(recovered.id),
          opportunity: updatedOpportunity,
          recovered: true,
        };
      }
    } catch (recoveryError) {
      logWarn('zpro.webhook.opportunity_recovery_failed', {
        integrationId: integration.id,
        tenantId: integration.tenant_id,
        leadId: lead.id,
        error: recoveryError.message || String(recoveryError),
      });
    }

    try {
      updatedOpportunity = await recordExternalOpportunityCreateFailure(opportunity, err);
    } catch (stateError) {
      logWarn('zpro.webhook.opportunity_failure_state_failed', {
        integrationId: integration.id,
        leadId: lead.id,
        error: stateError.message || String(stateError),
      });
    }
    await insertLeadEvent({
      tenantId: integration.tenant_id,
      leadId: lead.id,
      eventType: 'zpro_opportunity_create_failed',
      summary: 'Falha ao criar oportunidade no Z-PRO.',
      payload: {
        error: err.message || String(err),
        attempts: err.attempts,
        pipeline_id: integration.pipeline_id,
        stage_id: integration.initial_stage_id,
      },
    });

    logWarn('zpro.webhook.opportunity_create_failed', {
      integrationId: integration.id,
      tenantId: integration.tenant_id,
      leadId: lead.id,
      error: err.message || String(err),
      errorCode: err.code || null,
      configurationHint: err.configurationHint || null,
      ticketId: parsed.ticketId || null,
      contactId: parsed.contactId || null,
      channelId: parsed.whatsappId || parsed.channelId || null,
      pipelineId: opportunity?.pipeline_id || integration.pipeline_id,
      stageId: opportunity?.stage_id || integration.initial_stage_id,
      responsibleId: parsed.assignedExternalUserId || null,
      endpoint: err.endpoint || err.attempts?.[0]?.endpoint || null,
      zproStatus: err.zproStatus || err.status || null,
      zproError: err.zproBody?.error || null,
    });

    return { opportunity: updatedOpportunity, error: err.message || String(err) };
  }
}

export async function syncOpportunityFromTicketState({ getZpro, integration, actions, parsed, lead, opportunity }) {
  if (!opportunity?.id) return opportunity;

  const ticketStatus = normalizeId(parsed.ticketStatus);
  const ticketUserId = parsed.assignedExternalUserId || null;
  const shouldMirrorTicket =
    ticketStatus === 'open' ||
    ticketStatus === 'pending' ||
    ticketUserId;

  if (!shouldMirrorTicket) return opportunity;

  let updatedOpportunity = opportunity;
  try {
    updatedOpportunity = await updateLocalOpportunityStage({
      opportunity,
      pipelineId: opportunity.pipeline_id,
      stageId: opportunity.stage_id,
      assignedExternalUserId: ticketUserId,
      rawPatch: {
        zpro_ticket_sync_at: new Date().toISOString(),
        zpro_ticket_sync_status: parsed.ticketStatus || null,
        zpro_ticket_sync_ticket_id: parsed.ticketId || null,
        zpro_ticket_sync_queue_id: parsed.queueId || null,
        zpro_ticket_sync_user_id: ticketUserId,
      },
    });
  } catch (err) {
    await recordAiActionFailure({
      integration,
      lead,
      action: 'ticket_sync',
      step: 'local_opportunity_owner_sync',
      err,
      extra: {
        ticket_id: parsed.ticketId || null,
        user_id: ticketUserId,
      },
    });
    return opportunity;
  }

  const externalOpportunityId = getOpportunityExternalId(updatedOpportunity);
  if (!ticketUserId || !externalOpportunityId || !canExecuteAction(actions, 'update_opportunity')) {
    return updatedOpportunity;
  }

  try {
    const zpro = await getZpro();
    const result = await zpro.moveOpportunity({
      opportunityId: externalOpportunityId,
      name: updatedOpportunity.title,
      value: updatedOpportunity.value,
      status: updatedOpportunity.status || 'open',
      pipelineId: updatedOpportunity.pipeline_id || integration.pipeline_id,
      stageId: updatedOpportunity.stage_id || integration.initial_stage_id,
      responsibleId: ticketUserId,
      description: 'Responsavel sincronizado a partir do ticket.',
    });

    updatedOpportunity = await updateLocalOpportunityStage({
      opportunity: updatedOpportunity,
      pipelineId: updatedOpportunity.pipeline_id,
      stageId: updatedOpportunity.stage_id,
      assignedExternalUserId: ticketUserId,
      rawPatch: {
        zpro_ticket_sync_external_at: new Date().toISOString(),
        zpro_ticket_sync_external_result: sanitizeObject(result.data || {}),
      },
    });

    await insertLeadEvent({
      tenantId: integration.tenant_id,
      leadId: lead.id,
      eventType: 'zpro_opportunity_owner_synced',
      summary: 'Responsavel da oportunidade sincronizado com o ticket.',
      payload: {
        ticket_id: parsed.ticketId || null,
        external_opportunity_id: externalOpportunityId,
        user_id: ticketUserId,
        endpoint: result.endpoint,
      },
    });
  } catch (err) {
    let finalError = err;
    if (
      externalOpportunityCanBeRecreated(err)
      && canExecuteAction(actions, 'create_opportunity')
      && (updatedOpportunity.pipeline_id || integration.pipeline_id)
      && (updatedOpportunity.stage_id || integration.initial_stage_id)
    ) {
      try {
        const zpro = await getZpro();
        const replacement = await createExternalOpportunityForRoute({
          zpro,
          integration,
          parsed,
          lead,
          opportunity: updatedOpportunity,
          pipelineId: updatedOpportunity.pipeline_id || integration.pipeline_id,
          stageId: updatedOpportunity.stage_id || integration.initial_stage_id,
          userId: ticketUserId,
          reason: 'Oportunidade recriada ao sincronizar o responsavel do ticket.',
        });
        updatedOpportunity = {
          ...updatedOpportunity,
          external_opportunity_id: replacement.externalOpportunityId || updatedOpportunity.external_opportunity_id,
        };
        await insertLeadEvent({
          tenantId: integration.tenant_id,
          leadId: lead.id,
          eventType: 'zpro_opportunity_recreated',
          summary: 'Oportunidade externa invalida foi recriada para o ticket atual.',
          payload: {
            ticket_id: parsed.ticketId || null,
            previous_external_opportunity_id: externalOpportunityId,
            external_opportunity_id: replacement.externalOpportunityId || null,
            user_id: ticketUserId,
          },
        });
        return updatedOpportunity;
      } catch (repairError) {
        finalError = repairError;
      }
    }

    await recordAiActionFailure({
      integration,
      lead,
      action: 'ticket_sync',
      step: 'external_opportunity_owner_sync',
      err: finalError,
      extra: {
        original_error: err.message || String(err),
        ticket_id: parsed.ticketId || null,
        external_opportunity_id: externalOpportunityId,
        user_id: ticketUserId,
      },
    });
  }

  return updatedOpportunity;
}

function aiReopenCooldownMinutes() {
  return boundedNumber(process.env.AI_REOPEN_COOLDOWN_MINUTES, 15, 1, 1440);
}

function aiStateStoppedRecently(state = {}, now = Date.now()) {
  if (!state.stopped || !state.stopped_at) return false;
  const stoppedAt = new Date(state.stopped_at).getTime();
  if (!Number.isFinite(stoppedAt)) return false;
  return now - stoppedAt <= aiReopenCooldownMinutes() * 60 * 1000;
}

function leadStatusForInbound(parsed = {}, metadata = {}) {
  const ticketStatus = normalizeId(parsed.ticketStatus);
  if (ticketStatus === 'closed') return 'archived';
  if (ticketStatus === 'open') return 'transferred';
  if (metadata.ai_state?.stopped) return leadStopStatusFor(metadata.ai_state.reason);
  return 'ai_attending';
}

export function buildLeadMetadata(parsed, previous = {}, agent = null) {
  const audioCount = Number(previous?.audio_message_count || 0) + (parsed.isAudio ? 1 : 0);
  const now = new Date().toISOString();
  const previousAiState = previous?.ai_state || {};
  const previousTicketId = previousAiState.ticket_id || previous?.zpro?.ticket_id || null;
  const ticketChanged = previousTicketId && parsed.ticketId && String(previousTicketId) !== String(parsed.ticketId);
  let aiState = previousAiState;
  const ticketStatus = normalizeId(parsed.ticketStatus);

  if (ticketChanged) {
    const isClosingAcknowledgement = aiStateStoppedRecently(previousAiState)
      && closingAcknowledgementDetected(parsed.text);
    aiState = isClosingAcknowledgement
      ? {
        ...previousAiState,
        stopped: true,
        previous_reason: previousAiState.reason || null,
        reason: 'post_close_acknowledgement',
        previous_ticket_id: previousTicketId,
        ticket_id: parsed.ticketId,
        stopped_at: now,
      }
      : {
        stopped: false,
        reason: 'new_ticket_started',
        previous_reason: previousAiState.reason || null,
        previous_ticket_id: previousTicketId,
        ticket_id: parsed.ticketId,
        resumed_at: now,
      };
  } else if (parsed.ticketId && !aiState.ticket_id) {
    aiState = {
      ...aiState,
      ticket_id: parsed.ticketId,
    };
  }

  if (
    ticketStatus === 'pending'
    && previousAiState.stopped === true
    && previousAiState.reason === 'ticket_open_human'
    && parsed.fromMe !== true
  ) {
    aiState = {
      ...aiState,
      stopped: false,
      reason: 'ticket_returned_to_ai_queue',
      previous_reason: previousAiState.reason,
      ticket_id: parsed.ticketId || previousAiState.ticket_id || null,
      resumed_at: now,
    };
  }

  if (ticketStatus === 'open' || ticketStatus === 'closed') {
    aiState = {
      ...aiState,
      stopped: true,
      reason: ticketStatus === 'closed' ? 'ticket_closed' : 'ticket_open_human',
      ticket_id: parsed.ticketId || previousAiState.ticket_id || null,
      stopped_at: aiState.stopped_at || now,
    };
  }

  return {
    ...previous,
    zpro: {
      ...(previous?.zpro || {}),
      ticket_id: parsed.ticketId,
      ticket_protocol: parsed.ticketProtocol,
      ticket_status: parsed.ticketStatus,
      contact_id: parsed.contactId,
      whatsapp_id: parsed.whatsappId,
      channel_id: parsed.channelId,
      whatsapp_name: parsed.whatsappName,
      channel_name: parsed.channelName,
      channel_type: parsed.channelType,
      queue_id: parsed.queueId,
      assigned_external_user_id: parsed.assignedExternalUserId,
      assigned_external_user_name: parsed.assignedExternalUserName,
      tenant_id: parsed.rawTenantId,
      last_event_id: parsed.eventId,
      last_message_type: parsed.messageType,
      last_message_at: parsed.messageAt,
      ticket_created_at: parsed.ticketCreatedAt,
      ticket_updated_at: parsed.ticketUpdatedAt,
    },
    ai_agent_id: agent?.id || previous?.ai_agent_id || null,
    ai_agent_name: agent?.name || previous?.ai_agent_name || null,
    ai_state: aiState,
    whatsapp_id: parsed.whatsappId,
    ticket_status: parsed.ticketStatus,
    channel_name: parsed.channelName,
    channel_type: parsed.channelType,
    queue_id: parsed.queueId,
    assigned_external_user_id: parsed.assignedExternalUserId,
    assigned_external_user_name: parsed.assignedExternalUserName,
    contact_type: previous?.contact_type && previous.contact_type !== 'unknown'
      ? previous.contact_type
      : parsed.contactType,
    audio_message_count: audioCount,
    last_audio_at: parsed.isAudio ? new Date().toISOString() : previous?.last_audio_at,
    last_message_type: parsed.messageType,
    last_inbound_event_id: parsed.eventId,
  };
}

async function syncOptionalLeadColumns(lead, parsed, metadata) {
  if (!optionalLeadColumnsAvailable && Date.now() < optionalLeadColumnsNextRetryAt) return;

  try {
    const { error } = await supabaseAdmin
      .from('crm_ai_leads')
      .update({
        contact_type: metadata.contact_type || 'unknown',
        audio_message_count: metadata.audio_message_count || 0,
        last_audio_at: metadata.last_audio_at || null,
      })
      .eq('id', lead.id);

    if (error) throw error;
    optionalLeadColumnsAvailable = true;
    optionalLeadColumnsNextRetryAt = 0;
  } catch (err) {
    optionalLeadColumnsAvailable = false;
    optionalLeadColumnsNextRetryAt = Date.now() + 10 * 60 * 1000;
    logWarn('zpro.webhook.optional_columns_skipped', {
      leadId: lead.id,
      reason: 'Colunas opcionais de enriquecimento ainda nao existem. Rode a migration incremental para habilitar.',
      error: err.message || String(err),
    });
  }
}

function buildShadowDecision(parsed, metadata) {
  if (parsed.isAudio && Number(metadata.audio_message_count || 0) >= 2) {
    return {
      acao: 'transferir',
      mensagem: '',
      tipo_contato: metadata.contact_type || 'unknown',
      motivo_transferencia: 'audio',
      fila_destino: null,
      funil_destino: null,
      etapa_destino: null,
      confianca: 0.6,
      modo_seguro: true,
      observacao: 'Sugestao apenas registrada. Nenhuma acao foi executada no Z-PRO.',
    };
  }

  return {
    acao: 'ignorar',
    mensagem: '',
    tipo_contato: metadata.contact_type || 'unknown',
    motivo_transferencia: null,
    fila_destino: null,
    funil_destino: null,
    etapa_destino: null,
    confianca: 0.2,
    modo_seguro: true,
    observacao: 'Modo seguro ativo. IA ainda nao responde nem executa acoes.',
  };
}

async function findIntegrationByWebhookPublicId(webhookPublicId, { activeOnly = false } = {}) {
  let query = supabaseAdmin
    .from('crm_ai_integrations')
    .select('*')
    .eq('webhook_public_id', webhookPublicId);

  if (activeOnly) query = query.eq('active', true);

  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data;
}

function logWebhookReceived(req, webhookPublicId, payload) {
  logInfo('zpro.webhook.received', {
    release: APP_RELEASE,
    requestId: req.requestId,
    method: req.method,
    route: req.originalUrl,
    webhookPublicId,
    headers: sanitizeHeaders(req.headers),
    rawBody: getRawBodyForLog(req),
    payloadPreview: sanitizeObject(payload),
  });
}

function logWebhookResult(req, webhookPublicId, result) {
  logInfo('zpro.webhook.result', {
    release: APP_RELEASE,
    requestId: req.requestId,
    method: req.method,
    route: req.originalUrl,
    webhookPublicId,
    ...result,
  });
}

zproWebhookRouter.get('/:webhookPublicId/ping', async (req, res, next) => {
  try {
    const { webhookPublicId } = req.params;
    const integration = await findIntegrationByWebhookPublicId(webhookPublicId);

    logInfo('zpro.webhook.ping', {
      requestId: req.requestId,
      webhookPublicId,
      integrationFound: Boolean(integration),
      integrationActive: Boolean(integration?.active),
    });

    return res.json({
      ok: true,
      webhookPublicId,
      integrationFound: Boolean(integration),
      integrationActive: Boolean(integration?.active),
    });
  } catch (err) {
    next(err);
  }
});

zproWebhookRouter.post('/:webhookPublicId', async (req, res, next) => {
  try {
    const { webhookPublicId } = req.params;
    const payload = normalizePayload(req);
    const parsed = extractPayload(payload);

    const ignoredReason = webhookIgnoreReason(parsed);
    if (ignoredReason) {
      logWebhookResult(req, webhookPublicId, {
        status: 'ignored',
        reason: ignoredReason,
        externalEventId: parsed.eventId,
        ticketId: parsed.ticketId,
        channelId: parsed.channelId,
        eventType: parsed.method,
      });
      return res.json({ ok: true, ignored: ignoredReason });
    }

    logWebhookReceived(req, webhookPublicId, payload);

    const integration = await findIntegrationByWebhookPublicId(webhookPublicId, {
      activeOnly: true,
    });

    if (!integration) {
      const inactiveOrMissingIntegration = await findIntegrationByWebhookPublicId(webhookPublicId);

      logWarn('zpro.webhook.integration_not_found', {
        requestId: req.requestId,
        webhookPublicId,
        integrationFound: Boolean(inactiveOrMissingIntegration),
        integrationActive: Boolean(inactiveOrMissingIntegration?.active),
        parsed,
      });

      return res.status(404).json({
        ok: false,
        error: 'Integracao ativa nao encontrada pelo webhook_public_id',
        integrationFound: Boolean(inactiveOrMissingIntegration),
        integrationActive: Boolean(inactiveOrMissingIntegration?.active),
      });
    }

    logInfo('zpro.webhook.integration_found', {
      requestId: req.requestId,
      webhookPublicId,
      integrationId: integration.id,
      tenantId: integration.tenant_id,
      active: integration.active,
    });

    await purgeExpiredTicketContext(integration.tenant_id);

    const agentResolution = await resolveWebhookAgent(integration.tenant_id, integration.id, parsed);

    if (agentResolution.ignored) {
      logWebhookResult(req, webhookPublicId, {
        status: 'ignored',
        reason: agentResolution.reason,
        integrationId: integration.id,
        tenantId: integration.tenant_id,
        channelId: parsed.channelId,
        whatsappId: parsed.whatsappId,
        channelName: parsed.channelName,
      });

      return res.json({
        ok: true,
        ignored: agentResolution.reason,
      });
    }

    const { error: webhookError } = await supabaseAdmin
      .from('crm_ai_webhook_events')
      .insert({
        tenant_id: integration.tenant_id,
        integration_id: integration.id,
        external_event_id: parsed.eventId,
        event_type: parsed.method,
        payload,
        processing_status: 'processed',
        attempts: 1,
        processed_at: new Date().toISOString(),
      });

    if (webhookError && webhookError.code !== '23505') {
      throw webhookError;
    }

    if (webhookError?.code === '23505') {
      logWebhookResult(req, webhookPublicId, {
        status: 'ignored',
        reason: 'Evento duplicado',
        integrationId: integration.id,
        tenantId: integration.tenant_id,
        externalEventId: parsed.eventId,
      });

      return res.json({
        ok: true,
        ignored: 'Evento duplicado',
      });
    }

    const actions = await loadAgentActions(agentResolution.agent?.id);
    let zpro = null;
    async function getZpro() {
      if (!zpro) zpro = await createZproService(integration);
      return zpro;
    }

    let lead = null;

    if (parsed.ticketId) {
      const { data } = await supabaseAdmin
        .from('crm_ai_leads')
        .select('*')
        .eq('integration_id', integration.id)
        .eq('external_ticket_id', parsed.ticketId)
        .maybeSingle();

      lead = data;
    }

    if (!lead) {
      const { data } = await supabaseAdmin
        .from('crm_ai_leads')
        .select('*')
        .eq('integration_id', integration.id)
        .eq('phone', parsed.phone)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      lead = data;
    }

    if (!lead) {
      const metadata = buildLeadMetadata(parsed, {}, agentResolution.agent);

      const { data, error } = await supabaseAdmin
        .from('crm_ai_leads')
        .insert({
          tenant_id: integration.tenant_id,
          integration_id: integration.id,
          name: parsed.name || null,
          phone: parsed.phone,
          source: 'whatsapp',
          external_contact_id: parsed.contactId,
          external_ticket_id: parsed.ticketId,
          assigned_external_user_id: parsed.assignedExternalUserId,
          status: leadStatusForInbound(parsed, metadata),
          first_message_at: new Date().toISOString(),
          last_message_at: new Date().toISOString(),
          metadata,
        })
        .select('*')
        .single();

      if (error) throw error;
      lead = data;
    } else {
      const metadata = buildLeadMetadata(parsed, lead.metadata || {}, agentResolution.agent);

      const { data, error } = await supabaseAdmin
        .from('crm_ai_leads')
        .update({
          name: parsed.name || lead.name,
          external_contact_id: parsed.contactId || lead.external_contact_id,
          external_ticket_id: parsed.ticketId || lead.external_ticket_id,
          assigned_external_user_id: parsed.ticketId
            ? parsed.assignedExternalUserId || null
            : parsed.assignedExternalUserId || lead.assigned_external_user_id,
          status: leadStatusForInbound(parsed, metadata),
          last_message_at: new Date().toISOString(),
          metadata,
          updated_at: new Date().toISOString(),
        })
        .eq('id', lead.id)
        .select('*')
        .single();

      if (error) throw error;
      lead = data;
    }

    const leadMetadata = lead.metadata || buildLeadMetadata(parsed, {}, agentResolution.agent);
    await syncOptionalLeadColumns(lead, parsed, leadMetadata);
    await cancelPendingFollowups({
      tenantId: integration.tenant_id,
      leadId: lead.id,
      reason: 'customer_replied',
    });

    await insertLeadEvent({
      tenantId: integration.tenant_id,
      leadId: lead.id,
      eventType: parsed.isAudio ? 'audio_received' : 'message_received',
      externalEventId: parsed.eventId,
      summary: parsed.isAudio
        ? '[audio recebido]'
        : parsed.text || '[mensagem sem texto]',
      payload: {
        parsed,
        raw: payload,
      },
    });

    await rememberTicketContext({
      tenantId: integration.tenant_id,
      integrationId: integration.id,
      leadId: lead.id,
      ticketId: parsed.ticketId,
      role: 'user',
      content: parsed.isAudio ? '[audio recebido]' : parsed.text || '[mensagem sem texto]',
      eventType: parsed.isAudio ? 'audio_received' : 'message_received',
      externalEventId: parsed.eventId,
      metadata: {
        ticket_status: parsed.ticketStatus,
        channel_id: parsed.channelId,
        whatsapp_id: parsed.whatsappId,
      },
    });

    if (parsed.isAudio && Number(leadMetadata.audio_message_count || 0) >= 2) {
      await insertLeadEvent({
        tenantId: integration.tenant_id,
        leadId: lead.id,
        eventType: 'audio_repeat_detected',
        summary: 'Contato enviou audio novamente; pronto para regra de transferencia humana.',
        payload: {
          audio_message_count: leadMetadata.audio_message_count,
          safe_mode: agentResolution.agent?.settings?.safe_mode !== false,
        },
      });
    }

    await insertLeadEvent({
      tenantId: integration.tenant_id,
      leadId: lead.id,
      eventType: 'ai_shadow_decision',
      summary: 'Decisao registrada para auditoria.',
      payload: buildShadowDecision(parsed, leadMetadata),
    });

    const existingOpportunity = await findLocalOpportunityForTicket({
      integration,
      lead,
      ticketId: parsed.ticketId || null,
    });

    let createdOpportunity = false;
    let opportunity = existingOpportunity || null;

    if (!existingOpportunity && integration.auto_create_opportunity) {
      const { data: localOpportunity, error: opportunityError } = await supabaseAdmin
        .from('crm_ai_opportunities')
        .insert({
          tenant_id: integration.tenant_id,
          lead_id: lead.id,
          integration_id: integration.id,
          external_ticket_id: parsed.ticketId ? String(parsed.ticketId) : null,
          title: `${lead.name || 'Lead ' + lead.phone} - WhatsApp`,
          pipeline_id: integration.pipeline_id || null,
          stage_id: integration.initial_stage_id || 'novo_lead',
          assigned_external_user_id: parsed.assignedExternalUserId || null,
          status: 'open',
          value: 0,
          raw_data: {
            zpro_ticket_sync_ticket_id: parsed.ticketId ? String(parsed.ticketId) : null,
            created_for_ticket_at: new Date().toISOString(),
          },
        })
        .select('*')
        .single();

      if (opportunityError?.code === '23505') {
        opportunity = await findLocalOpportunityForTicket({
          integration,
          lead,
          ticketId: parsed.ticketId || null,
        });
      } else if (opportunityError) {
        throw opportunityError;
      } else {
        createdOpportunity = true;
        opportunity = localOpportunity;
      }

      if (createdOpportunity) {
        await insertLeadEvent({
          tenantId: integration.tenant_id,
          leadId: lead.id,
          eventType: 'opportunity_created',
          summary: 'Oportunidade criada automaticamente para o ticket.',
          payload: {
            opportunity_id: opportunity.id,
            external_ticket_id: parsed.ticketId || null,
            pipeline_id: opportunity.pipeline_id,
            stage_id: opportunity.stage_id,
          },
        });
      }
    }

    opportunity = await syncOpportunityFromTicketState({
      getZpro,
      integration,
      actions,
      parsed,
      lead,
      opportunity,
    });

    let aiResult = null;
    let followupJob = null;
    try {
      aiResult = await maybeSendAiReply({
        zpro: shouldRunLiveAi(agentResolution.agent) ? await getZpro() : null,
        integration,
        agent: agentResolution.agent,
        actions,
        parsed,
        lead,
        leadMetadata,
        opportunity,
      });

      const shouldScheduleFollowup = Boolean(
        aiResult?.reply
        && canExecuteAction(actions, 'schedule_followup')
        && !isStopAction(aiResult?.decision?.action)
        && aiResult?.appointmentResult?.status !== 'created'
      );
      if (shouldScheduleFollowup) {
        try {
          followupJob = await scheduleFollowupAfterAiReply({
            lead,
            agentId: agentResolution.agent?.id || null,
          });
        } catch (followupError) {
          await insertLeadEvent({
            tenantId: integration.tenant_id,
            leadId: lead.id,
            eventType: 'followup_schedule_failed',
            summary: 'Falha ao agendar o proximo follow-up.',
            payload: { error: followupError.message || String(followupError) },
          });
          logWarn('followup.schedule_failed', {
            tenantId: integration.tenant_id,
            leadId: lead.id,
            error: followupError.message || String(followupError),
          });
        }
      }
    } catch (err) {
      aiResult = { error: err.message || String(err), errorCode: err.code || null, failedStep: 'prepare_zpro_client' };
      await insertLeadEvent({
        tenantId: integration.tenant_id,
        leadId: lead.id,
        eventType: 'ai_response_failed',
        summary: 'Falha ao preparar cliente Z-PRO para resposta da IA.',
        payload: {
          error: err.message || String(err),
        },
      });
    }

    // Routing may already have created the opportunity or saved a retry deadline.
    // Refresh before ensuring the external record; CRM failures must not delay the reply.
    try {
      if (aiResult?.decision?.action && aiResult.decision.action !== 'reply') {
        opportunity = await findLocalOpportunityForTicket({ integration, lead, ticketId: parsed.ticketId || null }) || opportunity;
      }
      if (opportunity && !opportunity.external_opportunity_id && externalOpportunityCreateRetryAllowed(opportunity)) {
        const createdExternalOpportunity = await maybeCreateExternalOpportunity({
          zpro: await getZpro(), integration, actions, parsed, lead, opportunity,
        });
        opportunity = createdExternalOpportunity?.opportunity || opportunity;
      }
    } catch (err) {
      logWarn('zpro.webhook.opportunity_sync_failed', {
        integrationId: integration.id, leadId: lead.id, ticketId: parsed.ticketId,
        error: err.message || String(err),
      });
    }

    logWebhookResult(req, webhookPublicId, {
      status: 'processed',
      integrationId: integration.id,
      tenantId: integration.tenant_id,
      leadId: lead.id,
      agentId: agentResolution.agent?.id || null,
      agentName: agentResolution.agent?.name || null,
      externalEventId: parsed.eventId,
      phone: parsed.phone,
      ticketId: parsed.ticketId,
      contactType: leadMetadata.contact_type,
      isAudio: parsed.isAudio,
      audioMessageCount: leadMetadata.audio_message_count,
      createdOpportunity,
      aiReplySent: Boolean(aiResult?.reply),
      aiSendEndpoint: aiResult?.result?.endpoint || null,
      aiSendCompatibility: aiResult?.result?.compatibility || null,
      aiSkippedReason: aiResult?.skippedReason || null,
      aiError: aiResult?.error || null,
      aiErrorCode: aiResult?.errorCode || null,
      aiFailedStep: aiResult?.failedStep || null,
      externalOpportunityId: opportunity?.external_opportunity_id || null,
      opportunityCreateError: opportunity?.raw_data?.zpro_create_error || null,
      opportunityRetryAfter: opportunity?.raw_data?.zpro_create_retry_after || null,
      aiAction: aiResult?.decision?.action || null,
      aiActionExecuted: Boolean(aiResult?.actionResult?.executed),
      aiLocalStopped: Boolean(aiResult?.actionResult?.local_ai_stopped),
      aiRuleId: aiResult?.actionResult?.rule_id || null,
      aiTargetPipelineId: aiResult?.actionResult?.pipeline_id || null,
      aiTargetStageId: aiResult?.actionResult?.stage_id || null,
      aiTargetQueueId: aiResult?.actionResult?.queue_id || null,
      aiTargetUserId: aiResult?.actionResult?.user_id || null,
      aiTicketEndpoint: aiResult?.actionResult?.ticket?.endpoint || null,
      aiTicketVerificationEndpoint: aiResult?.actionResult?.ticket_verification?.endpoint || null,
      aiTicketVerified: aiResult?.actionResult?.ticket_verified === true,
      aiTicketEffectiveUserId: aiResult?.actionResult?.ticket_effective_user_id || null,
      aiTicketEffectiveQueueId: aiResult?.actionResult?.ticket_effective_queue_id || null,
      aiTicketEffectiveStatus: aiResult?.actionResult?.ticket_effective_status || null,
      aiPerf: aiResult?.perf || null,
      aiAppointmentStatus: aiResult?.appointmentResult?.status || null,
      aiAppointmentStartAt: aiResult?.appointmentResult?.start_at || null,
      followupJobId: followupJob?.id || null,
      followupRunAt: followupJob?.run_at || null,
      aiTicketError: aiResult?.actionResult?.ticket_error || null,
      aiOpportunityError: aiResult?.actionResult?.opportunity_error || null,
    });

    return res.json({
      ok: true,
      mode: process.env.APP_MODE || 'live',
      lead_id: lead.id,
      createdOpportunity,
      aiReplySent: Boolean(aiResult?.reply),
      aiSkippedReason: aiResult?.skippedReason || null,
      aiErrorCode: aiResult?.errorCode || null,
      aiFailedStep: aiResult?.failedStep || null,
      aiAction: aiResult?.decision?.action || null,
      aiActionExecuted: Boolean(aiResult?.actionResult?.executed),
      aiLocalStopped: Boolean(aiResult?.actionResult?.local_ai_stopped),
      aiRuleId: aiResult?.actionResult?.rule_id || null,
      aiTargetPipelineId: aiResult?.actionResult?.pipeline_id || null,
      aiTargetStageId: aiResult?.actionResult?.stage_id || null,
      aiTargetQueueId: aiResult?.actionResult?.queue_id || null,
      aiTargetUserId: aiResult?.actionResult?.user_id || null,
      aiTicketEndpoint: aiResult?.actionResult?.ticket?.endpoint || null,
      aiTicketVerificationEndpoint: aiResult?.actionResult?.ticket_verification?.endpoint || null,
      aiTicketVerified: aiResult?.actionResult?.ticket_verified === true,
      aiTicketEffectiveUserId: aiResult?.actionResult?.ticket_effective_user_id || null,
      aiTicketEffectiveQueueId: aiResult?.actionResult?.ticket_effective_queue_id || null,
      aiTicketEffectiveStatus: aiResult?.actionResult?.ticket_effective_status || null,
      aiPerf: aiResult?.perf || null,
      aiAppointmentStatus: aiResult?.appointmentResult?.status || null,
      aiAppointmentStartAt: aiResult?.appointmentResult?.start_at || null,
      followupJobId: followupJob?.id || null,
      followupRunAt: followupJob?.run_at || null,
      message: 'Webhook processado e salvo no Supabase.',
    });
  } catch (err) {
    logError('zpro.webhook.result', {
      requestId: req.requestId,
      method: req.method,
      route: req.originalUrl,
      status: 'failed',
      error: err.message || String(err),
    });
    next(err);
  }
});
