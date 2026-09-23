export function validateAgentSettings(settings = {}) {
  const fail = (message) => { throw Object.assign(new Error(message), { statusCode: 400 }); };
  if (!['legacy', 'shadow', 'v2'].includes(settings.conversation_engine || 'legacy')) fail('Motor conversacional invalido');
  const p = settings.schedule_policy;
  if (!p?.enabled) return;
  try { new Intl.DateTimeFormat('pt-BR', { timeZone: p.timezone }).format(); }
  catch { fail('Fuso horario invalido'); }
  for (const [key, min, max] of [['duration_minutes', 5, 480], ['buffer_minutes', 0, 240], ['advance_notice_minutes', 0, 43200], ['horizon_days', 1, 90]]) {
    if (!Number.isInteger(p[key]) || p[key] < min || p[key] > max) fail('Configuracao invalida: ' + key);
  }
  if (!p.business_hours || typeof p.business_hours !== 'object') fail('Informe os horarios de atendimento');
  for (const [day, windows] of Object.entries(p.business_hours)) {
    if (!/^[0-6]$/.test(day) || !Array.isArray(windows)) fail('Dia ou horario invalido');
    const sorted = [...windows].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    for (let i = 0; i < sorted.length; i++) {
      const pair = sorted[i];
      if (!Array.isArray(pair) || pair.length !== 2 || pair.some((v) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(v))
        || pair[0] >= pair[1] || (i && sorted[i - 1][1] > pair[0])) fail('Faixas de horario invalidas ou sobrepostas');
    }
  }
}
