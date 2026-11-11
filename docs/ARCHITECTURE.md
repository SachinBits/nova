# Hex architecture

Hex is a single Next.js process on the Node runtime. It serves the React workspace and the same-origin APIs, runs background work in-process, and keeps state in SQLite on local disk. Run it as one process with a persistent `.data/` directory.

## Attack lab

- A server-side scheduler advances each run even when the tab is closed, and the API resumes a due run after a restart. Runs are stored in SQLite under the browser's session cookie.
- The target is an in-process handler with six fixtures: a SQLite customer lookup, order ownership, a refund assistant, a link preview backed by a simulated network, a settings merge whose prototype is sandboxed per request, and a dependency installer with a hijacked release. Nothing reaches a real network or the Hex process's own prototypes.
- Red probes each boundary. In agent mode the model crafts SQL payloads and picks Blue's policies through one forced function call per turn, within a per-run budget; Hex validates every action against the current state before executing it.
- The Verifier replays the attack and a legitimate control against each candidate policy. A policy is kept only if the replay is blocked and the control still succeeds, so broad quarantines roll back. Order ownership changes wait for operator approval.
- The evidence receipt holds the synthetic requests, responses, decisions and a SHA-256 digest. The digest detects changes; it does not identify a signer.

## Project review

`lib/server/review.ts` runs the same pipeline for uploads, pasted GitHub links and pushes, one job at a time.

1. Unpack the archive with path, size and entry limits; credential files are excluded but recorded.
2. Scan JavaScript and TypeScript with the parse-tree rules in `project-rules.ts`, and the manifests, lockfiles and workflows with `supply-chain.ts`. Resolved dependency versions are checked against OSV.dev.
3. Optionally ask the configured model for findings and single-location patches. Its findings are merged with the scanner's by file and vulnerability class.
4. Run the project's tests in a network-disabled, read-only Docker container, apply the candidate fixes, and run them again. Fixes are kept only if the results are no worse; otherwise they are reverted.
5. Optionally generate exploit tests for kept fixes and run them against the original and fixed code.

## Live monitor

`lib/server/live.ts` owns a queue of pushes in its own SQLite file. Pushes arrive from the signed webhook (`/api/github/webhook`) or from a poller that sends conditional requests for each watched branch head. Each push is reviewed, compared with the previous review of its branch, and reported as a commit status and comment. The War Room and `/live` poll `/api/live` for updates.

`proxy.ts` keeps the app local: requests that arrive through a tunnel can reach only the webhook endpoint.

## Model providers

`lib/server/llm.ts` adapts every model call to either the OpenAI Responses API or Groq's Chat Completions API, including structured output and forced tool calls. Groq requests send less source per review to stay within its free-tier limits.
