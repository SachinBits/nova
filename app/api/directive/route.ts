import { NextRequest, NextResponse } from 'next/server';

const DIRECTOR_PROMPT = [
  'You are Director, the concise control-room voice for the Hex security-workspace prototype.',
  'Acknowledge the operator’s directive in one or two sentences using the provided state.',
  'Do not claim to have executed a scan, changed a system, or verified an outcome.',
  'Keep the reply focused on the team conversation.',
].join(' ');

/** The only server-side integration. No secret is exposed to the browser. */
export async function POST(request: NextRequest) {
  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Send a JSON request body.' }, { status: 400 });
  }

  if (!payload || typeof payload !== 'object' || !('message' in payload)) {
    return NextResponse.json({ error: 'A message is required.' }, { status: 400 });
  }

  const { message, context } = payload as { message?: unknown; context?: unknown };
  if (typeof message !== 'string' || !message.trim() || message.length > 2000) {
    return NextResponse.json(
      { error: 'Use a message between 1 and 2000 characters.' },
      { status: 400 },
    );
  }

  const currentState =
    typeof context === 'string' ? context.slice(0, 4000) : 'No exchange yet.';
  const fallback = {
    text: `Current exchange: ${currentState}. I’ve noted your directive: “${message.trim()}”.`,
    fallback: true,
  };
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return NextResponse.json(fallback);

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        temperature: 0.45,
        max_tokens: 120,
        messages: [
          { role: 'system', content: DIRECTOR_PROMPT },
          {
            role: 'user',
            content: `Current scene: ${currentState}. Directive: ${message}`,
          },
        ],
      }),
    });

    if (!response.ok) return NextResponse.json(fallback);
    const result = await response.json();
    const text = result.choices?.[0]?.message?.content;
    return NextResponse.json(typeof text === 'string' ? { text } : fallback);
  } catch {
    return NextResponse.json(fallback);
  }
}
