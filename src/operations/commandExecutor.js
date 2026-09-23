import { engineError } from './store.js';
import { logInfo } from '../lib/logging.js';

// Unknown remote results are held for reconciliation, never blindly retried.
export function definitiveFailure(error) {
  return [400, 401, 403, 404, 405, 409, 422, 429].includes(Number(error.zproStatus || error.status));
}
export class CommandExecutor {
  constructor(store, conversation, owner) { Object.assign(this, { store, conversation, owner }); }
  async run(key, kind, payload, execute, reconcile = null) {
    await this.store.assertLease(this.conversation, this.owner);
    const command = await this.store.claimCommand(this.conversation, this.owner, key, kind, payload);
    const ids = { conversationId: this.conversation.id, commandId: command.id, kind };
    if (command.status === 'completed') return command.result;
    if (this.conversation.expected_version != null) {
      const current = await this.store.current(this.conversation);
      if (Number(current.received_version) !== Number(this.conversation.expected_version)) {
        if (command.execute) await this.store.finishCommand(command, this.owner, 'failed', null, 'TURN_SUPERSEDED');
        throw engineError('TURN_SUPERSEDED');
      }
    }
    if (!command.execute) {
      if (reconcile && ['uncertain', 'processing'].includes(command.status)) {
        const recovered = await reconcile(command.payload);
        if (recovered) {
          // Claim ownership of an uncertain command only while holding its conversation lease.
          await this.store.assertLease(this.conversation, this.owner);
          await this.store.db.from('crm_ai_commands').update({ owner: this.owner }).eq('id', command.id).then(({ error }) => { if (error) throw error; });
          await this.store.finishCommand(command, this.owner, 'completed', recovered);
          return recovered;
        }
      }
      throw engineError(command.status === 'failed' ? 'COMMAND_FAILED' : 'COMMAND_UNCERTAIN');
    }
    logInfo('turn.action_queued', ids);
    try {
      const result = await execute(payload, command.id);
      await this.store.assertLease(this.conversation, this.owner);
      await this.store.finishCommand(command, this.owner, 'completed', result ?? {});
      logInfo('turn.action_completed', ids);
      return result;
    } catch (error) {
      const status = definitiveFailure(error) ? 'failed' : 'uncertain';
      await this.store.finishCommand(command, this.owner, status, null, error.code || (status === 'uncertain' ? 'REMOTE_RESULT_UNKNOWN' : 'REMOTE_REJECTED'));
      throw error;
    }
  }
}
