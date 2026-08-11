import express from 'express';
import { ZproService } from '../services/zproService.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logInfo, logWarn, sanitizeObject } from '../lib/logging.js';

export const adminRouter = express.Router();

const INTEGRATION_SAFE_SELECT = `
  id,
  tenant_id,
  provider,
  name,
  base_url,
  api_id,
  channel_id,
  sales_queue_id,
  pipeline_id,
  initial_stage_id,
  won_stage_id,
  lost_stage_id,
  webhook_public_id,
  auto_create_opportunity,
  active,
  has_token,
  created_at,
  updated_at
`;

const ZPRO_CONFIG_FIELDS = [
  'tenant_id',
  'provider',
  'name',
  'base_url',
  'api_id',
  'channel_id',
  'sales_queue_id',
  'pipeline_id',
  'initial_stage_id',
  'won_stage_id',
  'lost_stage_id',
  'auto_create_opportunity',
  'active',
];

const ZPRO_READERS = {
  users: { label: 'usuarios/vendedores', method: 'listUsers' },
  queues: { label: 'filas', method: 'listQueues' },
  channels: { label: 'canais', method: 'listChannels' },
  pipelines: { label: 'funis/kanbans', method: 'listPipelines' },
  stages: { label: 'etapas', method: 'listStages' },
  tickets: { label: 'atendimentos/tickets', method: 'listTickets' },
  opportunities: { label: 'oportunidades', method: 'listOpportunities' },
};

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function isAdminApiKeyAuthorized(req) {
  const key = req.headers['x-admin-api-key'];
  return Boolean(process.env.ADMIN_API_KEY && key === process.env.ADMIN_API_KEY);
}

function requireAdminApiKey(req, res, next) {
  if (!isAdminApiKeyAuthorized(req)) {
    return res.status(401).json({
      ok: false,
      error: 'Nao autorizado',
      message: 'Nao autorizado',
    });
  }

  next();
}

function getBearerToken(req) {
  const authorization = String(req.headers.authorization || '');
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || null;
}

async function loadRequester(req) {
  if (isAdminApiKeyAuthorized(req)) {
    return {
      authType: 'admin_api_key',
      isSuperadmin: true,
      userId: null,
    };
  }

  const token = getBearerToken(req);
  if (!token) return null;

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) return null;

  const { data: profile, error: profileError } = await supabaseAdmin
    .from('crm_ai_profiles')
    .select('global_role,status')
    .eq('id', data.user.id)
    .maybeSingle();

  if (profileError) throw profileError;

  return {
    authType: 'supabase_jwt',
    isSuperadmin: profile?.global_role === 'superadmin' && profile?.status === 'active',
    userId: data.user.id,
  };
}

async function assertTenantPermission(req, tenantId, allowedRoles) {
  if (!tenantId) throw httpError(400, 'tenant_id obrigatorio');

  const requester = await loadRequester(req);
  if (!requester) throw httpError(401, 'Nao autorizado');
  if (requester.isSuperadmin) return requester;

  const { data: member, error } = await supabaseAdmin
    .from('crm_ai_members')
    .select('role,status')
    .eq('tenant_id', tenantId)
    .eq('user_id', requester.userId)
    .maybeSingle();

  if (error) throw error;

  if (!member || member.status !== 'active' || !allowedRoles.includes(member.role)) {
    throw httpError(403, 'Sem permissao para esta empresa');
  }

  return requester;
}

async function assertCanAdminTenant(req, tenantId) {
  return assertTenantPermission(req, tenantId, ['tenant_admin']);
}

async function assertCanManageTenant(req, tenantId) {
  return assertTenantPermission(req, tenantId, ['tenant_admin', 'manager']);
}

function pickIntegrationPayload(body = {}) {
  return Object.fromEntries(
    ZPRO_CONFIG_FIELDS
      .filter((field) => Object.hasOwn(body, field))
      .map((field) => [field, body[field]]),
  );
}

function cleanIntegration(integration) {
  if (!integration) return null;

  const {
    id,
    tenant_id,
    provider,
    name,
    base_url,
    api_id,
    channel_id,
    sales_queue_id,
    pipeline_id,
    initial_stage_id,
    won_stage_id,
    lost_stage_id,
    webhook_public_id,
    auto_create_opportunity,
    active,
    has_token,
    created_at,
    updated_at,
  } = integration;

  return {
    id,
    tenant_id,
    provider,
    name,
    base_url,
    api_id,
    channel_id,
    sales_queue_id,
    pipeline_id,
    initial_stage_id,
    won_stage_id,
    lost_stage_id,
    webhook_public_id,
    auto_create_opportunity,
    active,
    has_token,
    created_at,
    updated_at,
  };
}

async function loadIntegration(integrationId) {
  if (!integrationId) throw httpError(400, 'integrationId obrigatorio');

  const { data: integration, error } = await supabaseAdmin
    .from('crm_ai_integrations')
    .select('*')
    .eq('id', integrationId)
    .maybeSingle();

  if (error) throw error;
  if (!integration) throw httpError(404, 'Integracao nao encontrada');
  return integration;
}

function getIntegrationId(req) {
  return req.params.integrationId || req.body?.integrationId || req.query?.integrationId;
}

async function createZproService(integration) {
  const { data: token, error: tokenError } = await supabaseAdmin.rpc(
    'crm_ai_service_get_zpro_token',
    {
      p_integration_id: integration.id,
    },
  );

  if (tokenError) throw tokenError;

  return new ZproService({
    baseUrl: integration.base_url,
    token,
  });
}

async function saveZproToken(integrationId, token) {
  if (!token) throw httpError(400, 'token obrigatorio');

  const { error } = await supabaseAdmin.rpc('crm_ai_service_set_zpro_token', {
    p_integration_id: integrationId,
    p_token: token,
  });

  if (error) throw error;
}

function zproErrorResponse(res, err) {
  const statusCode = err.statusCode || 502;
  return res.status(statusCode).json({
    ok: false,
    error: err.message || String(err),
    message: err.message || String(err),
    code: err.code || 'ZPRO_REQUEST_FAILED',
    attempts: err.attempts,
  });
}

function compactObject(value = {}) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''),
  );
}

function normalizeList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data?.data)) return data.data.data;
  if (Array.isArray(data?.data?.items)) return data.data.items;
  if (Array.isArray(data?.data?.results)) return data.data.results;
  if (Array.isArray(data?.data?.rows)) return data.data.rows;
  if (Array.isArray(data?.data?.records)) return data.data.records;
  if (Array.isArray(data?.data?.list)) return data.data.list;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.rows)) return data.rows;
  if (Array.isArray(data?.records)) return data.records;
  if (Array.isArray(data?.list)) return data.list;
  if (Array.isArray(data?.content)) return data.content;
  if (Array.isArray(data?.tickets)) return data.tickets;
  if (Array.isArray(data?.opportunities)) return data.opportunities;
  if (Array.isArray(data?.kanbans)) return data.kanbans;
  if (Array.isArray(data?.pipelines)) return data.pipelines;
  if (Array.isArray(data?.funnels)) return data.funnels;
  if (Array.isArray(data?.funis)) return data.funis;
  if (Array.isArray(data?.stages)) return data.stages;
  if (Array.isArray(data?.steps)) return data.steps;
  if (Array.isArray(data?.columns)) return data.columns;
  if (Array.isArray(data?.etapas)) return data.etapas;
  if (Array.isArray(data?.fases)) return data.fases;
  if (Array.isArray(data?.contacts)) return data.contacts;
  if (Array.isArray(data?.users)) return data.users;
  if (Array.isArray(data?.queues)) return data.queues;
  return [];
}

function getLeadExternalId(lead = {}) {
  return String(
    lead.id ||
      lead.ticketId ||
      lead.ticket_id ||
      lead.opportunityId ||
      lead.opportunity_id ||
      lead.external_id ||
      lead.externalId ||
      '',
  );
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

function stageCollectionsFrom(item = {}) {
  return [
    item.stages,
    item.steps,
    item.columns,
    item.kanbanStages,
    item.kanban_stages,
    item.etapas,
    item.fases,
    item.children,
  ].filter(Array.isArray);
}

function extractNestedStageItems(data, integration, filters = {}) {
  const roots = [];
  const normalized = normalizeList(data);
  if (normalized.length > 0) roots.push(...normalized);
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    roots.push(data);
    if (data.data && typeof data.data === 'object' && !Array.isArray(data.data)) {
      roots.push(data.data);
    }
  }

  const stages = [];
  for (const root of roots) {
    if (!root || typeof root !== 'object') continue;

    const pipelineId =
      pickValue(root, [
        'id',
        'pipelineId',
        'pipeline_id',
        'kanbanId',
        'kanban_id',
        'funnelId',
        'funilId',
        'external_pipeline_id',
      ]) || filters.pipelineId || filters.external_pipeline_id || integration.pipeline_id;

    for (const collection of stageCollectionsFrom(root)) {
      for (const stage of collection) {
        if (!stage || typeof stage !== 'object') continue;
        stages.push({
          ...stage,
          pipelineId:
            pickValue(stage, [
              'pipelineId',
              'pipeline_id',
              'kanbanId',
              'kanban_id',
              'funnelId',
              'funilId',
              'external_pipeline_id',
            ]) || pipelineId,
        });
      }
    }
  }

  return stages;
}

function cacheConflictKey(kind, row = {}) {
  if (kind === 'users') return `${row.integration_id}:${row.external_user_id}`;
  if (kind === 'queues') return `${row.integration_id}:${row.external_queue_id}`;
  if (kind === 'pipelines') return `${row.integration_id}:${row.external_pipeline_id}`;
  if (kind === 'stages') {
    return `${row.integration_id}:${row.external_pipeline_id}:${row.external_stage_id}`;
  }
  return JSON.stringify(row);
}

function dedupeCacheRows(kind, rows = []) {
  const map = new Map();
  for (const row of rows) {
    map.set(cacheConflictKey(kind, row), row);
  }
  return Array.from(map.values());
}

function normalizeDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function getLeadDedupeKey(lead = {}) {
  const phone = normalizeDigits(
    pickValue(lead, [
      'phone',
      'number',
      'contactNumber',
      'contact_number',
      'contact.phone',
      'contact.number',
      'customer.phone',
      'customer.number',
    ]),
  );

  if (phone) return `phone:${phone}`;

  const contactId = pickValue(lead, [
    'contactId',
    'contact_id',
    'contact.id',
    'customerId',
    'customer_id',
    'customer.id',
  ]);

  if (contactId) return `contact:${contactId}`;
  return `external:${getLeadExternalId(lead)}`;
}

function dedupeItems(items = []) {
  const unique = new Map();
  let fallbackIndex = 0;

  for (const item of items) {
    const key = getLeadDedupeKey(item);
    const dedupeKey = key && key !== 'external:' ? key : `fallback:${fallbackIndex++}`;
    if (!unique.has(dedupeKey)) unique.set(dedupeKey, item);
  }

  return Array.from(unique.values());
}

function asPositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function paginationDetails(data = {}, items = [], filters = {}) {
  const currentPage =
    asPositiveNumber(
      pickValue(data, [
        'page',
        'currentPage',
        'current_page',
        'pagination.page',
        'pagination.currentPage',
        'meta.page',
        'meta.currentPage',
      ]),
    ) || asPositiveNumber(filters.page) || 1;
  const totalPages = asPositiveNumber(
    pickValue(data, [
      'totalPages',
      'total_pages',
      'pages',
      'pageCount',
      'page_count',
      'pagination.totalPages',
      'pagination.total_pages',
      'meta.totalPages',
      'meta.total_pages',
      'meta.pages',
    ]),
  );
  const totalCount = asPositiveNumber(
    pickValue(data, [
      'total',
      'count',
      'totalCount',
      'total_count',
      'pagination.total',
      'pagination.totalCount',
      'meta.total',
      'meta.totalCount',
    ]),
  );
  const hasMore = ['hasMore', 'has_more', 'pagination.hasMore', 'pagination.has_more'].some(
    (path) => pickValue(data, [path]) === true,
  );

  return {
    currentPage,
    totalPages,
    totalCount,
    hasMore: Boolean(hasMore || (totalPages && currentPage < totalPages)),
    pageSize: items.length,
  };
}

async function readZproPagedList(zpro, methodName, filters = {}) {
  const maxPages = Math.min(20, Math.max(1, Number(filters.maxPages || filters.max_pages || 10)));
  const cleanFilters = { ...filters };
  delete cleanFilters.maxPages;
  delete cleanFilters.max_pages;

  const first = await zpro[methodName](cleanFilters);
  const firstItems = normalizeList(first.data);
  const details = paginationDetails(first.data, firstItems, cleanFilters);
  const allItems = [...firstItems];
  const pageErrors = [];
  let pagesRead = 1;

  if (details.totalPages && details.totalPages > details.currentPage) {
    const lastPage = Math.min(details.totalPages, maxPages);
    for (let page = details.currentPage + 1; page <= lastPage; page += 1) {
      try {
        const next = await zpro[methodName]({
          ...cleanFilters,
          page,
        });
        allItems.push(...normalizeList(next.data));
        pagesRead = page;
      } catch (err) {
        pageErrors.push({
          page,
          error: err.message || String(err),
        });
        break;
      }
    }
  } else if (details.hasMore) {
    for (let page = details.currentPage + 1; page <= details.currentPage + maxPages - 1; page += 1) {
      try {
        const next = await zpro[methodName]({
          ...cleanFilters,
          page,
        });
        const nextItems = normalizeList(next.data);
        const nextDetails = paginationDetails(next.data, nextItems, { ...cleanFilters, page });
        allItems.push(...nextItems);
        pagesRead = page;
        if (!nextDetails.hasMore || nextItems.length === 0) break;
      } catch (err) {
        pageErrors.push({
          page,
          error: err.message || String(err),
        });
        break;
      }
    }
  }

  return {
    endpoint: first.endpoint,
    method: first.method,
    data: first.data,
    items: allItems,
    pagination: {
      ...details,
      pagesRead,
      maxPages,
      pageErrors,
    },
  };
}

function distributeItems(items = [], targetUsers = [], mode = 'balanced') {
  const activeUsers = targetUsers
    .map((user) => ({
      id: String(user.id || user.external_user_id || user.externalUserId || ''),
      name: String(user.name || user.label || user.id || user.external_user_id || ''),
      quantity: Number(user.quantity || 0),
    }))
    .filter((user) => user.id);

  if (activeUsers.length === 0) {
    throw httpError(400, 'Selecione ao menos um atendente de destino');
  }

  let expandedUsers = activeUsers;
  if (mode === 'quantity') {
    expandedUsers = activeUsers.flatMap((user) =>
      Array.from({ length: Math.max(0, user.quantity) }, () => user),
    );

    if (expandedUsers.length === 0) {
      throw httpError(400, 'Informe a quantidade de cada atendente');
    }
  }

  return items.map((item, index) => {
    const target = expandedUsers[index % expandedUsers.length];
    return {
      item,
      itemId: getLeadExternalId(item),
      targetUserId: target.id,
      targetUserName: target.name,
    };
  });
}

function readActive(item = {}) {
  const explicit = pickValue(item, ['active', 'isActive', 'enabled']);
  if (explicit === false || explicit === 'false' || explicit === 0 || explicit === '0') return false;
  const status = String(pickValue(item, ['status']) || '').toLowerCase();
  return !['inactive', 'disabled', 'closed', 'deleted', 'inativo'].includes(status);
}

const ZPRO_CACHE_TABLES = {
  users: {
    table: 'crm_ai_zpro_users_cache',
    conflict: 'integration_id,external_user_id',
  },
  queues: {
    table: 'crm_ai_zpro_queues_cache',
    conflict: 'integration_id,external_queue_id',
  },
  pipelines: {
    table: 'crm_ai_zpro_pipelines_cache',
    conflict: 'integration_id,external_pipeline_id',
  },
  stages: {
    table: 'crm_ai_zpro_stages_cache',
    conflict: 'integration_id,external_pipeline_id,external_stage_id',
  },
};

function mapCacheRows(kind, items, integration, filters = {}) {
  return items
    .map((item) => {
      if (kind === 'users') {
        const externalId = pickValue(item, ['id', 'userId', 'user_id', 'externalId', 'external_id']);
        if (!externalId) return null;

        return {
          tenant_id: integration.tenant_id,
          integration_id: integration.id,
          external_user_id: String(externalId),
          name: String(pickValue(item, ['name', 'username', 'displayName', 'display_name', 'nome']) || externalId),
          email: pickValue(item, ['email', 'mail']) || null,
          active: readActive(item),
          raw_data: item,
          synced_at: new Date().toISOString(),
        };
      }

      if (kind === 'queues') {
        const externalId = pickValue(item, ['id', 'queueId', 'queue_id', 'externalId', 'external_id']);
        if (!externalId) return null;

        return {
          tenant_id: integration.tenant_id,
          integration_id: integration.id,
          external_queue_id: String(externalId),
          name: String(pickValue(item, ['name', 'title', 'label', 'queue', 'nome']) || externalId),
          active: readActive(item),
          raw_data: item,
          synced_at: new Date().toISOString(),
        };
      }

      if (kind === 'pipelines') {
        const externalId = pickValue(item, [
          'id',
          'pipelineId',
          'pipeline_id',
          'kanbanId',
          'kanban_id',
          'funnelId',
          'funilId',
          'externalId',
          'external_id',
        ]);
        if (!externalId) return null;

        return {
          tenant_id: integration.tenant_id,
          integration_id: integration.id,
          external_pipeline_id: String(externalId),
          name: String(pickValue(item, ['name', 'title', 'label', 'pipeline', 'kanban', 'nome']) || externalId),
          active: readActive(item),
          raw_data: item,
          synced_at: new Date().toISOString(),
        };
      }

      if (kind === 'stages') {
        const externalStageId = pickValue(item, [
          'id',
          'stageId',
          'stage_id',
          'stepId',
          'step_id',
          'columnId',
          'column_id',
          'kanbanStageId',
          'kanban_stage_id',
          'externalId',
          'external_id',
        ]);
        const externalPipelineId =
          pickValue(item, [
            'pipelineId',
            'pipeline_id',
            'kanbanId',
            'kanban_id',
            'funnelId',
            'funilId',
            'pipeline.id',
            'kanban.id',
          ]) || filters.pipelineId || filters.external_pipeline_id || integration.pipeline_id;

        if (!externalStageId || !externalPipelineId) return null;

        return {
          tenant_id: integration.tenant_id,
          integration_id: integration.id,
          external_pipeline_id: String(externalPipelineId),
          external_stage_id: String(externalStageId),
          name: String(pickValue(item, ['name', 'title', 'label', 'stage', 'step', 'nome']) || externalStageId),
          position: Number(pickValue(item, ['position', 'order', 'sort', 'index']) ?? null) || null,
          color: pickValue(item, ['color', 'hex', 'backgroundColor']) || null,
          active: readActive(item),
          raw_data: item,
          synced_at: new Date().toISOString(),
        };
      }

      return null;
    })
    .filter(Boolean);
}

async function syncZproCache(integration, kind, filters = {}) {
  const config = ZPRO_CACHE_TABLES[kind];
  const reader = ZPRO_READERS[kind];
  if (!config || !reader) throw httpError(404, 'Recurso Z-PRO nao reconhecido para cache');

  const zpro = await createZproService(integration);
  const response = await zpro[reader.method](filters);
  const items = normalizeList(response.data);
  const sourceItems =
    kind === 'stages'
      ? [...items, ...extractNestedStageItems(response.data, integration, filters)]
      : items;
  const rows = dedupeCacheRows(kind, mapCacheRows(kind, sourceItems, integration, filters));

  if (rows.length > 0) {
    const { error } = await supabaseAdmin
      .from(config.table)
      .upsert(rows, { onConflict: config.conflict });
    if (error) throw error;
  }

  let nestedStagesSaved = 0;
  if (kind === 'pipelines') {
    const nestedStageRows = dedupeCacheRows(
      'stages',
      mapCacheRows('stages', extractNestedStageItems(response.data, integration, filters), integration, filters),
    );

    if (nestedStageRows.length > 0) {
      const { error } = await supabaseAdmin
        .from(ZPRO_CACHE_TABLES.stages.table)
        .upsert(nestedStageRows, { onConflict: ZPRO_CACHE_TABLES.stages.conflict });
      if (error) throw error;
      nestedStagesSaved = nestedStageRows.length;
    }
  }

  return {
    ok: true,
    kind,
    endpoint: response.endpoint,
    method: response.method,
    received: items.length,
    saved: rows.length,
    nestedStagesSaved,
    items: rows,
  };
}

async function syncZproReferenceSet(integration, kinds = [], filters = {}) {
  const results = [];

  async function pushSync(kind, nextFilters = {}) {
    try {
      results.push(await syncZproCache(integration, kind, nextFilters));
    } catch (err) {
      results.push({
        ok: false,
        kind,
        error: err.message || String(err),
        code: err.code || 'ZPRO_SYNC_FAILED',
        attempts: err.attempts,
      });
    }
  }

  for (const kind of kinds) {
    if (kind !== 'stages' || filters.pipelineId || filters.external_pipeline_id) {
      await pushSync(kind, filters);
      continue;
    }

    const { data: pipelines, error } = await supabaseAdmin
      .from('crm_ai_zpro_pipelines_cache')
      .select('external_pipeline_id')
      .eq('tenant_id', integration.tenant_id)
      .eq('integration_id', integration.id)
      .eq('active', true);

    if (error) throw error;

    if (!pipelines?.length) {
      await pushSync('stages', filters);
      continue;
    }

    for (const pipeline of pipelines) {
      await pushSync('stages', {
        ...filters,
        pipelineId: pipeline.external_pipeline_id,
      });
    }
  }

  return results;
}

adminRouter.get('/debug/integrations', requireAdminApiKey, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('crm_ai_integrations')
      .select(INTEGRATION_SAFE_SELECT)
      .order('created_at', { ascending: false });

    if (error) throw error;

    return res.json({
      ok: true,
      integrations: (data || []).map(cleanIntegration),
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/integrations/zpro', async (req, res, next) => {
  try {
    const body = req.body || {};
    const integrationId = body.id || body.integrationId || null;
    const token = body.token || '';
    const payload = {
      ...pickIntegrationPayload(body),
      provider: 'zpro',
      name: body.name || 'Z-PRO',
    };

    let integration = null;

    if (integrationId) {
      integration = await loadIntegration(integrationId);
      await assertCanAdminTenant(req, integration.tenant_id);

      if (payload.tenant_id && payload.tenant_id !== integration.tenant_id) {
        throw httpError(400, 'Nao e permitido trocar a empresa da integracao');
      }

      delete payload.tenant_id;

      const { data, error } = await supabaseAdmin
        .from('crm_ai_integrations')
        .update(payload)
        .eq('id', integration.id)
        .select('*')
        .single();

      if (error) throw error;
      integration = data;
    } else {
      if (!payload.tenant_id) throw httpError(400, 'tenant_id obrigatorio');
      if (!payload.base_url) throw httpError(400, 'URL do Z-PRO obrigatoria');

      await assertCanAdminTenant(req, payload.tenant_id);

      const { data: existing, error: existingError } = await supabaseAdmin
        .from('crm_ai_integrations')
        .select('*')
        .eq('tenant_id', payload.tenant_id)
        .eq('provider', 'zpro')
        .maybeSingle();

      if (existingError) throw existingError;

      if (existing) {
        const { data, error } = await supabaseAdmin
          .from('crm_ai_integrations')
          .update(payload)
          .eq('id', existing.id)
          .select('*')
          .single();

        if (error) throw error;
        integration = data;
      } else {
        const { data, error } = await supabaseAdmin
          .from('crm_ai_integrations')
          .insert(payload)
          .select('*')
          .single();

        if (error) throw error;
        integration = data;
      }
    }

    if (token) {
      await saveZproToken(integration.id, token);
      integration = await loadIntegration(integration.id);
    }

    logInfo('admin.zpro.integration_saved', {
      requestId: req.requestId,
      integration: cleanIntegration(integration),
      tokenReceived: Boolean(token),
    });

    return res.json({
      ok: true,
      integration: cleanIntegration(integration),
      message: token ? 'Configuracao e token salvos com sucesso.' : 'Configuracao salva com sucesso.',
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/integrations/:integrationId/zpro/token', async (req, res, next) => {
  try {
    const integration = await loadIntegration(req.params.integrationId);
    await assertCanAdminTenant(req, integration.tenant_id);
    await saveZproToken(integration.id, req.body?.token);

    logInfo('admin.zpro.token_saved', {
      requestId: req.requestId,
      integrationId: integration.id,
      tenantId: integration.tenant_id,
    });

    return res.json({
      ok: true,
      message: 'Token salvo com sucesso.',
    });
  } catch (err) {
    next(err);
  }
});

async function testZproConnection(req, res, next) {
  try {
    const integration = await loadIntegration(getIntegrationId(req));
    await assertCanManageTenant(req, integration.tenant_id);

    const zpro = await createZproService(integration);
    let queues = null;

    try {
      queues = await zpro.listQueues();
    } catch (err) {
      queues = {
        ok: false,
        warning: 'Token/base_url carregaram, mas a consulta de filas falhou.',
        message: err.message || String(err),
        code: err.code || 'ZPRO_QUEUE_TEST_FAILED',
      };
    }

    return res.json({
      ok: true,
      integration: cleanIntegration(integration),
      queues,
    });
  } catch (err) {
    next(err);
  }
}

adminRouter.post('/integrations/zpro/test', testZproConnection);
adminRouter.post('/integrations/:integrationId/zpro/test', testZproConnection);

async function readZproResource(req, res, next) {
  try {
    const kind = req.params.kind || req.routeResourceKind;
    const reader = ZPRO_READERS[kind];

    if (!reader) throw httpError(404, 'Recurso Z-PRO nao reconhecido');

    const integration = await loadIntegration(getIntegrationId(req));
    await assertCanManageTenant(req, integration.tenant_id);

    const zpro = await createZproService(integration);

    try {
      const data = await zpro[reader.method](compactObject(req.query || {}));

      logInfo('admin.zpro.resource_read', {
        requestId: req.requestId,
        integrationId: integration.id,
        tenantId: integration.tenant_id,
        resource: kind,
      });

      return res.json({
        ok: true,
        resource: kind,
        label: reader.label,
        integration: cleanIntegration(integration),
        data: sanitizeObject(data),
        items: sanitizeObject(normalizeList(data?.data ?? data)),
      });
    } catch (err) {
      logWarn('admin.zpro.resource_failed', {
        requestId: req.requestId,
        integrationId: integration.id,
        tenantId: integration.tenant_id,
        resource: kind,
        error: err.message || String(err),
        code: err.code,
      });

      return zproErrorResponse(res, err);
    }
  } catch (err) {
    next(err);
  }
}

for (const kind of Object.keys(ZPRO_READERS)) {
  adminRouter.get(`/integrations/zpro/${kind}`, (req, res, next) => {
    req.routeResourceKind = kind;
    return readZproResource(req, res, next);
  });

  adminRouter.get(`/integrations/:integrationId/zpro/${kind}`, (req, res, next) => {
    req.routeResourceKind = kind;
    return readZproResource(req, res, next);
  });
}

adminRouter.get('/integrations/:integrationId/zpro/:kind', readZproResource);

adminRouter.get('/zpro/debug/endpoints', async (req, res, next) => {
  try {
    const integration = await loadIntegration(getIntegrationId(req));
    await assertCanManageTenant(req, integration.tenant_id);
    const zpro = await createZproService(integration);

    const resources = ['users', 'queues', 'pipelines', 'stages', 'tickets', 'opportunities'];
    const endpoints = {
      users: zpro.endpointAliases('users', ['listUsers', 'users', 'listAgents', 'agents']),
      queues: zpro.endpointAliases('queues', ['listQueues', 'queues']),
      pipelines: zpro.endpointAliases('pipelines', [
        'listKanbans',
        'kanbans',
        'kanban',
        'kanban/list',
        'listPipelines',
        'pipelines',
        'pipelines/list',
        'pipeline',
        'listFunnels',
        'funnels',
        'funis',
        'funnel',
        'funil/pipelines',
        'funil/kanban',
        'funil/kanbans',
        'funil/list',
        'crm/pipelines',
        'crm/kanbans',
        'crm/funil/pipelines',
        'crm/funil/kanban',
      ]),
      stages: zpro.endpointAliases('stages', [
        'listKanbanStages',
        'kanbanStages',
        'kanban/stages',
        'kanban/{pipelineId}/stages',
        'listPipelineStages',
        'pipelineStages',
        'pipeline/stages',
        'pipeline/{pipelineId}/stages',
        'pipelines/{pipelineId}/stages',
        'listStages',
        'stages',
        'stages/list',
        'steps',
        'funil/stages',
        'funil/etapas',
        'funil/kanban/stages',
        'funil/kanban/{pipelineId}/stages',
        'funil/pipelines/{pipelineId}/stages',
        'funil/{pipelineId}/stages',
        'crm/stages',
        'crm/kanban/stages',
        'crm/funil/stages',
      ]),
      tickets: zpro.endpointAliases('tickets', [
        'listTickets',
        'tickets',
        'tickets/list',
        'findTickets',
        'searchTickets',
        'findTicket',
        'searchTicket',
        'listContacts',
        'contacts',
        'contacts/list',
        'contacts/find',
        'contact/list',
        'atendimentos',
        'atendimentos/list',
        'funil/tickets',
        'funil/kanban',
        'funil/kanban/tickets',
        'crm/tickets',
        'crm/contacts',
      ]),
      opportunities: zpro.endpointAliases('opportunities', [
        'listOpportunities',
        'opportunities',
        'opportunity',
        'listKanbanCards',
        'kanbanCards',
        'kanban/cards',
        'kanban/cards/list',
        'kanban/list',
        'cards',
        'cards/list',
        'funil/kanban',
        'funil/kanban/cards',
        'funil/cards',
        'crm/opportunities',
        'crm/kanban/cards',
        'crm/funil/kanban/cards',
      ]),
    };

    return res.json({
      ok: true,
      resources,
      endpoints,
      envKeys: [
        'ZPRO_ENDPOINT_USERS',
        'ZPRO_ENDPOINT_QUEUES',
        'ZPRO_ENDPOINT_PIPELINES',
        'ZPRO_ENDPOINT_STAGES',
        'ZPRO_ENDPOINT_TICKETS',
        'ZPRO_ENDPOINT_OPPORTUNITIES',
        'ZPRO_ENDPOINT_ASSIGN_TICKET',
        'ZPRO_ENDPOINT_MOVE_OPPORTUNITY',
      ],
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/integrations/:integrationId/zpro/sync/:kind', async (req, res, next) => {
  try {
    const integration = await loadIntegration(getIntegrationId(req));
    await assertCanAdminTenant(req, integration.tenant_id);

    const kind = req.params.kind;
    const filters = compactObject(req.body?.filters || req.query || {});
    const kinds = kind === 'all' ? ['users', 'queues', 'pipelines', 'stages'] : [kind];
    const results = await syncZproReferenceSet(integration, kinds, filters);

    return res.json({
      ok: true,
      integration: cleanIntegration(integration),
      results: sanitizeObject(results),
    });
  } catch (err) {
    return zproErrorResponse(res, err);
  }
});

adminRouter.post('/zpro/reference/sync', async (req, res, next) => {
  try {
    const integration = await loadIntegration(getIntegrationId(req));
    await assertCanAdminTenant(req, integration.tenant_id);

    const kind = req.body?.kind || req.query?.kind || 'all';
    const filters = compactObject(req.body?.filters || req.query || {});
    const kinds = kind === 'all' ? ['users', 'queues', 'pipelines', 'stages'] : [kind];
    const results = await syncZproReferenceSet(integration, kinds, filters);

    return res.json({
      ok: true,
      integration: cleanIntegration(integration),
      results: sanitizeObject(results),
    });
  } catch (err) {
    return zproErrorResponse(res, err);
  }
});

adminRouter.get('/zpro/reference', async (req, res, next) => {
  try {
    const integration = await loadIntegration(getIntegrationId(req));
    await assertCanManageTenant(req, integration.tenant_id);

    const [users, queues, pipelines, stages, rules] = await Promise.all([
      supabaseAdmin
        .from('crm_ai_zpro_users_cache')
        .select('*')
        .eq('tenant_id', integration.tenant_id)
        .eq('integration_id', integration.id)
        .order('name', { ascending: true }),
      supabaseAdmin
        .from('crm_ai_zpro_queues_cache')
        .select('*')
        .eq('tenant_id', integration.tenant_id)
        .eq('integration_id', integration.id)
        .order('name', { ascending: true }),
      supabaseAdmin
        .from('crm_ai_zpro_pipelines_cache')
        .select('*')
        .eq('tenant_id', integration.tenant_id)
        .eq('integration_id', integration.id)
        .order('name', { ascending: true }),
      supabaseAdmin
        .from('crm_ai_zpro_stages_cache')
        .select('*')
        .eq('tenant_id', integration.tenant_id)
        .eq('integration_id', integration.id)
        .order('position', { ascending: true }),
      supabaseAdmin
        .from('crm_ai_stage_assignment_rules')
        .select('*')
        .eq('tenant_id', integration.tenant_id)
        .eq('integration_id', integration.id),
    ]);

    for (const result of [users, queues, pipelines, stages, rules]) {
      if (result.error) throw result.error;
    }

    return res.json({
      ok: true,
      integration: cleanIntegration(integration),
      users: users.data || [],
      queues: queues.data || [],
      pipelines: pipelines.data || [],
      stages: stages.data || [],
      rules: rules.data || [],
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/zpro/stage-rules', async (req, res, next) => {
  try {
    const integration = await loadIntegration(getIntegrationId(req));
    await assertCanManageTenant(req, integration.tenant_id);

    const { data, error } = await supabaseAdmin
      .from('crm_ai_stage_assignment_rules')
      .select('*')
      .eq('tenant_id', integration.tenant_id)
      .eq('integration_id', integration.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    return res.json({
      ok: true,
      rules: data || [],
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/zpro/stage-rules', async (req, res, next) => {
  try {
    const body = req.body || {};
    const integration = await loadIntegration(getIntegrationId(req));
    await assertCanAdminTenant(req, integration.tenant_id);

    const payload = {
      tenant_id: integration.tenant_id,
      integration_id: integration.id,
      external_pipeline_id: String(body.external_pipeline_id || body.pipelineId || ''),
      external_stage_id: String(body.external_stage_id || body.stageId || ''),
      external_queue_id: body.external_queue_id || body.queueId || null,
      distribution_mode: body.distribution_mode || body.distributionMode || 'balanced_rotation',
      user_order: Array.isArray(body.user_order)
        ? body.user_order
        : Array.isArray(body.userOrder)
          ? body.userOrder
          : [],
      active: body.active !== false,
    };

    if (!payload.external_pipeline_id) throw httpError(400, 'Funil obrigatorio');
    if (!payload.external_stage_id) throw httpError(400, 'Etapa obrigatoria');

    const { data, error } = await supabaseAdmin
      .from('crm_ai_stage_assignment_rules')
      .upsert(payload, {
        onConflict: 'integration_id,external_pipeline_id,external_stage_id',
      })
      .select('*')
      .single();

    if (error) throw error;

    return res.json({
      ok: true,
      rule: data,
      message: 'Regra de etapa salva.',
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/zpro/live/leads', async (req, res, next) => {
  try {
    const integration = await loadIntegration(getIntegrationId(req));
    await assertCanManageTenant(req, integration.tenant_id);

    const filters = compactObject({
      userId: req.query.userId,
      assignedUserId: req.query.userId,
      queueId: req.query.queueId,
      pipelineId: req.query.pipelineId,
      stageId: req.query.stageId,
      status: req.query.status,
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
      limit: req.query.limit || 100,
    });

    const zpro = await createZproService(integration);
    const response = await readZproPagedList(zpro, 'listTickets', filters);
    const items = response.items;

    logInfo('admin.zpro.live_leads_read', {
      requestId: req.requestId,
      integrationId: integration.id,
      tenantId: integration.tenant_id,
      count: items.length,
      filters,
      endpoint: response.endpoint,
    });

    return res.json({
      ok: true,
      source: 'zpro_live',
      persisted: false,
      endpoint: response.endpoint,
      filters,
      count: items.length,
      items: sanitizeObject(items),
      pagination: response.pagination,
      raw: sanitizeObject(response.data),
    });
  } catch (err) {
    return zproErrorResponse(res, err);
  }
});

adminRouter.get('/zpro/live/opportunities', async (req, res, next) => {
  try {
    const integration = await loadIntegration(getIntegrationId(req));
    await assertCanManageTenant(req, integration.tenant_id);

    const filters = compactObject({
      userId: req.query.userId,
      assignedUserId: req.query.userId,
      pipelineId: req.query.pipelineId,
      stageId: req.query.stageId,
      status: req.query.status,
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
      limit: req.query.limit || 100,
    });

    const zpro = await createZproService(integration);
    const response = await readZproPagedList(zpro, 'listOpportunities', filters);
    const items = response.items;

    return res.json({
      ok: true,
      source: 'zpro_live',
      persisted: false,
      endpoint: response.endpoint,
      filters,
      count: items.length,
      items: sanitizeObject(items),
      pagination: response.pagination,
      raw: sanitizeObject(response.data),
    });
  } catch (err) {
    return zproErrorResponse(res, err);
  }
});

adminRouter.post('/zpro/redistribute/preview', async (req, res, next) => {
  try {
    const { integrationId, items = [], targetUsers = [], mode = 'balanced' } = req.body || {};
    const integration = await loadIntegration(integrationId);
    await assertCanManageTenant(req, integration.tenant_id);

    if (!Array.isArray(items) || items.length === 0) {
      throw httpError(400, 'Selecione ao menos um lead da consulta ao vivo');
    }

    const uniqueItems = dedupeItems(items);
    const assignments = distributeItems(uniqueItems, targetUsers, mode);
    const summary = assignments.reduce((acc, item) => {
      acc[item.targetUserId] = acc[item.targetUserId] || {
        targetUserId: item.targetUserId,
        targetUserName: item.targetUserName,
        count: 0,
      };
      acc[item.targetUserId].count += 1;
      return acc;
    }, {});

    return res.json({
      ok: true,
      persisted: false,
      executable: false,
      totalReceived: items.length,
      totalUnique: uniqueItems.length,
      duplicatesIgnored: items.length - uniqueItems.length,
      assignments: sanitizeObject(assignments),
      summary: Object.values(summary),
      message: 'Previa gerada sem gravar leads no banco. Execucao real depende do endpoint de reatribuicao do Z-PRO.',
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/zpro/redistribute', async (req, res, next) => {
  try {
    const { integrationId, assignments = [], confirm = false } = req.body || {};
    const integration = await loadIntegration(integrationId);
    await assertCanManageTenant(req, integration.tenant_id);

    if (!confirm) {
      throw httpError(400, 'Confirme a execucao depois de revisar a previa');
    }

    if (!Array.isArray(assignments) || assignments.length === 0) {
      throw httpError(400, 'Nenhuma redistribuicao informada');
    }

    const zpro = await createZproService(integration);
    const results = [];

    for (const assignment of assignments) {
      const itemId = assignment.itemId || getLeadExternalId(assignment.item);
      if (!itemId) {
        results.push({
          ok: false,
          itemId,
          error: 'Lead sem identificador externo',
        });
        continue;
      }

      const result = await zpro.updateTicketAssignment({
        ticketId: itemId,
        userId: assignment.targetUserId,
      });

      results.push({
        ok: true,
        itemId,
        targetUserId: assignment.targetUserId,
        endpoint: result.endpoint,
        data: sanitizeObject(result.data),
      });
    }

    return res.json({
      ok: true,
      results,
    });
  } catch (err) {
    return zproErrorResponse(res, err);
  }
});

adminRouter.post('/zpro/stage-move/preview', async (req, res, next) => {
  try {
    const {
      integrationId,
      items = [],
      targetPipelineId,
      targetStageId,
      quantity,
    } = req.body || {};
    const integration = await loadIntegration(integrationId);
    await assertCanManageTenant(req, integration.tenant_id);

    if (!targetPipelineId) throw httpError(400, 'Selecione o funil de destino');
    if (!targetStageId) throw httpError(400, 'Selecione a etapa de destino');
    if (!Array.isArray(items) || items.length === 0) {
      throw httpError(400, 'Selecione ao menos um lead da consulta ao vivo');
    }

    const uniqueItems = dedupeItems(items);
    const limit = Number(quantity || uniqueItems.length);
    const selected = uniqueItems.slice(0, Math.max(0, limit));
    const moves = selected.map((item) => ({
      item,
      itemId: getLeadExternalId(item),
      targetPipelineId: String(targetPipelineId),
      targetStageId: String(targetStageId),
    }));

    return res.json({
      ok: true,
      persisted: false,
      totalReceived: items.length,
      totalUnique: uniqueItems.length,
      selected: moves.length,
      duplicatesIgnored: items.length - uniqueItems.length,
      moves: sanitizeObject(moves),
      message: 'Previa gerada sem gravar leads no banco. Duplicados por telefone/contato foram ignorados.',
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/zpro/stage-move', async (req, res, next) => {
  try {
    const {
      integrationId,
      moves = [],
      targetPipelineId,
      targetStageId,
      confirm = false,
    } = req.body || {};
    const integration = await loadIntegration(integrationId);
    await assertCanManageTenant(req, integration.tenant_id);

    if (!confirm) throw httpError(400, 'Confirme a execucao depois de revisar a previa');
    if (!targetPipelineId) throw httpError(400, 'Selecione o funil de destino');
    if (!targetStageId) throw httpError(400, 'Selecione a etapa de destino');
    if (!Array.isArray(moves) || moves.length === 0) {
      throw httpError(400, 'Nenhuma movimentacao informada');
    }

    const zpro = await createZproService(integration);
    const results = [];

    for (const move of moves) {
      const itemId = move.itemId || getLeadExternalId(move.item);
      if (!itemId) {
        results.push({
          ok: false,
          itemId,
          error: 'Lead/oportunidade sem identificador externo',
        });
        continue;
      }

      const result = await zpro.moveOpportunity({
        opportunityId: itemId,
        ticketId: itemId,
        pipelineId: targetPipelineId,
        stageId: targetStageId,
      });

      results.push({
        ok: true,
        itemId,
        targetPipelineId,
        targetStageId,
        endpoint: result.endpoint,
        data: sanitizeObject(result.data),
      });
    }

    return res.json({
      ok: true,
      results,
    });
  } catch (err) {
    return zproErrorResponse(res, err);
  }
});
