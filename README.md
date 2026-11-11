# Hex

Hex puts a red team and a blue team of security agents in one conversation. Red finds weaknesses, Blue fixes what it safely can, and a Verifier proves every fix before it is kept. You watch the exchange in the War Room and approve anything risky.

Hex works in three ways:

- **Attack lab:** agents attack a synthetic store (SQL injection, IDOR, prompt injection, SSRF, prototype pollution and a hijacked npm release), then verify each runtime fix against an attack replay and a legitimate request.
- **Project review:** upload a ZIP or paste a GitHub link. Hex scans the code and its supply chain, applies conservative fixes, and proves them by running the project's tests in a network-disabled Docker container.
- **Live monitor:** Hex watches your repositories, reviews every push, reports what that push introduced or fixed, and posts a pass or fail status on the commit.

## Quick start

Requires Node.js 24 or newer. Docker is optional but needed for verified fixes.

```sh
npm ci
cp .env.example .env    # optional: add an AI key, GitHub token, repositories to watch
npm run dev
```

Open http://localhost:3000. The server binds to loopback only. For a production build, run `npm run build` and then `npm start`.

Without any keys, the lab runs a scripted practice exercise and project reviews use the built-in scanners.

## Configuration

All settings live in `.env`; [.env.example](.env.example) documents each one.

| Setting | Purpose |
|---|---|
| `OPENAI_API_KEY` or `GROQ_API_KEY` | Agent mode in the lab and the optional AI pass in reviews. With both set, OpenAI is used unless `LLM_PROVIDER=groq`. Groq has a free tier. |
| `GITHUB_TOKEN` | Private repositories, commit statuses and comments, and a higher API limit. |
| `HEX_WATCH_REPOS` | Repositories reviewed on every push, for example `owner/repo,owner/other@main`. |
| `GITHUB_WEBHOOK_SECRET` | Enables the webhook endpoint for instant push reviews. |
| `HEX_POLL_SECONDS` | Poll interval: default 10 with a token (minimum 5), 60 without. |

Restart the server after changing `.env`.

### Docker

Install Docker and pull the sandbox images once:

```sh
docker pull node:24-bookworm-slim
docker pull python:3.12-slim
```

On Windows with WSL, enable **Settings → Resources → WSL integration** for your distribution in Docker Desktop, then open a new terminal. Without Docker, reviews still scan and report findings but apply no fixes.

## Project review

On the home page, upload a project ZIP (up to 12 MB) or paste a link such as `https://github.com/owner/repo` or `.../tree/<branch>`. The War Room streams the review as it happens, and the report and the fixed project are available to download when it finishes.

What a review checks:

- **Code** (JavaScript and TypeScript, parsed): SQL and NoSQL injection, command injection, `eval` and `node:vm`, path traversal, SSRF, open redirects, prototype pollution, DOM XSS sinks, ReDoS, unsafe deserialization, JWT misuse, weak randomness, hardcoded secrets, secrets exposed through `NEXT_PUBLIC_` or `VITE_` variables, user input in LLM system prompts, and model output executed as code.
- **Supply chain:** known-vulnerable dependency versions from lockfiles (checked against [OSV.dev](https://osv.dev); only package names and versions are sent), suspicious install scripts, typosquatted package names, unpinned or non-registry sources, missing lockfiles, and committed `.env` files or keys.
- **GitHub Actions:** script injection from issue, pull request or commit text, `pull_request_target` workflows that run untrusted code, third-party actions not pinned to a commit, and `write-all` tokens.
- **AI pass** (optional checkbox): the same classes in any language, limited to concrete attack paths. Only a small selection of source files is sent to the configured provider.

Fixes are applied only where they are safe to automate (bound SQL parameters, prototype-pollution guards, framework headers). Each fix is kept only if the project's own tests pass at least as well as before. Hex never installs uploaded dependencies or starts uploaded services. Everything else is reported with its file, line and remediation.

## Live monitor

Open **Live monitor** (`/live`), or stay in the War Room: new pushes appear in the sidebar, and when the room is idle the agents start reviewing the push straight away.

1. Set `HEX_WATCH_REPOS` and `GITHUB_TOKEN`. The token needs **Contents** and **Commit statuses** read and write on those repositories.
2. Restart Hex. The first review of each branch becomes its baseline.
3. Push a commit. Hex reviews it, compares it with the previous review of the branch, and posts a `hex/security-review` status. The status fails when the push introduces a High or Critical finding. A comment on the commit lists the new findings.

Hex picks up pushes by polling (no public URL needed) and, optionally, by webhook. Both feed one queue, and a commit is never reviewed twice.

### Webhook

A webhook delivers pushes within a second or two. GitHub must be able to reach Hex, for example through a tunnel:

```sh
cloudflared tunnel --url http://localhost:3000
```

In the repository, open **Settings → Webhooks → Add webhook** and set:

- **Payload URL:** `https://<tunnel-host>/api/github/webhook`
- **Content type:** `application/json`
- **Secret:** the value of `GITHUB_WEBHOOK_SECRET`
- **Events:** just the push event

GitHub sends a ping straight away; **Recent Deliveries** should show a 200. Requests that arrive through a tunnel can reach only the webhook endpoint, and deliveries without a valid signature are rejected. A quick tunnel gets a new URL each time it starts, so update the webhook if you restart it.

## Attack lab walkthrough

1. Select **Start a lab run**. Injector leaks an order ID through SQL injection and IDOR Runner uses it to read another customer's order. Prompt Smuggler extracts a private refund code. SSRF Hunter points a link preview at a cloud metadata address, Proto Polluter makes another user's session an admin through a `__proto__` key, and Supply Saboteur installs a hijacked package release that steals a CI token. All targets are in-process fixtures; nothing touches the network.
2. Sentinel flags each exposure. Patch Engineer chooses a runtime policy, and the Verifier replays the attack and a legitimate request against it. A broad quarantine fails the legitimate request and is rolled back.
3. Containment asks for your approval before changing order ownership checks.
4. In **Findings**, compare the original response, the replay and the control. **Export evidence** downloads a JSON receipt with a SHA-256 digest of its evidence.

With an AI key, the agents choose payloads and policies themselves within a fixed call budget. A provider failure stops the run and keeps the evidence.

## Development

```sh
npm run check    # TypeScript
npm run build    # production build
npm run sample   # rebuild the sample project ZIPs in public/
```

Smoke tests run against a server on `127.0.0.1:3000` (override with `HEX_TEST_URL`):

```sh
npm run smoke                              # lab in practice mode (start the server without AI keys)
node scripts/smoke-project-review.mjs      # project review pipeline

# Agent mode without a real key:
OPENAI_API_KEY=mock node --import ./scripts/mock-openai.mjs node_modules/next/dist/bin/next start --hostname 127.0.0.1
node scripts/smoke-agents.mjs
```

### Layout

| Path | Contents |
|---|---|
| `app/` | Pages (home, War Room, live monitor) and API routes |
| `components/` | War Room, review and push conversation UI |
| `lib/server/arena.ts`, `target.ts` | Lab scheduler and the synthetic target |
| `lib/server/review.ts` | Review pipeline shared by uploads, links and pushes |
| `lib/server/project-rules.ts`, `supply-chain.ts` | Code, dependency and workflow scanners |
| `lib/server/live.ts`, `github.ts` | Push queue, poller, GitHub statuses and downloads |
| `lib/server/llm.ts` | OpenAI and Groq adapter |
| `samples/` | Deliberately vulnerable sample projects |

Run history and push reviews are stored in SQLite under `.data/`. Hex is a single-process local tool; see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit together.
