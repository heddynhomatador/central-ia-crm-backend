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
      throw new Error(`Z-PRO ${response.status}: ${text}`);
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
            error: err.message || String(err),
          });
        }
      }
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
    return this.tryRequest(this.endpointAliases('queues', ['listQueues', 'queues']), {}, { methods: ['POST', 'GET'] });
  }

  async listUsers() {
    return this.tryRequest(this.endpointAliases('users', ['listUsers', 'users', 'listAgents', 'agents']), {}, { methods: ['POST', 'GET'] });
  }

  async listChannels() {
    return this.tryRequest(this.endpointAliases('channels', ['listWhatsapps', 'listChannels', 'channels', 'whatsapps']), {}, { methods: ['POST', 'GET'] });
  }

  async listPipelines() {
    return this.tryRequest(
      this.endpointAliases('pipelines', [
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
      {},
      { methods: ['POST', 'GET'] },
    );
  }

  async listStages(filters = {}) {
    return this.tryRequest(
      this.endpointAliases('stages', [
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
      filters,
      { methods: ['POST', 'GET'] },
    );
  }

  async listTickets(filters = {}) {
    return this.tryRequest(
      this.endpointAliases('tickets', [
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
      filters,
      { methods: ['POST', 'GET'] },
    );
  }

  async listOpportunities(filters = {}) {
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
      filters,
      { methods: ['POST', 'GET'] },
    );
  }

  async updateTicketAssignment(payload = {}) {
    return this.tryRequest(
      this.endpointAliases('assign_ticket', [
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
      payload,
    );
  }

  async moveOpportunity(payload = {}) {
    return this.tryRequest(
      this.endpointAliases('move_opportunity', [
        'moveOpportunity',
        'updateOpportunity',
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
      payload,
    );
  }

  async sendMessage({ number, body }) {
    return this.request('', {
      number,
      body,
      externalKey: crypto.randomUUID(),
      isClosed: false,
    });
  }
}
