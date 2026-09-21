# Agent operations: a two-year thesis

**By 2028, "agent ops" will be a discipline with its own on-call rotation, the way SRE grew out of running websites.**

Today's agent tooling is built for the people who make agents: prompts, evals, traces. None of it says anything about running the system at 3 a.m. once forty agents hold real credentials and one of them is refunding customers.

Three things will define the discipline.

**1. Enforcement moves out of the agent.** A kill switch the agent must cooperate with is a suggestion. Every credential, model call and tool call must pass through a gateway the agent cannot bypass, so that halting is revoking. Observability without enforcement is a dashboard; the winning products will be gateways that happen to have dashboards.

**2. Risk-tiered autonomy replaces "human in the loop".** Approving everything trains humans to click yes. Approving nothing is an incident waiting to happen. Operators will tune a policy surface (what runs free, what needs sign-off, what is never automated) and spend their attention only on the calls that cross a line. Approval fatigue becomes the key metric, like alert fatigue for pagers.

**3. Agents get SLOs, budgets and incident reviews.** Token spend is a capacity signal. Drift, meaning behaviour departing from the mission rather than errors, becomes a first-class alert. Every containment produces a postmortem-grade artifact: what the agent believed, what it asked for, what the gateway refused, what was never touched.

The audit trail is the moat. Compliance teams will not accept "the model decided". They will accept a tamper-evident record of who or what authorised each action.

The organisation that owns this control plane owns the operating relationship with every agent it governs, whichever model, vendor or framework sits underneath. Models will commoditise; the layer that decides what they may do will not.
