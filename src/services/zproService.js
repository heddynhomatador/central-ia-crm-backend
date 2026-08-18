function zproNumber(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : value;
}

function zproOptionalNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  return zproNumber(value);
}

export class ZproService {
  constructor({ baseUrl, token }) {
    this.baseUrl = String(baseUrl || '').replace(/\/$/, '');
    this.token = token;
  }

  endpointAliases(resource, defaults = []) {
    const key = `ZPRO_ENDPOINT_${String(resource || '').toUpperCase()}`;
    const configured = String(process.env[key] || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);

    return Array.from(new Set([...configured, ...defaults]));
  }

  fillEndpointTemplate(path, payload = {}) {
    const replacements = {
      pipelineId: payload.pipelineId || payload.pipeline_id || payload.external_pipeline_id,
      stageId: payload.stageId || payload.stage_id || payload.external_stage_id,
      queueId: payload.queueId || payload.queue_id || payload.external_queue_id,
      ticketId: payload.ticketId || payload.ticket_id || payload.id,
      opportunityId: payload.opportunityId || payload.opportunity_id || payload.cardId || payload.card_id || payload.id,
      userId: payload.userId || payload.user_id || payload.assignedUserId || payload.assigned_user_id,
    };

    let nextPath = String(path || '');
    for (const [key, value] of Object.entries(replacements)) {
      if (nextPath.includes(`{${key}}`) && (value === undefined || value === null || value === '')) {
        return null;
      }
      nextPath = nextPath.replaceAll(`{${key}}`, encodeURIComponent(String(value ?? '')));
    }

    return nextPath;
  }

  async request(path = '', options = {}) {
    if (!this.baseUrl) throw new Error('Z-PRO base_url ausente');
    if (!this.token) throw new Error('Z-PRO token ausente');

    const method = options.method || 'POST';
    const payload = Object.hasOwn(options, 'payload') ? options.payload : options;
    let url = path
      ? `${this.baseUrl}/${String(path).replace(/^\//, '')}`
      : this.baseUrl;
    const queryPayload = method === 'GET' ? payload : {};
    const query = new URLSearchParams();

    for (const [key, value] of Object.entries(queryPayload || {})) {
      if (value !== undefined && value !== null && value !== '') {
        query.set(key, String(value));
      }
    }

    if (method === 'GET' && Array.from(query.keys()).length > 0) {
      url = `${url}${url.includes('?') ? '&' : '?'}${query.toString()}`;
    }

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: this.token.toLowerCase().startsWith('bearer ')
          ? this.token
          : `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: method === 'GET' ? undefined : JSON.stringify(payload),
    });

    const text = await response.text();

    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!response.ok) {
      const error = new Error(`Z-PRO ${response.status}: ${text}`);
      error.status = response.status;
      error.zproStatus = response.status;
      error.zproBody = data;
      error.endpoint = url;
      error.method = method;
      error.payload = payload;
      throw error;
    }

    return data;
  }

  async tryRequest(paths, payload = {}, options = {}) {
    const attempts = [];
    const methods = options.methods || ['POST'];

    for (const path of paths) {
      const resolvedPath = this.fillEndpointTemplate(path, payload);
      if (!resolvedPath) {
        attempts.push({
          endpoint: path,
          method: '-',
          error: 'Endpoint exige parametros que ainda nao foram informados.',
        });
        continue;
      }

      for (const method of methods) {
        try {
          const data = await this.request(resolvedPath, { method, payload });
          return {
            endpoint: resolvedPath,
            method,
            data,
          };
        } catch (err) {
          attempts.push({
            endpoint: resolvedPath,
            method,
            status: err.status || err.zproStatus,
            error: err.message || String(err),
            payload,
          });
        }
      }
    }

    const meaningfulAttempt = attempts.find((attempt) => {
      const status = Number(attempt.status || 0);
      return status && status !== 404 && status !== 405;
    });

    if (meaningfulAttempt) {
      const error = new Error(meaningfulAttempt.error);
      const status = Number(meaningfulAttempt.status || 502);
      error.statusCode = status >= 400 && status < 500 ? status : 502;
      error.code = 'ZPRO_REQUEST_FAILED';
      error.attempts = attempts;
      throw error;
    }

    const error = new Error(
      'Nenhuma rota conhecida do Z-PRO respondeu para este recurso. Confirme os endpoints oficiais ou configure o mapeamento no backend.'
    );
    error.statusCode = 501;
    error.code = 'ZPRO_ENDPOINT_NOT_MAPPED';
    error.attempts = attempts;
    throw error;
  }

  notMapped(resource) {
    const error = new Error(
      `Endpoint do Z-PRO ainda nao mapeado para ${resource}. Confirme a rota oficial no Z-PRO antes de ativar esta sincronizacao.`
    );
    error.statusCode = 501;
    error.code = 'ZPRO_ENDPOINT_NOT_MAPPED';
    throw error;
  }

  async listQueues() {
    return this.tryRequest(this.endpointAliases('queues', ['listQueues', 'queues']), {}, { methods: ['GET', 'POST'] });
  }

  async listUsers(filters = {}) {
    const payload = {
      pageNumber: filters.pageNumber || filters.page || filters.currentPage,
      searchParam: filters.searchParam || filters.search,
    };

    return this.tryRequest(
      this.endpointAliases('users', ['listUsers', 'users', 'listAgents', 'agents']),
      payload,
      { methods: ['GET', 'POST'] },
    );
  }

  async listChannels() {
    return this.tryRequest(
      this.endpointAliases('channels', ['listSessions', 'listWhatsapps', 'listChannels', 'sessions', 'channels', 'whatsapps']),
      {},
      { methods: ['GET', 'POST'] },
    );
  }

  async listPipelines(filters = {}) {
    const payload = {
      page: filters.page || filters.pageNumber || filters.currentPage,
      limit: filters.limit,
    };

    return this.tryRequest(
      this.endpointAliases('pipelines', [
        'pipeline/list',
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
      payload,
      { methods: ['GET', 'POST'] },
    );
  }

  async listStages(filters = {}) {
    const payload = {
      page: filters.page || filters.pageNumber || filters.currentPage,
      limit: filters.limit,
      pipelineId: filters.pipelineId || filters.pipeline_id || filters.external_pipeline_id,
    };

    return this.tryRequest(
      this.endpointAliases('stages', [
        'stage/list',
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
      payload,
      { methods: ['GET', 'POST'] },
    );
  }

  async listTickets(filters = {}) {
    const payload = {
      pageNumber: filters.pageNumber || filters.page || filters.currentPage,
      status: filters.status,
      queuesIds: filters.queuesIds || filters.queueId || filters.queue_id,
      whatsappIds: filters.whatsappIds || filters.whatsappId || filters.channelId || filters.channel_id,
      searchParam: filters.searchParam || filters.search,
    };

    return this.tryRequest(
      this.endpointAliases('tickets', [
        'listTickets',
        'tickets',
        'tickets/list',
        'findTickets',
        'searchTickets',
        'findTicket',
        'searchTicket',
        'atendimentos',
        'atendimentos/list',
        'funil/tickets',
        'funil/kanban',
        'funil/kanban/tickets',
        'crm/tickets',
      ]),
      payload,
      { methods: ['GET', 'POST'] },
    );
  }

  async listOpportunities(filters = {}) {
    const payload = {
      page: filters.page || filters.pageNumber || filters.currentPage,
      limit: filters.limit,
      status: filters.status,
      pipelineId: filters.pipelineId || filters.pipeline_id || filters.external_pipeline_id,
    };

    return this.tryRequest(
      this.endpointAliases('opportunities', [
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
      payload,
      { methods: ['GET', 'POST'] },
    );
  }

  async updateTicketAssignment(payload = {}) {
    return this.tryRequest(
      this.endpointAliases('assign_ticket', [
        'updateticketinfo',
        'transferTicket',
        'assignTicket',
        'updateTicket',
        'ticket/{ticketId}/assign',
        'tickets/{ticketId}/assign',
        'tickets/assign',
        'ticket/transfer',
        'tickets/transfer',
        'transferir',
        'atendimento/transferir',
        'atendimentos/transferir',
        'updateTicketUser',
        'setTicketUser',
        'assignUser',
      ]),
      {
        ticketId: zproNumber(payload.ticketId || payload.ticket_id || payload.id),
        userId: zproOptionalNumber(payload.userId || payload.user_id || payload.assignedUserId || payload.assigned_user_id),
        status: payload.status || undefined,
        queueId: payload.queueId || payload.queue_id || payload.external_queue_id || null,
        typebotStatus: payload.typebotStatus ?? false,
        chatgptStatus: payload.chatgptStatus ?? false,
        dialogflowStatus: payload.dialogflowStatus ?? false,
        difyStatus: payload.difyStatus ?? false,
        n8nStatus: payload.n8nStatus ?? false,
        chatFlowId: payload.chatFlowId ?? null,
      },
    );
  }

  async moveOpportunity(payload = {}) {
    return this.tryRequest(
      this.endpointAliases('move_opportunity', [
        'updateOpportunity',
        'moveOpportunity',
        'updateKanbanCard',
        'moveKanbanCard',
        'moveCard',
        'updateCard',
        'opportunity/{opportunityId}/move',
        'opportunities/{opportunityId}/move',
        'kanban/cards/{opportunityId}/move',
        'kanban/cards/move',
        'kanban/move',
        'cards/update',
        'cards/move',
        'funil/kanban/move',
        'funil/cards/update',
      ]),
      {
        opportunityId: zproNumber(payload.opportunityId || payload.opportunity_id || payload.cardId || payload.card_id || payload.id),
        name: payload.name || payload.title || undefined,
        value: payload.value === undefined || payload.value === null ? undefined : Number(payload.value),
        status: payload.status || 'open',
        pipelineId: zproNumber(payload.pipelineId || payload.pipeline_id),
        stageId: zproNumber(payload.stageId || payload.stage_id),
        responsibleId: zproNumber(payload.responsibleId || payload.responsible_id || payload.userId || payload.user_id),
        closingForecast: payload.closingForecast || payload.closing_forecast || undefined,
        description: payload.description || undefined,
      },
    );
  }

  async createOpportunity(payload = {}) {
    return this.tryRequest(
      this.endpointAliases('create_opportunity', ['createOpportunity']),
      {
        number: payload.number || payload.phone,
        contactName: payload.contactName || payload.contact_name || payload.name,
        email: payload.email || undefined,
        name: payload.name || payload.title,
        value: Number(payload.value ?? 0),
        status: payload.status || 'open',
        pipelineId: zproNumber(payload.pipelineId || payload.pipeline_id),
        stageId: zproNumber(payload.stageId || payload.stage_id),
        responsibleId: zproNumber(payload.responsibleId || payload.responsible_id || payload.userId || payload.user_id),
        closingForecast: payload.closingForecast || payload.closing_forecast || undefined,
        description: payload.description || undefined,
        validateNumber: payload.validateNumber !== false,
      },
    );
  }

  async sendMessage({ number, body }) {
    return this.request('', {
      number,
      body,
      externalKey: crypto.randomUUID(),
      isClosed: false,
      validateNumber: true,
    });
  }
}
