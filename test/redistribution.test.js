import assert from 'node:assert/strict';
import test from 'node:test';

process.env.SUPABASE_URL ||= 'http://127.0.0.1:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';

const {
  dedupeItems,
  distributeItems,
  enrichTicketsWithOpportunities,
  localLeadTicketSnapshot,
  opportunityTicketSnapshot,
} = await import('../src/routes/admin.js');

test('consulta preserva tickets diferentes do mesmo contato', () => {
  const tickets = [
    { id: 101, contact: { id: 8, number: '5511999999999' } },
    { id: 102, contact: { id: 8, number: '5511999999999' } },
    { id: 101, contact: { id: 8, number: '5511999999999' } },
  ];

  const result = dedupeItems(tickets);
  assert.deepEqual(result.map((item) => item.id), [101, 102]);
});

test('ticket recebe funil e etapa da oportunidade correspondente', () => {
  const [ticket] = enrichTicketsWithOpportunities(
    [{ id: 7583, contact: { id: 5897, number: '5511917112598' } }],
    [{
      id: 9001,
      ticketId: 7583,
      pipelineId: 5,
      stageId: 14,
      responsibleId: 52,
    }],
  );

  assert.equal(ticket.hasOpportunity, true);
  assert.equal(ticket.opportunityId, '9001');
  assert.equal(ticket.pipelineId, '5');
  assert.equal(ticket.stageId, '14');
  assert.equal(ticket.crmOpportunity.responsibleId, '52');
});

test('redistribuicao balanceia selecionados e preserva a fila de destino', () => {
  const result = distributeItems(
    [{ id: 1 }, { id: 2 }, { id: 3 }],
    [{ id: 51, name: 'Deygles' }, { id: 83, name: 'Heddy' }],
    'balanced',
    '12',
  );

  assert.deepEqual(result.map((item) => item.targetUserId), ['51', '83', '51']);
  assert.deepEqual(result.map((item) => item.targetQueueId), ['12', '12', '12']);
});

test('fallback local preserva o id real do ticket para redistribuicao', () => {
  const ticket = localLeadTicketSnapshot({
    external_ticket_id: '8302',
    external_contact_id: '6532',
    name: 'Heddy',
    phone: '5511917112598',
    assigned_external_user_id: '45',
    status: 'transferred',
    metadata: {
      zpro: {
        queue_id: '6',
        ticket_status: 'open',
      },
    },
  });

  assert.equal(ticket.id, '8302');
  assert.equal(ticket.queueId, '6');
  assert.equal(ticket.userId, '45');
  assert.equal(ticket.status, 'open');
  assert.equal(ticket.contact.number, '5511917112598');
});

test('oportunidade so vira ticket de contingencia quando possui ticket vinculado', () => {
  assert.equal(opportunityTicketSnapshot({ id: 99, pipelineId: 4, stageId: 11 }), null);
  const ticket = opportunityTicketSnapshot({
    id: 99,
    ticketId: 8302,
    pipelineId: 4,
    stageId: 11,
    responsibleId: 45,
    contact: { id: 6532, name: 'Heddy', number: '5511917112598' },
  });
  assert.equal(ticket.id, '8302');
  assert.equal(ticket.pipelineId, 4);
  assert.equal(ticket.stageId, 11);
});
