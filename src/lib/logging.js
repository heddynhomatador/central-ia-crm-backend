const SENSITIVE_KEY_RE =
  /(authorization|bearer|cookie|set-cookie|token|secret|api[-_]?key|apikey|password|senha|service_role|signature)/i;

const MAX_VALUE_LENGTH = 1200;
const MAX_BODY_LENGTH = 15000;

export function createRequestId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function truncate(value, maxLength = MAX_VALUE_LENGTH) {
  const text = String(value ?? '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...[truncado ${text.length - maxLength} chars]`;
}

function redactValue(value) {
  if (value == null) return value;
  return '[redigido]';
}

export function sanitizeHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      SENSITIVE_KEY_RE.test(key) ? redactValue(value) : truncate(Array.isArray(value) ? value.join(',') : value),
    ]),
  );
}

export function sanitizeObject(value, seen = new WeakSet()) {
  if (value == null) return value;
  if (typeof value !== 'object') return typeof value === 'string' ? truncate(value) : value;

  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeObject(item, seen));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEY_RE.test(key) ? redactValue(item) : sanitizeObject(item, seen),
    ]),
  );
}

function redactSensitiveText(text = '') {
  return String(text)
    .replace(/("?(?:authorization|bearer|token|secret|api[-_]?key|apikey|password|senha|service_role)"?\s*[:=]\s*)"[^"]+"/gi, '$1"[redigido]"')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redigido]');
}

export function sanitizeRawBody(rawBody = '') {
  const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
  if (!text) return '';

  try {
    return truncate(JSON.stringify(sanitizeObject(JSON.parse(text))), MAX_BODY_LENGTH);
  } catch {
    return truncate(redactSensitiveText(text), MAX_BODY_LENGTH);
  }
}

export function getRawBodyForLog(req) {
  if (req.rawBody) return sanitizeRawBody(req.rawBody);
  if (Buffer.isBuffer(req.body)) return sanitizeRawBody(req.body);
  if (typeof req.body === 'string') return sanitizeRawBody(req.body);
  if (req.body && typeof req.body === 'object') {
    return truncate(JSON.stringify(sanitizeObject(req.body)), MAX_BODY_LENGTH);
  }
  return '';
}

export function logInfo(event, data = {}) {
  console.log(JSON.stringify({
    level: 'info',
    event,
    time: new Date().toISOString(),
    ...sanitizeObject(data),
  }));
}

export function logWarn(event, data = {}) {
  console.warn(JSON.stringify({
    level: 'warn',
    event,
    time: new Date().toISOString(),
    ...sanitizeObject(data),
  }));
}

export function logError(event, data = {}) {
  console.error(JSON.stringify({
    level: 'error',
    event,
    time: new Date().toISOString(),
    ...sanitizeObject(data),
  }));
}
