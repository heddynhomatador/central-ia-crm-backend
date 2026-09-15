# Erro de criacao de oportunidade na instancia Z-PRO

## Evidencia do log fornecido

- Data: 15/09/2026, aproximadamente 15:09:37 a 15:09:44 (America/Sao_Paulo).
- Equivalente UTC: 18:09:37 a 18:09:44.
- Recurso: POST /v2/api/external/{apiId}/createOpportunity.
- Retorno: HTTP 500, {"success":false,"error":"ERR_CREATE_OPPORTUNITY"}.
- Canal WABA: 45. Ticket: 17107. Contato: 12273.
- Funil configurado: 22. Etapa inicial: 50. Ticket pendente, sem atendente.
- Criacao enviada com status open, valor 0, validateNumber false e sem responsibleId.

A Central recebeu somente essa mensagem generica. Ela nao contem o erro de banco,
stack trace nem a validacao que falhou. Nao e possivel concluir, a partir desse retorno,
que falta responsavel, que o funil e invalido ou que WABA nao e suportado.

## Informacao necessaria da hospedagem/suporte Z-PRO

Consultar o log do backend da propria Z-PRO nesse intervalo e localizar a excecao
original de createOpportunity. Conferir, sem alterar os dados de producao:

1. Se a etapa 50 pertence ao funil 22 e ambos pertencem a empresa da API/sessao.
2. Se essa versao permite oportunidade sem responsavel quando o ticket esta pendente.
3. Se a criacao reaproveita o contato WABA com validateNumber false.
4. Se existe restricao de banco, permissao ou migracao faltando.

Esses pontos sao hipoteses de verificacao, nao causas confirmadas. Nao atribuir um
responsavel aleatorio nem criar oportunidades repetidas para tentar contornar o erro.

O outro erro, Cannot POST .../sendMessageByTicket, indica uma rota ausente nessa
instalacao. O backend Central v4 possui compatibilidade com a rota base documentada,
apos consultar e verificar o ticket. Testes locais nao substituem a validacao da
resposta real nessa instancia. Nao publicar tokens ou dados pessoais no chamado.
