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
  });
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
      const data = await zpro[reader.method]();

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
