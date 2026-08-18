import assert from 'node:assert/strict';
import test from 'node:test';

process.env.SUPABASE_URL ||= 'http://127.0.0.1:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';

const {
  appointmentIntentDetected,
  applyRoutingRuleToDecision,
  buildLeadMetadata,
  closingAcknowledgementDetected,
  explicitCloseIntent,
  fallbackContinuationReply,
  humanRequestDetected,
  normalizeAiDecisionForWorkflow,
  selectedAppointmentOptionFromContext,
} = await import('../src/routes/zproWebhook.js');
const { roundRobinUserForPolicy } = await import('../src/services/followupWorker.js');

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

test('confirmacao curta depois do encerramento nao reabre a IA', () => {
  const previous = {
    ai_state: {
      stopped: true,
      reason: 'ticket_closed_by_ai',
      ticket_id: '3029',
      stopped_at: new Date().toISOString(),
    },
  };

  const metadata = buildLeadMetadata({
    ticketId: '3033',
    ticketStatus: 'pending',
    text: 'Isso',
    isAudio: false,
  }, previous);

  assert.equal(closingAcknowledgementDetected('Combinado!'), true);
  assert.equal(metadata.ai_state.stopped, true);
  assert.equal(metadata.ai_state.reason, 'post_close_acknowledgement');
  assert.equal(metadata.ai_state.ticket_id, '3033');
});

test('mensagem relevante em novo ticket inicia um ciclo limpo', () => {
  const metadata = buildLeadMetadata({
    ticketId: '4002',
    ticketStatus: 'pending',
    text: 'Quero conhecer outro produto',
    isAudio: false,
  }, {
    ai_state: {
      stopped: true,
      reason: 'ticket_closed_by_ai',
      ticket_id: '4001',
      stopped_at: new Date().toISOString(),
    },
  });

  assert.equal(metadata.ai_state.stopped, false);
  assert.equal(metadata.ai_state.reason, 'new_ticket_started');
  assert.equal(metadata.ai_state.ticket_id, '4002');
});

test('resposta a pergunta final encerra sem repetir qualificacao', () => {
  const context = [{ role: 'assistant', content: 'Tem mais alguma duvida antes da nossa reuniao?' }];
  assert.equal(explicitCloseIntent({ parsed: { text: 'Nenhuma, muito obrigado' }, context }), true);
});

test('agenda continua somente a partir do contexto e das opcoes validadas', () => {
  const invitation = [{ role: 'assistant', content: 'Quer agendar uma demonstracao?' }];
  assert.equal(appointmentIntentDetected({ parsed: { text: 'Pode ser' }, context: invitation }), true);
  assert.equal(appointmentIntentDetected({ parsed: { text: 'Como funciona?' }, context: [] }), false);

  const option = selectedAppointmentOptionFromContext([{
    role: 'assistant',
    content: 'Tenho estes horarios livres.',
    metadata: {
      decision: {
        appointment_options: [
          { date: '2026-08-19', time: '15:00', label: 'qua. 19/08, 15:00' },
          { date: '2026-08-19', time: '16:00', label: 'qua. 19/08, 16:00' },
        ],
      },
    },
  }], '16');

  assert.equal(option?.date, '2026-08-19');
  assert.equal(option?.time, '16:00');
});

test('rodizio de follow-up respeita a ordem configurada', () => {
  const policy = { transfer_user_order: ['51', '83'] };
  assert.equal(roundRobinUserForPolicy({ ...policy, round_robin_cursor: 0 }), '51');
  assert.equal(roundRobinUserForPolicy({ ...policy, round_robin_cursor: 1 }), '83');
  assert.equal(roundRobinUserForPolicy({ ...policy, round_robin_cursor: 2 }), '51');
});

test('regra marcada para entrega humana sempre gera handoff', () => {
  const result = applyRoutingRuleToDecision({
    action: 'move_stage',
    reply: 'Continuarei conversando.',
  }, {
    external_pipeline_id: '6',
    external_stage_id: '19',
    external_queue_id: '4',
    stop_ai_after_match: true,
    handoff_message: 'Vou encaminhar para a equipe.',
  });

  assert.equal(result.action, 'handoff');
  assert.equal(result.reply, 'Vou encaminhar para a equipe.');
});
