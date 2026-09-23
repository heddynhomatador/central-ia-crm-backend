import { randomUUID } from 'node:crypto';
import { EngineStore } from './store.js';
import { processTurn } from '../conversation/processTurn.js';
import { processFollowup } from '../followup/processFollowup.js';
import { logWarn } from '../lib/logging.js';

export function createEngineWorker(db) {
  const store = new EngineStore(db); let timer; let running = false; let retryAt = 0; let idleDelay = 1000; let stopped = true;
  async function perform(batch, handler) {
    const c = batch.conversation; let lost = false;
    const heartbeat = setInterval(() => store.assertLease(c, c.lease_owner).catch(() => { lost = true; }), 20000);
    heartbeat.unref();
    try {
      if (batch.turns?.[0]?.attempts > 5) {
        await store.finish(batch, { ...c.state, status: 'failed_action', followup_eligible: false, failed_action: 'TURN_RETRY_EXHAUSTED' }, c.history);
      } else await handler({ batch, store });
    } catch (error) {
      logWarn('turn.processing_failed', { conversationId: c.id, error_code: error.code || 'ENGINE_FAILURE' });
      if (!lost && batch.turns) {
        try { await store.finish(batch, c.state, c.history, error.code || 'ENGINE_FAILURE'); } catch { /* Lease may have expired. */ }
      }
    } finally { clearInterval(heartbeat); }
  }
  async function tick() {
    if (running || Date.now() < retryAt || (process.env.APP_MODE || 'live') !== 'live') return 0;
    running = true;
    try {
      const work = [];
      const first = await store.claim(randomUUID());
      if (first) work.push(perform(first, processTurn));
      for (let i = first ? 1 : 4; first && i < 4; i++) {
        const batch = await store.claim(randomUUID());
        if (batch) work.push(perform(batch, processTurn));
      }
      const followup = await store.rpc('crm_ai_claim_followup', { p_owner: randomUUID() });
      if (followup) work.push(perform(followup, processFollowup));
      await Promise.allSettled(work);
      idleDelay = work.length ? 1000 : Math.min(5000, idleDelay + 1000);
      return work.length;
    } catch (error) {
      retryAt = Date.now() + 60000; idleDelay = 5000;
      logWarn('turn.worker_unavailable', { error_code: error.code || 'ENGINE_DATABASE_UNAVAILABLE' });
      return 0;
    } finally { running = false; }
  }
  async function loop() {
    const count = await tick();
    if (stopped) return;
    timer = setTimeout(loop, count ? 1000 : idleDelay);
    timer.unref();
  }
  return {
    tick,
    start() { if (!timer) { stopped = false; timer = setTimeout(loop, 1000); timer.unref(); } },
    stop() { stopped = true; clearTimeout(timer); timer = null; },
  };
}
