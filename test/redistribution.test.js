import assert from 'node:assert/strict';
import test from 'node:test';

process.env.SUPABASE_URL ||= 'http://127.0.0.1:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';

const {
  dedupeItems,
  distributeItems,
  enrichTicketsWithOpportunities,
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
