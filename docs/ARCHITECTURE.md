# Implementation guide

## Current application

`app/page.tsx` renders the conversation workspace and its supporting views. `lib/agents.ts` holds the typed roster and staged timeline. `lib/use-simulation.ts` owns the run lifecycle, message IDs, typing indicators, approval decisions and Director requests. `app/api/directive/route.ts` contains the only optional external call.

The timeline uses a separate step counter so a user message cannot skip an agent event. Both timers are cleaned up when pausing or resetting. A run version prevents a late Director response from appearing in a new run. Approval choices are accepted once. Scroll positions are kept per thread, and incoming messages only scroll when the reader is near the end.

The CSS keeps the viewport bounded and gives the conversation row `minmax(0, 1fr)`. The feed, rather than the document, scrolls. Theme variables drive both light and dark styles. On mobile, the sidebar becomes a dismissible panel.

The Director route validates requests, times out the Groq call, and falls back locally. Secrets are read only on the server. No secret or ElevenLabs dependency belongs in this repository.

## Intended execution layer

The full platform would replace the staged timeline with typed WebSocket events from a scoped FastAPI orchestrator. That orchestrator would own agent tools, target authorization, logging, findings persistence, mitigation application and verified replay. The interface would render those events through the same conversation model.

This layer is described as a target architecture in the project summary. It is not present in this submission.
