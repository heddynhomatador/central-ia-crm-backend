import express from 'express';
import { ZproService } from '../services/zproService.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';

export const adminRouter = express.Router();

function requireAdminApiKey(req, res, next) {
  const key = req.headers['x-admin-api-key'];

  if (!process.env.ADMIN_API_KEY || key !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({
      ok: false,
      error: 'Não autorizado',
    });
  }

  next();
}

adminRouter.post('/integrations/:integrationId/zpro/token', requireAdminApiKey, async (req, res, next) => {
  try {
    const { token } = req.body || {};

    if (!token) {
      return res.status(400).json({
        ok: false,
        error: 'token obrigatório',
      });
    }

    const { error } = await supabaseAdmin.rpc('crm_ai_service_set_zpro_token', {
      p_integration_id: req.params.integrationId,
      p_token: token,
    });

    if (error) throw error;

    return res.json({
      ok: true,
      message: 'Token salvo com sucesso.',
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/integrations/:integrationId/zpro/test', requireAdminApiKey, async (req, res, next) => {
  try {
    const { data: integration, error } = await supabaseAdmin
      .from('crm_ai_integrations')
      .select('*')
      .eq('id', req.params.integrationId)
      .single();

    if (error) throw error;

    const { data: token, error: tokenError } = await supabaseAdmin.rpc('crm_ai_service_get_zpro_token', {
      p_integration_id: integration.id,
    });

    if (tokenError) throw tokenError;

    const zpro = new ZproService({
      baseUrl: integration.base_url,
      token,
    });

    let queues = null;

    try {
      queues = await zpro.listQueues();
    } catch (err) {
      queues = {
        warning: 'Token/base_url carregaram, mas listQueues falhou. Pode ser nome diferente da rota no Z-PRO.',
        detail: String(err.message || err),
      };
    }

    return res.json({
      ok: true,
      integration: {
        id: integration.id,
        name: integration.name,
        base_url: integration.base_url,
        has_token: integration.has_token,
      },
      queues,
    });
  } catch (err) {
    next(err);
  }
});