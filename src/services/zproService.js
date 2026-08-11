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
      for (const method of methods) {
        try {
          const data = await this.request(path, { method, payload });
          return {
            endpoint: path,
            method,
            data,
          };
        } catch (err) {
          attempts.push({
            endpoint: path,
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
        'listPipelines',
        'pipelines',
        'pipeline',
        'listFunnels',
        'funnels',
        'funis',
        'funnel',
        'crm/pipelines',
        'crm/kanbans',
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
        'listPipelineStages',
        'pipelineStages',
        'pipeline/stages',
        'listStages',
        'stages',
        'steps',
        'crm/stages',
        'crm/kanban/stages',
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
        'findTickets',
        'searchTickets',
        'listContacts',
        'contacts',
        'contacts/list',
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
        'cards',
        'crm/opportunities',
        'crm/kanban/cards',
      ]),
      filters,
      { methods: ['POST', 'GET'] },
    );
  }

  async updateTicketAssignment(payload = {}) {
    return this.tryRequest(this.endpointAliases('assign_ticket', ['transferTicket', 'assignTicket', 'updateTicket']), payload);
  }

  async moveOpportunity(payload = {}) {
    return this.tryRequest(this.endpointAliases('move_opportunity', ['moveOpportunity', 'updateOpportunity', 'updateKanbanCard']), payload);
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
