import { HaltSignal, Rng } from './util.js';
import { FAULTS } from './agents/faults.js';

/**
 * An agent = its state (which the control plane owns and meters) + a run loop that executes
 * task scripts. The script never touches the world: every capability goes through
 * tower.requestAction(), the single door, and every model call through tower.recordThought().
 */
export class Agent {
  constructor(def, tower, index) {
    this.def = def;
    this.tower = tower;
    this.id = def.id;
    this.name = def.name;
    this.role = def.role;
    this.team = def.team;
    this.model = def.model;
    this.mission = def.mission;
    this.allowedTools = new Set(def.allowedTools);
    this.taskBudgetUsd = def.taskBudgetUsd;
    this.budgetUsd = def.budgetUsd;
    this.baselineTokensPerMin = def.baselineTokensPerMin;
    this.rng = new Rng(tower.seed * 31 + index * 7919 + 17);

    this.halt = null; // { type: 'paused' | 'killed', by, reason, kind, ts }
    this.fault = null; // injected misbehaviour (simulation lab only)
    this.gen = 0; // run-loop generation; bumping it orphans the old loop
    this.credGen = 1; // credential generation; bumping it revokes every older credential
    this.abort = new AbortController();
    this.waiters = [];
    this.taskSeq = 0;

    this.usage = { tokensIn: 0, tokensOut: 0, costUsd: 0 };
    this.task = null;
    this.tasks = [];
    this.steps = [];
    this.stepCounter = 0;
    this.currentStep = null;
    this.window = [];
    this.tokenLog = [];
    this.buckets = new Map();
    this.recent = [];
    this.violations = [];
    this.rateHits = [];
    this.pending = new Set();
    this.incident = null;
    this.drift = { score: 0, level: 'nominal', signals: [] };
    this.stats = { actions: 0, executed: 0, approvals: 0, denied: 0, violations: 0, blockedAfterKill: 0, tasksDone: 0 };
  }

  get status() {
    if (this.halt?.type === 'killed') return 'killed';
    if (this.halt?.type === 'paused') return 'paused';
    if (this.pending.size) return 'blocked';
    return this.task ? 'running' : 'idle';
  }

  wake() {
    const ws = this.waiters.splice(0);
    for (const w of ws) w();
  }

  /** Orphan the current loop and start a fresh one under the current credential. */
  start() {
    const gen = ++this.gen;
    this.abort = new AbortController();
    this.#loop(gen).catch((err) => this.tower.internalError(this, err));
  }

  stopLoop() {
    this.gen++;
    this.abort.abort();
    this.wake();
  }

  #makeCtx(gen) {
    const a = this;
    const t = this.tower;
    const cred = this.credGen;
    const revoked = () => gen !== a.gen || cred !== a.credGen || a.halt?.type === 'killed';
    const guard = async () => {
      for (;;) {
        if (revoked()) throw new HaltSignal(a.halt?.type === 'killed' ? 'killed' : 'revoked');
        if (!a.halt) return;
        await new Promise((r) => a.waiters.push(r));
      }
    };
    const ctx = {
      rng: a.rng,
      agent: a,
      sleep: async (ms) => {
        await t.clock.sleep(ms, a.abort.signal);
        await guard();
      },
      pace: () => ctx.sleep(a.rng.float(1300, 3000)),
      think: async (text, tokens) => {
        await guard();
        t.recordThought(a, text, tokens);
        await guard();
      },
      act: async (tool, args) => {
        await guard();
        const res = await t.requestAction(a, tool, args, { cred, gen });
        await guard();
        return res;
      },
      // Simulation only: what a misbehaving agent does after being told to stop. It bypasses the
      // cooperative guard and calls the gateway directly with its (now stale) credential.
      raw: (tool, args) => t.requestAction(a, tool, args, { cred, gen, raw: true }),
      rawSleep: (ms) => t.clock.sleep(ms),
    };
    return ctx;
  }

  async #loop(gen) {
    const ctx = this.#makeCtx(gen);
    const t = this.tower;
    try {
      await ctx.sleep(this.rng.int(400, 2200));
      while (gen === this.gen) {
        await ctx.sleep(this.rng.float(3000, 7000));
        const factory = this.fault ? FAULTS[this.fault] : this.def.nextTask;
        const task = factory(this, ctx);
        const rec = t.startTask(this, task.name);
        try {
          await task.run(ctx);
          t.endTask(this, rec, 'done');
        } catch (e) {
          t.endTask(this, rec, e instanceof HaltSignal ? 'aborted' : 'failed', e.message);
          throw e;
        }
      }
    } catch (e) {
      if (e instanceof HaltSignal) return;
      t.internalError(this, e);
      // an unexpected script error must not take the agent down silently: retry the loop
      if (gen === this.gen && !this.tower.clock.closed) {
        await t.clock.sleep(5000).catch(() => {});
        if (gen === this.gen) this.start();
      }
    }
  }
}
