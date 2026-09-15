import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { ZproService, messageExternalKey, parseZproBaseUrl } from '../src/services/zproService.js';

async function fakeZpro(t, status = 200, response = { success: true }) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ path: req.url, method: req.method, headers: req.headers,
      body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return {
    requests,
    zpro: new ZproService({ baseUrl: `http://127.0.0.1:${server.address().port}/v2/api/external/test-api`, token: 'test-token' }),
  };
}

test('resposta usa endpoint oficial por ticket, sem reabrir nem selecionar canal por numero', async (t) => {
  const { zpro, requests } = await fakeZpro(t);
  const externalKey = messageExternalKey('ai_reply', 'integration-a', 'wamid-1');
  const result = await zpro.sendMessage({ ticketId: '17104', number: '5511000000000',
    body: 'Posso ajudar.', validateNumber: false, externalKey });
  assert.equal(result.endpoint, 'sendMessageByTicket');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/v2/api/external/test-api/sendMessageByTicket');
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].headers.authorization, 'Bearer test-token');
  assert.deepEqual(requests[0].body, { ticketId: 17104, body: 'Posso ajudar.', externalKey, reopen: false, isClosed: false });
});

test('envio legado sem ticket preserva contrato por numero', async (t) => {
  const { zpro, requests } = await fakeZpro(t);
  await zpro.sendMessage({ number: '5511000000000', body: 'Teste', externalKey: 'legacy' });
  assert.equal(requests[0].path, '/v2/api/external/test-api');
  assert.equal(requests[0].body.validateNumber, true);
  assert.equal(requests[0].body.number, '5511000000000');
});

test('WABA sem ticket valido nao faz envio por numero como contingencia', async (t) => {
  const { zpro, requests } = await fakeZpro(t);
  for (const ticketId of [undefined, null, '', 'invalid', 0, -1, 1.5]) {
    await assert.rejects(zpro.sendMessage({ ticketId, requireTicket: true, number: '5511000000000', body: 'Teste' }),
      { code: 'ZPRO_TICKET_REQUIRED' });
  }
  assert.equal(requests.length, 0);
});

for (const status of [400, 401, 403, 404, 405, 409, 429, 500]) {
  test(`envio por ticket nao tenta outra rota nem outro canal depois de HTTP ${status}`, async (t) => {
    const { zpro, requests } = await fakeZpro(t, status, { success: false, error: 'TEST_ERROR' });
    await assert.rejects(zpro.sendMessage({ ticketId: '17104', body: 'Teste' }), { zproStatus: status });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.reopen, false);
  });
}

test('HTTP 200 com success false nao e registrado como mensagem enviada', async (t) => {
  const { zpro, requests } = await fakeZpro(t, 200, { success: false, error: 'ERR_API_REQUIRES_SESSION' });
  await assert.rejects(zpro.sendMessage({ ticketId: '17104', body: 'Teste' }), (err) => {
    assert.equal(err.code, 'ZPRO_API_REQUIRES_SESSION');
    assert.match(err.configurationHint, /sessao deste canal/);
    return true;
  });
  assert.equal(requests.length, 1);
});

test('timeout de envio nao dispara segunda tentativa em outro endpoint', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new DOMException('Timeout', 'TimeoutError'); });
  const zpro = new ZproService({ baseUrl: 'http://127.0.0.1/unused', token: 'test' });
  await assert.rejects(zpro.sendMessage({ ticketId: '17104', body: 'Teste' }), { name: 'TimeoutError' });
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('oportunidade preserva codigo de configuracao e nao repete criacao rejeitada', async (t) => {
  const { zpro, requests } = await fakeZpro(t, 400, { error: 'ERR_API_REQUIRES_SESSION' });
  await assert.rejects(zpro.createOpportunity({ number: '5511000000000', pipelineId: '22', stageId: '50', validateNumber: false }),
    { code: 'ZPRO_API_REQUIRES_SESSION' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.validateNumber, false);
  assert.equal(requests[0].body.pipelineId, 22);
});

test('chave de envio e estavel por evento e isolada por integracao e tarefa', () => {
  const key = messageExternalKey('ai_reply', 'integration-a', 'wamid-1');
  assert.equal(key, messageExternalKey('ai_reply', 'integration-a', 'wamid-1'));
  assert.notEqual(key, messageExternalKey('ai_reply', 'integration-b', 'wamid-1'));
  assert.notEqual(key, messageExternalKey('ai_reply', 'integration-a', 'wamid-2'));
  assert.notEqual(key, messageExternalKey('followup', 'integration-a', 'wamid-1'));
});

test('404 Cannot POST da versao instalada permite envio legado apenas apos verificar ticket e canal', async (t) => {
  const calls = [];
  const baseUrl = 'https://legacy.test/v2/api/external/official';
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    if (String(url).endsWith('/sendMessageByTicket')) {
      return new Response('<pre>Cannot POST /v2/api/external/official/sendMessageByTicket</pre>', { status: 404 });
    }
    if (String(url).endsWith('/showTicketById')) {
      return Response.json({ ticket: { id: 17107, status: 'pending', userId: null, whatsappId: 45, contact: { number: '5511000000000' } } });
    }
    assert.equal(String(url), baseUrl);
    return Response.json({ success: true });
  });
  const zpro = new ZproService({ baseUrl, token: 'official-test-token' });
  const args = { ticketId: '17107', channelId: '45', number: '5511000000000', body: 'Mais informacoes', externalKey: 'stable-1' };
  const result = await zpro.sendMessage(args);
  assert.equal(result.compatibility, 'verified_pending_ticket');
  assert.deepEqual(calls.map((call) => call.url), [`${baseUrl}/sendMessageByTicket`, `${baseUrl}/showTicketById`, baseUrl]);
  assert.deepEqual(calls[2].body, { number: args.number, body: args.body, externalKey: 'stable-1', isClosed: false, validateNumber: false });
  assert.equal(calls[0].body.externalKey, calls[2].body.externalKey);
  await zpro.sendMessage({ ...args, externalKey: 'stable-2' });
  assert.equal(calls.length, 5);
  assert.equal(calls[3].url, `${baseUrl}/showTicketById`);
  const anotherCredential = new ZproService({ baseUrl, token: 'different-token' });
  await anotherCredential.sendMessage({ ...args, externalKey: 'stable-3' });
  assert.equal(calls[5].url, `${baseUrl}/sendMessageByTicket`);
});

for (const [label, patch] of [
  ['fechado', { status: 'closed' }],
  ['aberto com humano', { status: 'open', userId: 5 }],
  ['pendente atribuido', { userId: 5 }],
  ['outro canal', { whatsappId: 99 }],
  ['outro contato', { contact: { number: '5511000000001' } }],
  ['outro ticket', { id: 999 }],
  ['sem telefone', { contact: {} }],
  ['sem canal', { whatsappId: null }],
]) {
  test(`compatibilidade nao envia quando ticket esta ${label}`, async (t) => {
    const calls = [];
    const baseUrl = `https://legacy.test/v2/api/external/${encodeURIComponent(label)}`;
    t.mock.method(globalThis, 'fetch', async (url) => {
      calls.push(String(url));
      if (String(url).endsWith('/sendMessageByTicket')) {
        return new Response(`<pre>Cannot POST ${new URL(String(url)).pathname}</pre>`, { status: 404 });
      }
      assert.equal(String(url), `${baseUrl}/showTicketById`);
      return Response.json({ id: 17107, status: 'pending', userId: null, whatsappId: 45, contact: { number: '5511000000000' }, ...patch });
    });
    const zpro = new ZproService({ baseUrl, token: 'test' });
    await assert.rejects(zpro.sendMessage({ ticketId: 17107, channelId: 45, number: '5511000000000', body: 'Teste' }),
      { code: 'ZPRO_REPLY_TICKET_NOT_VERIFIED' });
    assert.equal(calls.length, 2);
  });
}

test('URL invalida ou token colado como URL e recusado sem devolver o valor sensivel', () => {
  for (const invalid of ['secret-token-value', '', 'javascript:alert(1)', 'https://user:secret@zpro.test/v2/api/external/id',
    'https://zpro.test/v2/api/external/id?token=secret', 'https://zpro.test', 'https://zpro.test/v2/api/external/id/sendMessageByTicket']) {
    assert.throws(() => parseZproBaseUrl(invalid), (error) => {
      assert.equal(error.code, 'ZPRO_INVALID_BASE_URL');
      assert.equal(error.statusCode, 400);
      assert.doesNotMatch(error.message, /secret/);
      return true;
    });
  }
  assert.deepEqual(parseZproBaseUrl(' https://zpro.test/v2/api/external/api-uuid/ '), {
    baseUrl: 'https://zpro.test/v2/api/external/api-uuid', apiId: 'api-uuid',
  });
});
