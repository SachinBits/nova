import assert from 'node:assert/strict';

const fetchReal = globalThis.fetch;
const choices = [
  'prompt_alternate', 'sql_alternate', 'ownership',
  'quarantine_sql', 'fix_ownership', 'fix_sql', 'fix_prompt',
];

globalThis.fetch = async (url, init) => {
  if (String(url) !== 'https://api.openai.com/v1/responses') return fetchReal(url, init);
  const body = JSON.parse(init.body);
  if (!body.tools) {
    return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Mock analysis' }] }] });
  }
  const action = choices.shift();
  assert.ok(body.tools[0].parameters.properties.action.enum.includes(action), 'Action missing: ' + action);
  const { state } = JSON.parse(body.input);
  if (action === 'ownership') assert.equal(state.discoveredOrder, 'B-200');
  if (action === 'fix_sql') {
    assert.equal(state.findings.find(({ id }) => id === 'sql').control.status, 503);
  }
  return Response.json({
    output: [{ type: 'function_call', name: 'lab_action', arguments: JSON.stringify({ action, reason: 'Mock selected ' + action }) }],
  });
};
