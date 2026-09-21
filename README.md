# The Agent Control Tower

> How do humans manage an AI workforce when agents can act across real systems?

A control surface, not a chatbot. Four simulated agents run continuously against simulated payments, email, deploys, a database and a secrets vault. Every call they make goes through a **gateway** that meters it, applies policy, asks a human when it must, and can revoke the agent's credentials, whether or not the agent cooperates. The **operator console** shows the fleet live and lets you intervene.

**Live demo:** _add your deployed URL here_ (see [Deploy](#deploy), which takes about two minutes) · **Walkthrough:** [docs/LOOM_SCRIPT.md](docs/LOOM_SCRIPT.md)

## Run it

```bash
git clone <this repo> && cd TheAgentControlTower
npm start            # → http://localhost:8080   (Node 22+, zero dependencies, no install step)
```

Each browser visit gets its own private room (tenant) with its own fleet. Share the URL (`?room=…`) with a colleague to watch and intervene together.

**First 60 seconds** (the console has a guided checklist that ticks as you go):

1. **Approve / deny** a request in the Approval queue. The blocked agent resumes, or adapts.
2. **Pause** an agent, then resume it.
3. **Replay reasoning**: step through what it thought, asked for, and what the Tower decided.
4. **Run the rogue drill** (guide → *Run drill*): watch the Tower catch and contain it.
5. **Kill** an agent (two clicks), or **Restart** the contained one.
6. **Audit log** → Verify hash chain → Export CSV/JSON.

## What's in the console

| Requirement | Where |
|-------------|-------|
| Live fleet: status, recent actions, blockers, drift | Agent cards, updated by an SSE event stream |
| Approval queue for risky actions | Right column: risk, rule, agent's reasoning, routed team, auto-deny countdown |
| Per-agent kill switch (+ pause, restart, fleet halt) | Card buttons; *Halt fleet* in header. Kill needs a confirming second click |
| Cost & tokens per agent per task | *Cost & tokens* tab, plus per-task budget bars on each card |
| Replay the last N steps | *Replay reasoning* (5/10/20 steps, play/step/scrub) |
| ≥3 simulated agents you can watch and intervene on | Refund Resolver · Release Captain · Outreach Writer · Data Janitor |
| **Bonus:** multi-team / multi-tenant | Team filter, approvals routed to Finance / Platform / Growth / Data; rooms are isolated tenants |
| **Bonus:** exportable audit log | SHA-256 hash-chained; CSV + JSON export; one-click chain verification |

Also: incidents with blast-radius reporting, a *Guardrails* tab documenting every rule, and a *Simulation lab* to inject faults.

## Architecture (agent events → control plane → operator UI)

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the diagram, check order and design decisions. In one line: agents call `requestAction` / `recordThought` on the Tower (the only door to any system); the Tower emits events on a bus streamed to the UI over SSE; the UI's interventions are `POST`s back to the same Tower.

## Failure test: a rogue agent

[docs/FAILURE_TEST.md](docs/FAILURE_TEST.md). An agent drifts from its job, reaches for production secrets, tries to delete the customers table and exfiltrate it, then **ignores the kill order**. The Tower kills it within a second on three independent signals, and credential revocation blocks every call it makes afterwards. Nothing dangerous executes. Run it: `npm run drill`.

## Tests

```bash
npm test                    # 55 tests: policy, audit chain, gateway, scenarios (rogue/loop/cost/soak), HTTP + SSE
node scripts/e2e.mjs        # drives the real UI in headless Chrome/Edge via DevTools: real clicks, whole intervention flow
npm run drill               # the failure test, human-readable
```

## Deploy

The app is one Node process; it needs a host that supports long-lived HTTP connections (SSE). No env vars required.

- **Render:** New → Blueprint → select this repo (uses [render.yaml](render.yaml) + [Dockerfile](Dockerfile)).
- **Fly.io:** `fly launch --copy-config --no-deploy && fly deploy` (uses [fly.toml](fly.toml)).
- **Anywhere with Docker:** `docker build -t tower . && docker run -p 8080:8080 tower`.

Env: `PORT` (default 8080), `MAX_ROOMS` (default 40 concurrent tenants; idle rooms are evicted), `AGENT_SPEED` (sim speed multiplier, default 1).

## Submission notes

**AI tools used.** Built with Claude Code (Claude Sonnet 5): design, implementation, tests, and the browser E2E harness. The agents themselves are deterministic scripted simulations (seeded), so the demo needs no API key and behaves reproducibly.

**Key decisions.**
- *Enforce, don't just observe.* The gateway is the enforcement point, so "kill" means "revoke", and a rogue agent that ignores it is still stopped.
- *Explainable containment.* Explicit rules (3 violations → kill; loop → pause; budget → pause) instead of an opaque anomaly score. The drift score is shown but every point is attributable to a named signal.
- *Fail closed everywhere.* Unanswered approvals deny; approved actions for a halted agent are voided; hard limits (budget, rate) stay on even with auto-containment off.
- *Demo-proof.* Per-visitor rooms so strangers can't kill each other's demo; two-click confirmation for destructive controls; guided checklist for non-builders.
- *Zero dependencies and no build step*, so a clean clone runs.

**Out of scope.** Real LLM calls; authentication and per-operator RBAC (operator names are self-declared but audited); durable storage (state is in memory); real pricing (illustrative rates in `src/pricing.js`). See ARCHITECTURE.md.

## Deliverables

| Item | Status |
|------|--------|
| Working build (clean clone runs) | ✅ `npm start`, verified from a fresh clone |
| Live demo URL | Deploy config included ([Deploy](#deploy)); add the URL above once hosted |
| 90-second Loom | Script in [docs/LOOM_SCRIPT.md](docs/LOOM_SCRIPT.md) (to be recorded) |
| Architecture snapshot | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Failure test | [docs/FAILURE_TEST.md](docs/FAILURE_TEST.md) + `npm run drill` + `test/scenarios.test.js` |
| Two-year thesis (≤300 words) | [docs/THESIS.md](docs/THESIS.md) |

MIT licensed.
