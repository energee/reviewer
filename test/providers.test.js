import test from 'node:test';
import assert from 'node:assert/strict';
import { review } from '../dist/reviewer.js';

const files = [{ path: 'src/a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' }];
const base = { model: 'test-model', diff: 'diff', files, readFile: async () => 'new\n', listFiles: async () => ['src/a.ts'] };
const submitted = { summary: 'Reviewed.', limitations: [], findings: [] };

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

test('OpenAI Responses tool loop submits validated review and totals usage', async () => {
  const requests = [];
  const result = await review({
    ...base,
    provider: 'openai',
    apiKey: 'key',
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return response(requests.length === 1
        ? { id: 'r1', usage: { input_tokens: 3, output_tokens: 5 }, output: [{ type: 'function_call', name: 'read_file', call_id: 'c1', arguments: JSON.stringify({ path: 'src/a.ts' }) }] }
        : { id: 'r2', usage: { input_tokens: 7, output_tokens: 11 }, output: [{ type: 'function_call', name: 'submit_review', call_id: 'c2', arguments: JSON.stringify(submitted) }] });
    },
  });
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 16 });
});

test('OpenAI rejects malformed function arguments without accepting prose', async () => {
  await assert.rejects(review({
    ...base,
    provider: 'openai',
    apiKey: 'key',
    fetchImpl: async () => response({ id: 'r1', output: [{ type: 'function_call', name: 'submit_review', call_id: 'c1', arguments: '{' }] }),
  }), /invalid JSON arguments/);
});

test('OpenAI surfaces actionable API failures', async () => {
  await assert.rejects(review({
    ...base,
    provider: 'openai',
    apiKey: 'key',
    fetchImpl: async () => response({ error: 'nope' }, 429),
  }), /OpenAI Responses API request failed \(429/);
});


test('unavailable context does not leak backend error details into model requests', async () => {
  const privateDetail = 'private-backend-credential-should-not-be-forwarded';
  const sent = [];
  await review({
    ...base, provider: 'openai', apiKey: 'key',
    readFile: async () => { throw new Error(privateDetail); },
    fetchImpl: async (_url, init) => {
      sent.push(init.body);
      return response(sent.length === 1
        ? { id: 'lookup', output: [{ type: 'function_call', name: 'read_file', call_id: 'read', arguments: JSON.stringify({ path: 'src/a.ts' }) }] }
        : { id: 'finish', output: [{ type: 'function_call', name: 'submit_review', call_id: 'done', arguments: JSON.stringify(submitted) }] });
    },
  });
  assert.equal(sent.some(body => body.includes(privateDetail)), false);
});

test('invalid context parameters cannot execute a read and can be corrected within the turn budget', async () => {
  let requests = 0;
  let reads = 0;
  await review({
    ...base, provider: 'openai', apiKey: 'key', maxTurns: 3,
    readFile: async () => { reads++; return 'new\n'; },
    fetchImpl: async () => {
      requests++;
      const call = requests === 3
        ? { name: 'submit_review', input: submitted }
        : { name: 'read_file', input: requests === 1 ? { path: 'src/a.ts', unexpected: true } : { path: 'src/a.ts' } };
      return response({ id: `r${requests}`, output: [{
        type: 'function_call', name: call.name, call_id: `c${requests}`, arguments: JSON.stringify(call.input),
      }] });
    },
  });
  assert.equal(reads, 1);
  assert.equal(requests, 3);
});
