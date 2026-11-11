// One adapter for every model call in Hex. OpenAI uses the Responses API; Groq uses its
// OpenAI-compatible Chat Completions API. Pick with LLM_PROVIDER, or let the first configured key win.
export type ProviderName = 'OpenAI' | 'Groq';
type Provider = { name: ProviderName; key: string; model: string };

export function provider(): Provider | undefined {
  const choice = (process.env.LLM_PROVIDER ?? '').trim().toLowerCase();
  const openai = process.env.OPENAI_API_KEY?.trim();
  const groq = process.env.GROQ_API_KEY?.trim();
  const useOpenAI = () => openai ? { name: 'OpenAI' as const, key: openai, model: process.env.OPENAI_MODEL || 'gpt-5.4-mini' } : undefined;
  const useGroq = () => groq ? { name: 'Groq' as const, key: groq, model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b' } : undefined;
  if (choice === 'openai') return useOpenAI();
  if (choice === 'groq') return useGroq();
  return useOpenAI() ?? useGroq();
}

export const aiEnabled = () => !!provider();
export const providerName = (): ProviderName | undefined => provider()?.name;

// Groq's free tier allows about 8,000 tokens per minute, so each review sends a smaller slice of source.
export function aiLimits() {
  return provider()?.name === 'Groq' ? { sourceChars: 12000, reviewTokens: 3500 } : { sourceChars: 24000, reviewTokens: 8000 };
}

export class ModelError extends Error {}

type Common = { instructions: string; input: string; maxTokens: number; lowEffort?: boolean };
type Schema = { name: string; schema: Record<string, unknown> };
type Tool = { name: string; description: string; parameters: Record<string, unknown> };
export type ModelRequest = Common & ({ schema?: Schema; tool?: undefined } | { tool: Tool; schema?: undefined });
export type PreparedRequest = { provider: Provider; url: string; body: string };

export function prepare(request: ModelRequest): PreparedRequest {
  const active = provider();
  if (!active) throw new ModelError('No AI provider key is configured');
  const { instructions, input, maxTokens, lowEffort, schema, tool } = request;
  if (active.name === 'OpenAI') {
    return { provider: active, url: 'https://api.openai.com/v1/responses', body: JSON.stringify({
      model: active.model,
      store: false,
      ...(lowEffort ? { reasoning: { effort: 'low' } } : {}),
      max_output_tokens: maxTokens,
      instructions,
      input,
      ...(schema ? { text: { format: { type: 'json_schema', name: schema.name, strict: true, schema: schema.schema } } } : {}),
      ...(tool ? {
        tools: [{ type: 'function', name: tool.name, description: tool.description, strict: true, parameters: tool.parameters }],
        tool_choice: { type: 'function', name: tool.name },
        parallel_tool_calls: false,
      } : {}),
    }) };
  }
  // gpt-oss models spend part of the completion budget on reasoning, so short calls get headroom.
  const reasoning = /gpt-oss|qwen/i.test(active.model);
  return { provider: active, url: 'https://api.groq.com/openai/v1/chat/completions', body: JSON.stringify({
    model: active.model,
    messages: [{ role: 'system', content: instructions }, { role: 'user', content: input }],
    max_completion_tokens: reasoning ? Math.max(maxTokens, 700) : maxTokens,
    ...(reasoning ? { reasoning_effort: 'low' } : {}),
    ...(schema ? { response_format: { type: 'json_schema', json_schema: { name: schema.name, strict: true, schema: schema.schema } } } : {}),
    ...(tool ? {
      tools: [{ type: 'function', function: { name: tool.name, description: tool.description, strict: true, parameters: tool.parameters } }],
      tool_choice: { type: 'function', function: { name: tool.name } },
      parallel_tool_calls: false,
    } : {}),
  }) };
}

async function post(prepared: PreparedRequest, timeoutMs: number) {
  const send = () => fetch(prepared.url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + prepared.provider.key, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
    body: prepared.body,
  });
  for (let attempt = 0; ; attempt++) {
    let response = await send();
    // Free tiers rate-limit by the minute; one short wait usually clears it.
    const wait = Number(response.headers.get('retry-after'));
    if (response.status === 429 && wait > 0 && wait <= 20) {
      await new Promise((resolve) => setTimeout(resolve, wait * 1000 + 250));
      response = await send();
    }
    if (response.ok) return response.json() as Promise<Record<string, any>>;
    const failure = await response.json().catch(() => null) as { error?: { message?: unknown; code?: unknown } } | null;
    const message = typeof failure?.error?.message === 'string' ? failure.error.message : '';
    // Groq rejects a reply that skipped a required tool call or broke the schema; sampling again usually succeeds.
    const flaky = prepared.provider.name === 'Groq' && response.status === 400
      && (failure?.error?.code === 'tool_use_failed' || /tool|json_validate_failed|schema/i.test(message));
    if (!flaky || attempt >= 2) throw new ModelError(('HTTP ' + response.status + ' ' + message).trim());
  }
}

// Sends a prepared request and returns its text, or the JSON arguments string of the forced tool call.
export async function send(prepared: PreparedRequest, timeoutMs: number, toolName?: string): Promise<string> {
  const result = await post(prepared, timeoutMs);
  if (prepared.provider.name === 'OpenAI') {
    if (result.status === 'incomplete') throw new ModelError('incomplete (' + (result.incomplete_details?.reason ?? 'unknown') + ')');
    if (toolName) {
      const calls = (result.output ?? []).filter((item: { type: string }) => item.type === 'function_call');
      if (calls.length !== 1 || calls[0].name !== toolName) throw new ModelError('Expected one ' + toolName + ' tool call');
      return calls[0].arguments ?? '{}';
    }
    return (result.output ?? []).flatMap((item: { content?: unknown[] }) => item.content ?? [])
      .find((part: { type: string }) => part.type === 'output_text')?.text ?? '';
  }
  const choice = result.choices?.[0];
  if (choice?.finish_reason === 'length') throw new ModelError('incomplete (max_output_tokens)');
  if (toolName) {
    const calls = choice?.message?.tool_calls ?? [];
    if (calls.length !== 1 || calls[0].function?.name !== toolName) throw new ModelError('Expected one ' + toolName + ' tool call');
    return calls[0].function.arguments ?? '{}';
  }
  return choice?.message?.content ?? '';
}

export async function complete(request: ModelRequest, timeoutMs: number) {
  return send(prepare(request), timeoutMs, request.tool?.name);
}

// Provider messages can echo a masked key, so strip anything key-shaped before it is logged or shown.
export function redact(text: string) {
  let out = text;
  for (const key of [process.env.OPENAI_API_KEY, process.env.GROQ_API_KEY]) if (key) out = out.split(key).join('[redacted]');
  return out.replace(/\b(?:sk|gsk)[-_][\w*.-]+/g, '[redacted]');
}
