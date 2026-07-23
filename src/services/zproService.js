export class ZproService {
  constructor({ baseUrl, token }) {
    this.baseUrl = String(baseUrl || '').replace(/\/$/, '');
    this.token = token;
  }

  async request(path = '', payload = {}) {
    if (!this.baseUrl) throw new Error('Z-PRO base_url ausente');
    if (!this.token) throw new Error('Z-PRO token ausente');

    const url = path
      ? `${this.baseUrl}/${String(path).replace(/^\//, '')}`
      : this.baseUrl;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: this.token.toLowerCase().startsWith('bearer ')
          ? this.token
          : `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
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

  async listQueues() {
    return this.request('listQueues', {});
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