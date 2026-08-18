import assert from 'node:assert/strict';
import test from 'node:test';

process.env.SUPABASE_URL ||= 'http://127.0.0.1:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';

const {
  explicitCloseIntent,
  fallbackContinuationReply,
  humanRequestDetected,
  normalizeAiDecisionForWorkflow,
} = await import('../src/routes/zproWebhook.js');

const enabledActions = [
  { action_key: 'close_ticket', enabled: true },
  { action_key: 'transfer_ticket', enabled: true },
];

test('mensagem atual de recusa vence o assunto comercial do historico', () => {
  const context = [
    { role: 'user', content: 'Quero saber como funciona a URA' },
    { role: 'assistant', content: 'A URA realiza ligacoes automaticas.' },
  ];

  assert.equal(explicitCloseIntent({ parsed: { text: 'Nao quero saber nao' }, context }), true);
  assert.equal(explicitCloseIntent({ parsed: { text: 'Vou procurar outra ferramenta' }, context }), true);
  assert.equal(explicitCloseIntent({ parsed: { text: 'Tchau' }, context }), true);
  assert.equal(explicitCloseIntent({ parsed: { text: 'Encerra o atendimento' }, context }), true);
  assert.equal(explicitCloseIntent({ parsed: { text: 'Nao quero agendar agora' }, context }), false);
});

test('pedido humano e especifico e nao dispara por palavras soltas', () => {
  assert.equal(humanRequestDetected('Passa para um atendente'), true);
  assert.equal(humanRequestDetected('Quero falar com uma pessoa'), true);
  assert.equal(humanRequestDetected('Quantas pessoas trabalham na equipe?'), false);
  assert.equal(humanRequestDetected('Eu preciso falar com meus clientes'), false);
});

test('recusa explicita nao e convertida em fallback de qualificacao', () => {
  const result = normalizeAiDecisionForWorkflow({
    decision: {
      action: 'move_stage',
      reply: 'Me conte um pouco melhor.',
      reason: 'Cliente sem interesse',
    },
    actions: enabledActions,
    parsed: { text: 'Nao quero saber nao', name: 'Heddy' },
    lead: { name: 'Heddy' },
    context: [{ role: 'user', content: 'Como funciona a URA?' }],
  });

  assert.equal(result.action, 'close_ticket');
  assert.match(result.reply, /encerrar o atendimento/i);
  assert.doesNotMatch(result.reply, /me conta um pouco melhor/i);
});

test('pedido explicito de atendente sempre vence a decisao do modelo', () => {
  const result = normalizeAiDecisionForWorkflow({
    decision: { action: 'close_ticket', reply: 'Vou encerrar.', reason: 'decisao incorreta' },
    actions: enabledActions,
    parsed: { text: 'Passa para um atendente' },
    agent: { handoff_message: 'Vou encaminhar para nossa equipe.' },
  });

  assert.equal(result.action, 'handoff');
  assert.equal(result.reply, 'Vou encaminhar para nossa equipe.');
});

test('fallback nao repete a mesma mensagem recente', () => {
  const first = fallbackContinuationReply({ parsed: { text: 'Certo' }, lead: { name: 'Heddy' } });
  const second = fallbackContinuationReply({
    parsed: { text: 'Certo' },
    lead: { name: 'Heddy' },
    context: [{ role: 'assistant', content: first }],
  });

  assert.notEqual(second, first);
});
