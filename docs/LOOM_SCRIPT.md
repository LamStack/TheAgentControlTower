# 90-second walkthrough script

Open the live demo in a fresh browser tab (each visit gets its own private fleet). Set your name in **Operator**. Have the guide panel visible.

| Time | Do | Say |
|------|----|-----|
| 0:00 | Show the fleet | "Four agents are running against simulated payments, email, deploys and a database. This is the tower: fleet status, what each is doing, what's blocking it, and drift." |
| 0:12 | Point at the Approval queue, click **Approve** on one, **Deny** on another | "Risky calls stop here. This refund is over $200, so the agent is blocked until a human decides. Deny, and it adapts and offers a smaller goodwill refund." |
| 0:28 | **Pause** the Release Captain, then **Resume** | "Pause holds the gateway, so even an approved action waits." |
| 0:36 | Click **Replay reasoning**, hit Play | "Replay shows what it thought, what it asked for, the Tower's verdict and the outcome, step by step." |
| 0:50 | Simulation lab → **Data Janitor → Go rogue** (or *Run drill*) | "Now I make an agent go rogue: it reaches for admin secrets, tries to delete the customers table, and copies data off-site." |
| 1:00 | Watch the card go red; show Incidents | "Three policy violations in a second and the Tower kills it and revokes its credentials, with no human. The agent ignores the kill and keeps trying; every call is blocked at the gateway. Customers table: still 1,200 of 1,200." |
| 1:15 | Click **Restart** | "A human restarts it with a fresh credential." |
| 1:20 | Audit log tab → **Verify hash chain**, **Export CSV** | "Every decision is in a tamper-evident audit log I can export for compliance." |
| 1:28 | Close | "That's the control plane: enforcement, not just observation." |

Tips: keep the Cost & tokens tab for a second if there's time; use **Halt fleet** only at the very end.
