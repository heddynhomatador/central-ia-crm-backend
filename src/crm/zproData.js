import { engineError } from '../operations/store.js';
export function listItems(data) {
  if (Array.isArray(data)) return data;
  for (const key of ['items', 'records', 'rows', 'tickets', 'opportunities', 'appointments', 'data', 'result']) {
    if (Array.isArray(data?.[key])) return data[key];
    if (data?.[key] && typeof data[key] === 'object') {
      const found = listItems(data[key]);
      if (found.length) return found;
    }
  }
  return [];
}
export function recordData(data, kind) {
  return data?.data?.[kind] || data?.[kind] || data?.data || data || {};
}
export function ticketSnapshot(response) {
  const t = recordData(response.data ?? response, 'ticket');
  return { id: t.id || t.ticketId, status: t.status, userId: t.userId || t.user_id || t.user?.id || null,
    queueId: t.queueId || t.queue_id || t.queue?.id || null, channelId: t.whatsappId || t.channelId || t.whatsapp?.id,
    contactId: t.contactId || t.contact?.id, phone: t.contact?.number || t.contact?.phone || t.number };
}
export async function allPages(load, filters = {}, limit = 200, honorsLimit = true) {
  const rows = []; const seen = new Set();
  for (let page = 1; page <= 100; page++) {
    const response = await load({ ...filters, page, limit });
    const items = listItems(response.data ?? response);
    if (!items.length) return rows;
    const fingerprint = JSON.stringify(items);
    if (seen.has(fingerprint)) throw engineError('ZPRO_PAGINATION_NOT_ADVANCING');
    seen.add(fingerprint); rows.push(...items);
    const data = response.data || response;
    const hasMore = data.hasMore ?? data.data?.hasMore;
    const total = data.total ?? data.count ?? data.data?.total;
    if (hasMore === false || (total != null && rows.length >= Number(total)) || (honorsLimit && hasMore !== true && items.length < limit)) return rows;
  }
  throw engineError('ZPRO_PAGINATION_LIMIT');
}
