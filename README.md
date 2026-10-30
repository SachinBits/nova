# Hex

### All sides. One conversation.

Hex explores a conversational workspace for coordinated red-team and blue-team security agents. Specialists collaborate in a shared war room, the Director makes their work legible, and a human operator approves consequential actions from inside the conversation.

## Run locally

Requires Node.js 20.9 or later.

```bash
npm ci
npm run dev
```

Open http://localhost:3000. Select **Start run** to begin the agent conversation.

For an optimized build:

```bash
npm run build
npm start
```

## Optional Director intelligence

Copy `.env.example` to `.env.local`, then set `GROQ_API_KEY`. Only `app/api/directive/route.ts` reads the key; the browser never receives it. The Director uses Groq's OpenAI-compatible API and `llama-3.1-8b-instant`. The rest of the app works without external services, and a local response handles unavailable Groq access.

## What to explore

- **War room:** the full team conversation, grouped messages, evidence cards and progress signals.
- **Squad channels:** separate red-team and blue-team views.
- **Agent threads:** focused conversations for individual specialists.
- **Containment:** an inline human approval decision with an immediate visible outcome.
- **Scoreboard:** the current exchange and the story's counters.
- **Findings:** incident severity, ownership and status.
- **Composer:** ask the Director for a summary or a new directive.
- **Presentation:** responsive layout, circular agent avatars, light and dark themes, and contained scrolling.

The [project summary](docs/PROJECT_SUMMARY.md) explains the full product vision and target architecture separately from the implemented scope. The [architecture guide](docs/ARCHITECTURE.md) maps the source and extension points.

## Code map

```text
app/
  page.tsx               Conversation workspace and view components
  layout.tsx             Page metadata and global stylesheet
  globals.css            Theme, responsive layout and message styles
  not-found.tsx          Missing-page view
  api/directive/route.ts Server-side Groq call and local fallback
lib/
  agents.ts              Agent roster and timeline data
  use-simulation.ts      Run timing, directives and approval state
components/
  agent-identity.tsx     SVG wordmark, avatars and squad stacks
docs/
  PROJECT_SUMMARY.md     Product pitch, intended architecture and scope
  ARCHITECTURE.md        Implementation guide
  DEMO.md                A short judge walkthrough
```
