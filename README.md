# Hex

Hex is a local multi-agent security exercise for a synthetic commerce target. Red agents exercise three trust boundaries. Blue agents inspect the responses, try narrowly scoped runtime policies, and verify each policy with both an attack replay and a legitimate control.

## Run locally

Use Node.js 24 or newer.

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:3000 and select **Open demo war room**, then **Start run**. Dev and production scripts bind to loopback. For the production build, run `npm run build` followed by `npm start`.

To enable OpenAI agent mode, copy `.env.example` to `.env.local` and add `OPENAI_API_KEY`. Restart the server and start a new run. Scout chooses what Red probes and which payload to use. Patch Engineer chooses Blue's runtime policies and can retry after the Verifier rolls a candidate back. Triage and Director can also explain the results. `OPENAI_MODEL` optionally overrides the default `gpt-5.4-mini`. Add a TypeSafe key as `JEV_API_KEY` to show advisory escalation probabilities in Findings. Restart the server after editing the file. Without credentials, Hex runs a local practice exercise. In OpenAI agent mode, a provider failure stops the run and preserves the evidence so the two modes are distinguishable.

## Review a project ZIP

Start Docker Desktop in Linux container mode and run `docker pull node:24-bookworm-slim` once. On the Hex home page, upload a JavaScript or TypeScript project ZIP. The War Room opens immediately and streams Red findings, Blue candidate fixes, and Docker verification. The report and ZIP appear when the review finishes. Hex scans the source, applies conservative fixes for supported Express and Next.js header settings, and runs baseline and patched checks in network-disabled containers. The ZIP download includes the project and `HEX-REVIEW.json`.

Built-in Node tests can run when they need no installed dependencies. Hex does not install uploaded dependencies or start uploaded web services. Other findings are flagged for review. The optional OpenAI checkbox sends a limited selection of source files for advisory analysis. Keep credentials and sensitive code out of uploaded projects.

## Walkthrough

1. Watch Injector run a SQL lookup against a synthetic SQLite fixture. IDOR Runner uses the leaked order ID to test cross-account access. Prompt Smuggler tests a deterministic instruction-following fixture.
2. Watch Sentinel identify exposures and Patch Engineer verify the customer and assistant policies automatically. Containment asks for approval before changing order ownership checks.
3. In **Findings**, open evidence to compare the original target response, the replay and a legitimate control. Select **Export evidence** to download a JSON receipt with a SHA-256 digest of its evidence object. The digest detects changes to that object when compared against an independently retained digest.
4. Use **Recent runs** to open a previous exercise. The browser session cookie scopes the SQLite history.

## Verification

Run `npm run check` for TypeScript validation and `npm run build` for the production build. With the app running in local practice mode, run `npm run smoke` to verify approval, decline and session isolation. For an agent-mode test without a live key, start the built server with `OPENAI_API_KEY=mock` and `node --import ./scripts/mock-openai.mjs node_modules/next/dist/bin/next start --hostname 127.0.0.1`, then run `node scripts/smoke-agents.mjs` in another terminal.

This is a single-process local lab. The private target accepts only the built-in scenario probes and synthetic inputs. Run history lives in `.data/hex.sqlite` by default. For the execution flow and model boundaries, see [Architecture](docs/ARCHITECTURE.md).
