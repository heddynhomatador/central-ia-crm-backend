export class ZproService {
  constructor({ baseUrl, token }) {
    this.baseUrl = String(baseUrl || '').replace(/\/$/, '');
    this.token = token;
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
    return this.tryRequest(['listQueues', 'queues'], {}, { methods: ['POST', 'GET'] });
  }

  async listUsers() {
    return this.tryRequest(['listUsers', 'users', 'listAgents', 'agents'], {}, { methods: ['POST', 'GET'] });
  }

  async listChannels() {
    return this.tryRequest(['listWhatsapps', 'listChannels', 'channels', 'whatsapps'], {}, { methods: ['POST', 'GET'] });
  }

  async listPipelines() {
    return this.tryRequest(['listKanbans', 'listPipelines', 'kanbans', 'pipelines'], {}, { methods: ['POST', 'GET'] });
  }

  async listStages(filters = {}) {
    return this.tryRequest(['listKanbanStages', 'listPipelineStages', 'kanbanStages', 'stages'], filters, { methods: ['POST', 'GET'] });
  }

  async listTickets(filters = {}) {
    return this.tryRequest(['listTickets', 'tickets', 'findTickets'], filters, { methods: ['POST', 'GET'] });
  }

  async listOpportunities(filters = {}) {
    return this.tryRequest(['listOpportunities', 'opportunities', 'listKanbanCards', 'kanbanCards'], filters, { methods: ['POST', 'GET'] });
  }

  async updateTicketAssignment(payload = {}) {
    return this.tryRequest(['transferTicket', 'assignTicket', 'updateTicket'], payload);
  }

  async moveOpportunity(payload = {}) {
    return this.tryRequest(['moveOpportunity', 'updateOpportunity', 'updateKanbanCard'], payload);
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
