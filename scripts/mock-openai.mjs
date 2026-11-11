import assert from 'node:assert/strict';

const fetchReal = globalThis.fetch;
// Blue picks: broad quarantine first (fails the control), then the scoped fix, then prompt.
// The ownership fix is applied deterministically once the per-run AI budget is reached.
const labChoices = ['quarantine_sql', 'fix_sql', 'fix_prompt'];
let crafted = 0;

globalThis.fetch = async (url, init) => {
  if (String(url) !== 'https://api.openai.com/v1/responses') return fetchReal(url, init);
  const body = JSON.parse(init.body);
  assert.equal(body.reasoning?.effort, 'low', 'reasoning effort must be low');
  assert.ok(body.max_output_tokens <= 400, 'max_output_tokens must be <= 400');
  if (!body.tools) {
    return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Mock analysis' }] }] });
  }
  const tool = body.tools[0].name;
  if (tool === 'craft_payload') {
    crafted += 1;
    // A baseline-leaking payload; against the hardened endpoint it simply returns no rows.
    const payload = crafted === 1 ? "' OR 1=1 --" : "' OR " + crafted + " = " + crafted + " --";
    return Response.json({ output: [{ type: 'function_call', name: 'craft_payload', arguments: JSON.stringify({ payload, rationale: 'mock ' + crafted }) }] });
  }
  const offered = body.tools[0].parameters.properties.action.enum;
  // Scripted picks first, then the first scoped fix on offer.
  const action = labChoices.shift() ?? offered.find((name) => name.startsWith('fix_'));
  assert.ok(offered.includes(action), 'Action missing: ' + action);
  return Response.json({
    output: [{ type: 'function_call', name: 'lab_action', arguments: JSON.stringify({ action, reason: 'Mock selected ' + action }) }],
  });
};
