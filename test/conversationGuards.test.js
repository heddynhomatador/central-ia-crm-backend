import assert from 'node:assert/strict';
import test from 'node:test';

process.env.SUPABASE_URL ||= 'http://127.0.0.1:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';

const {
  appointmentDatePreference,
  appointmentIntentDetected,
  appointmentOptionsRejected,
  appointmentPeriodPreference,
  appointmentTimePreference,
  appointmentWithoutAutomationDecision,
  applyRoutingRuleToDecision,
  buildLeadMetadata,
  closingAcknowledgementDetected,
  explicitCloseIntent,
  extractPayload,
  externalOpportunityCreateRetryAllowed,
  fallbackContinuationReply,
  humanHandoffDecisionForRequest,
  humanRequestDetected,
  isOfficialWhatsAppChannel,
  normalizeAiDecisionForWorkflow,
  selectAgentForChannel,
  selectedAppointmentOptionFromContext,
  shouldRunRoutingClassifier,
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
  assert.equal(humanRequestDetected('Quero falar com um atendnete'), true);
  assert.equal(humanRequestDetected('Me transfere para um atendete por favor'), true);
  assert.equal(humanRequestDetected('Quero falar com uma pessoa'), true);
  assert.equal(humanRequestDetected('Quantas pessoas trabalham na equipe?'), false);
  assert.equal(humanRequestDetected('Eu preciso falar com meus clientes'), false);
  assert.equal(humanRequestDetected('Quero saber como funciona o atendimento'), false);
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

  const naturalOption = selectedAppointmentOptionFromContext([{
    role: 'assistant',
    content: 'Escolha um horario.',
    metadata: {
      decision: {
        appointment_options: [
          { date: '2026-08-19', time: '15:30', label: 'quarta-feira, 19 de agosto, as 15h30' },
        ],
      },
    },
  }], 'Pode ser 15:30');
  assert.equal(naturalOption?.time, '15:30');

  const numberedOption = selectedAppointmentOptionFromContext([{
    role: 'assistant',
    metadata: {
      decision: {
        appointment_intent: true,
        appointment_options: [
          { date: '2026-08-19', time: '14:00' },
          { date: '2026-08-19', time: '15:00' },
        ],
      },
    },
  }], '2');
  assert.equal(numberedOption?.time, '15:00');
});

test('agenda permanece ativa durante pedido de periodo e cobranca de disponibilidade', () => {
  const context = [{
    role: 'assistant',
    content: 'Tenho estes horarios livres: qua. 19/08, 09:00.',
    metadata: {
      decision: {
        appointment_intent: true,
        appointment_created: false,
        appointment_options: [
          { date: '2026-08-19', time: '09:00', label: 'qua. 19/08, 09:00' },
        ],
      },
    },
  }, {
    role: 'assistant',
    content: 'Vou verificar a disponibilidade para a tarde.',
  }];

  assert.equal(appointmentIntentDetected({ parsed: { text: 'Tem a tarde nao?' }, context }), true);
  assert.equal(appointmentIntentDetected({ parsed: { text: 'Conseguiu?' }, context }), true);
  assert.equal(appointmentIntentDetected({
    parsed: { text: 'Pode ser 15:30' },
    context,
  }), true);
  assert.equal(appointmentPeriodPreference('Prefiro no periodo da tarde'), 'afternoon');
  assert.equal(appointmentPeriodPreference('Pode ser de manha'), 'morning');
});

test('agenda entende troca de data, dia da semana e horario em mensagens separadas', () => {
  const now = new Date('2026-09-02T15:00:00.000Z');
  const options = { now, timeZone: 'America/Sao_Paulo', horizonDays: 30 };

  assert.equal(appointmentDatePreference('Amanha', options), '2026-09-03');
  assert.equal(appointmentDatePreference('Amanha nao consigo', options), '');
  assert.equal(appointmentDatePreference('Nao daria para fazer na sexta?', options), '2026-09-04');
  assert.equal(appointmentDatePreference('So consigo dia 4', options), '2026-09-04');
  assert.equal(appointmentDatePreference('Pode ser quatro de setembro', options), '2026-09-04');
  assert.equal(appointmentDatePreference('Dia quatro de setembro as nove', options), '2026-09-04');
  assert.equal(appointmentDatePreference('Pode ser 08/09', options), '2026-09-08');
  assert.equal(appointmentTimePreference('Da para fazer as 15:00?'), '15:00');
  assert.equal(appointmentTimePreference('15'), '15:00');
  assert.equal(appointmentTimePreference('Pode ser as nove'), '09:00');
  assert.equal(appointmentTimePreference('Quinze e meia'), '15:30');
  assert.equal(appointmentTimePreference('as dez e quinze'), '10:15');
  assert.equal(appointmentTimePreference('So consigo dia 4'), '');
});

test('agenda aceita numero da opcao por extenso', () => {
  const context = [{
    role: 'assistant',
    metadata: {
      decision: {
        appointment_intent: true,
        appointment_options: [
          { date: '2026-09-04', time: '09:00' },
          { date: '2026-09-04', time: '10:15' },
          { date: '2026-09-07', time: '09:00' },
        ],
      },
    },
  }];

  assert.equal(selectedAppointmentOptionFromContext(context, 'dois')?.time, '10:15');
  assert.equal(selectedAppointmentOptionFromContext(context, 'tres')?.date, '2026-09-07');
  assert.equal(selectedAppointmentOptionFromContext(context, 'dez e quinze')?.time, '10:15');
});

test('agenda diferencia recusa de uma pergunta de disponibilidade', () => {
  assert.equal(appointmentOptionsRejected('Quero outro dia, amanha nao consigo'), true);
  assert.equal(appointmentOptionsRejected('Nenhum desses horarios serve'), true);
  assert.equal(appointmentOptionsRejected('Nao daria para fazer na sexta?'), false);
  assert.equal(appointmentOptionsRejected('Amanha nao consigo, mas sexta pode'), false);
  assert.equal(appointmentOptionsRejected('Amanha nao consigo, mas quatro de setembro pode'), false);
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

test('pedido de consulta sem agenda automatica segue etapa e entrega ao humano', () => {
  const rule = {
    id: 'regra-consulta',
    stage_name: 'Marcar Consulta',
    routing_instruction: 'Use quando o cliente quiser marcar consulta ou exame.',
    external_pipeline_id: '4',
    external_stage_id: '11',
    external_queue_id: '6',
    stop_ai_after_match: true,
    handoff_message: '',
  };
  const result = appointmentWithoutAutomationDecision({
    decision: {
      action: 'reply',
      appointment_intent: true,
      route_reply: 'Para marcar, fale com a clinica pelo telefone informado. Vou encaminhar voce agora.',
    },
    routingRules: [rule],
    agent: { handoff_message: 'Vou encaminhar para nossa equipe.' },
    actions: [{ action_key: 'transfer_ticket', enabled: true }],
  });

  assert.equal(result.decision.action, 'handoff');
  assert.equal(result.decision.appointment_intent, false);
  assert.equal(result.decision.pipeline_id, '4');
  assert.equal(result.decision.stage_id, '11');
  assert.equal(result.decision.queue_id, '6');
  assert.match(result.decision.reply, /telefone informado/i);
  assert.equal(result.rule.id, 'regra-consulta');
});

test('pedido humano para marcar consulta nao perde a etapa configurada', () => {
  const rule = {
    id: 'regra-consulta',
    stage_name: 'Marcar Consulta',
    routing_instruction: 'Use quando o cliente quiser marcar consulta ou exame.',
    external_pipeline_id: '4',
    external_stage_id: '11',
    external_queue_id: '6',
    stop_ai_after_match: true,
    handoff_message: 'Vou encaminhar voce para a clinica concluir o agendamento.',
  };
  const result = humanHandoffDecisionForRequest({
    agent: { handoff_message: 'Vou encaminhar para nossa equipe.' },
    integration: { sales_queue_id: '2' },
    routingRules: [rule],
    parsed: { text: 'Pode passar para um atendente marcar a consulta, por favor?' },
  });

  assert.equal(result.rule.id, 'regra-consulta');
  assert.equal(result.decision.action, 'handoff');
  assert.equal(result.decision.pipeline_id, '4');
  assert.equal(result.decision.stage_id, '11');
  assert.equal(result.decision.queue_id, '6');
  assert.equal(result.decision.reply, rule.handoff_message);
});

test('classificador dedicado revisa pedido de agenda mesmo com decisao preliminar', () => {
  assert.equal(shouldRunRoutingClassifier({
    routingRules: [{ id: '1' }],
    decisionRule: { id: '1' },
    appointmentIntent: true,
  }), true);
  assert.equal(shouldRunRoutingClassifier({
    routingRules: [{ id: '1' }],
    decisionRule: { id: '1' },
    appointmentIntent: false,
  }), false);
});

test('criacao externa respeita janela de retentativa e para quando vinculada', () => {
  const now = new Date('2026-09-03T16:00:00.000Z');
  assert.equal(externalOpportunityCreateRetryAllowed({}, now), true);
  assert.equal(externalOpportunityCreateRetryAllowed({
    raw_data: { zpro_create_retry_after: '2026-09-03T16:15:00.000Z' },
  }, now), false);
  assert.equal(externalOpportunityCreateRetryAllowed({
    raw_data: { zpro_create_retry_after: '2026-09-03T15:59:00.000Z' },
  }, now), true);
  assert.equal(externalOpportunityCreateRetryAllowed({
    external_opportunity_id: '78',
  }, now), false);
});

test('webhook WABA enviado pela empresa e reconhecido como saida e tem id estavel', () => {
  const payload = {
    method: 'message_sent_waba',
    msg: {
      id: 'outbound-waba-1',
      messageId: 'wamid.outbound-1',
      fromMe: true,
      body: '{"name":"campanha_regularizacao"}',
      timestamp: '2026-09-15T13:38:00.000Z',
    },
    ticket: {
      id: 17093,
      status: 'open',
      channel: 'waba',
      whatsappId: 45,
      whatsapp: { name: 'WABA OmniDrive' },
      contact: { id: 800, number: '5511917112598', name: 'Heddy' },
    },
  };

  const parsed = extractPayload(payload);
  assert.equal(parsed.fromMe, true);
  assert.equal(parsed.eventId, 'outbound-waba-1');
  assert.equal(parsed.ticketId, '17093');
  assert.equal(parsed.whatsappId, '45');
  assert.equal(isOfficialWhatsAppChannel(parsed), true);
});

test('webhook WABA le texto do botao oficial antes da ultima mensagem do ticket', () => {
  const payload = {
    method: 'message',
    msg: {
      id: 'wamid.inbound-button-1',
      from: '5511917112598',
      timestamp: '2026-09-15T13:39:00.000Z',
      type: 'button',
      button: { payload: 'mais_informacoes', text: 'Mais informações' },
    },
    ticket: {
      id: 17093,
      status: 'pending',
      channel: 'waba',
      whatsappId: 45,
      lastMessage: 'Texto antigo do template',
      whatsapp: { name: 'WABA OmniDrive' },
      contact: { id: 800, number: '5511917112598', name: 'Heddy' },
    },
  };

  const parsed = extractPayload(payload);
  assert.equal(parsed.fromMe, false);
  assert.equal(parsed.text, 'Mais informações');
  assert.equal(parsed.eventId, 'wamid.inbound-button-1');
  assert.equal(parsed.phone, '5511917112598');
  assert.equal(parsed.messageType, 'button');
  assert.equal(parsed.contactType, 'customer');
  assert.equal(isOfficialWhatsAppChannel(parsed), true);
});

test('webhook sem id gera chave deterministica para bloquear entrega duplicada', () => {
  const payload = {
    method: 'message',
    msg: {
      from: '5511917112598',
      timestamp: '2026-09-15T13:40:00.000Z',
      type: 'text',
      body: 'Quero regularizar',
    },
    ticket: {
      id: 17093,
      status: 'pending',
      channel: 'waba',
      whatsappId: 45,
      contact: { number: '5511917112598' },
    },
  };

  assert.equal(extractPayload(payload).eventId, extractPayload(payload).eventId);
  assert.equal(extractPayload(payload).text, 'Quero regularizar');
});

test('ticket WABA devolvido para pending recupera bloqueio criado pelo parser antigo', () => {
  const previous = {
    ai_state: {
      stopped: true,
      reason: 'ticket_open_human',
      ticket_id: '17093',
      stopped_at: '2026-09-15T13:38:00.000Z',
    },
  };

  const recovered = buildLeadMetadata({
    ticketId: '17093',
    ticketStatus: 'pending',
    fromMe: false,
    text: 'Mais informações',
  }, previous);
  assert.equal(recovered.ai_state.stopped, false);
  assert.equal(recovered.ai_state.reason, 'ticket_returned_to_ai_queue');

  const intentionalHandoff = buildLeadMetadata({
    ticketId: '17093',
    ticketStatus: 'pending',
    fromMe: false,
    text: 'Mais informações',
  }, {
    ai_state: { stopped: true, reason: 'human_handoff_by_ai', ticket_id: '17093' },
  });
  assert.equal(intentionalHandoff.ai_state.stopped, true);
  assert.equal(intentionalHandoff.ai_state.reason, 'human_handoff_by_ai');
});

test('agente de todos os canais atende WABA sem vencer agente especifico', () => {
  const agents = [
    { id: 'all', settings: { integration_id: 'integration-1' } },
    { id: 'normal', settings: { integration_id: 'integration-1', channel_id: '12' } },
    { id: 'waba', settings: { integration_id: 'integration-1', channel_id: '45' } },
    { id: 'other-integration', settings: { integration_id: 'integration-2', channel_id: '45' } },
  ];

  assert.equal(selectAgentForChannel(agents, 'integration-1', { whatsappId: '45' }).agent.id, 'waba');
  assert.equal(selectAgentForChannel(agents, 'integration-1', { whatsappId: '99' }).agent.id, 'all');
  assert.equal(selectAgentForChannel(agents, 'integration-2', { whatsappId: '45' }).agent.id, 'other-integration');
});
