# Hex — autonomous security, in conversation

## Product vision

Hex is designed as a collaborative security workspace where autonomous red-team and blue-team specialists continuously test a controlled environment, interpret the evidence, and coordinate a response. Instead of forcing an operator to reconstruct a story from disconnected dashboards, Hex puts the exchange in a shared conversation: what was attempted, what was observed, what changed, and what should happen next.

Red squad maps the surface and tests its boundaries. Blue squad watches the signals, groups related alerts into incidents, and prepares focused mitigations. A neutral Director keeps the exchange understandable and scores outcomes. The human stays in command of consequential containment decisions through inline approval cards.

## The problem

Security work spans discovery, validation, triage, remediation and communication. Those stages often live in different tools and speak different languages. A growing volume of alerts can obscure the chain of evidence that matters most: an observed weakness, a credible finding, a response, and a verified change in behavior.

Hex's central idea is that the conversation can carry that chain. Each agent contributes a bounded role. Evidence travels with the finding. The operator can interrupt, ask for context, or approve the next step without leaving the workspace.

## The full platform, as designed

- **Scout:** maps routes and likely weak points in an explicitly scoped target.
- **Injector:** examines query boundaries and attaches validation evidence.
- **IDOR Runner:** evaluates object ownership boundaries.
- **Prompt Smuggler:** evaluates model-facing instruction boundaries.
- **Sentinel:** watches traffic and logs for anomalous patterns.
- **Patch Engineer:** drafts and applies allowlisted, reversible mitigations.
- **Triage:** merges related alerts into a coherent incident.
- **Containment:** requests human approval for disruptive actions.
- **Director:** explains the exchange and tracks confirmed outcomes.

The local execution architecture uses Next.js, a server scheduler, a private synthetic target, and SQLite history. OpenAI selects scoped probes and runtime policies when configured. Jev adds an advisory triage signal. Runtime policies are evaluated through before-and-after evidence.

## Why the experience is different

Hex makes collaboration visible. A war room shows the whole exchange; squad channels and agent threads provide focus. Evidence sits beside the relevant message. An inline approval keeps the operator in the loop. A scoreboard and incident ledger provide a second view when the operator needs a summary. Desktop and mobile share the same interaction model.

## Who it serves

The initial audience is security education, controlled exercises, and teams exploring agent-assisted workflows. The next step is a scoped lab pilot that measures evidence quality, detection time, mitigation time, replay outcomes and operator comprehension. Broader operational deployment requires actual isolation, authorization, auditability and validation of the execution layer.

## Submission implementation

The implemented exercise runs SQL injection, order ownership, and an instruction-following fixture against synthetic data. It records measured findings and validates mitigations through attack replays and legitimate controls.

## One-line pitch

**Hex brings red team, blue team and the human operator into one evidence-led conversation.**
