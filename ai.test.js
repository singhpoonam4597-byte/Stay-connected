import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { once } from 'node:events';
import aiRoutes from './ai.js';

const providerEnv = ['AI_PROVIDER', 'GROQ_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY'];
const savedEnv = Object.fromEntries(providerEnv.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api/ai', aiRoutes);
let server;
let port;

function setNoProviders() {
  process.env.AI_PROVIDER = 'groq';
  process.env.GROQ_API_KEY = '';
  process.env.GEMINI_API_KEY = '';
  process.env.OPENAI_API_KEY = '';
  process.env.XAI_API_KEY = '';
}

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: payload ? {
        'content-type': 'application/json',
        'content-length': payload.length,
      } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = {};
        try { data = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test.before(async () => {
  setNoProviders();
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  port = server.address().port;
});

test.after(async () => {
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
  await new Promise((resolve) => server.close(resolve));
  for (const key of providerEnv) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

test('Intelligence status advertises the supported native modes', async () => {
  const response = await request('GET', '/api/ai/status');
  assert.equal(response.status, 200);
  assert.equal(response.data.data.ready, false);
  assert.deepEqual(response.data.data.features, [
    'chat', 'study', 'code', 'writing', 'research', 'summarize', 'document',
  ]);
  assert.equal(response.data.data.module, 'intelligence');
});

test('chat route rejects unknown modes and malformed conversation history', async () => {
  const invalidMode = await request('POST', '/api/ai/chat', {
    feature: 'image',
    messages: [{ role: 'user', content: 'Hello' }],
  });
  assert.equal(invalidMode.status, 400);
  assert.equal(invalidMode.data.code, 'BAD_FEATURE');

  const assistantLast = await request('POST', '/api/ai/chat', {
    feature: 'chat',
    messages: [{ role: 'user', content: 'Question' }, { role: 'assistant', content: 'Answer' }],
  });
  assert.equal(assistantLast.status, 400);
  assert.equal(assistantLast.data.code, 'NO_MESSAGE');

  const nonTextContent = await request('POST', '/api/ai/chat', {
    feature: 'chat',
    messages: [{ role: 'user', content: { unexpected: true } }],
  });
  assert.equal(nonTextContent.status, 400);
  assert.equal(nonTextContent.data.code, 'NO_MESSAGE');
});

test('all text modes use their branded prompt and bounded message history', async () => {
  const prompts = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    prompts.push(body);
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'A helpful, safe response.' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  process.env.AI_PROVIDER = 'groq';
  process.env.GROQ_API_KEY = 'test-only-key';

  const modes = ['chat', 'study', 'code', 'writing', 'research', 'summarize', 'document'];
  for (const feature of modes) {
    const response = await request('POST', '/api/ai/chat', {
      feature,
      messages: [{ role: 'user', content: `Test prompt for ${feature}` }],
    });
    assert.equal(response.status, 200, `${feature} should return a successful response`);
    assert.equal(response.data.data.message.content, 'A helpful, safe response.');
    assert.match(prompts.at(-1).messages[0].content, /Connect AI|You are Connect AI/);
  }

  const manyMessages = Array.from({ length: 23 }, (_, index) => ({
    role: index === 22 ? 'user' : index % 2 ? 'assistant' : 'user',
    content: `message-${index}`,
  }));
  const boundedResponse = await request('POST', '/api/ai/chat', {
    feature: 'chat',
    messages: manyMessages,
  });
  assert.equal(boundedResponse.status, 200);
  const boundedMessages = prompts.at(-1).messages;
  assert.equal(boundedMessages.length, 21, 'system prompt plus at most 20 history messages');
  assert.equal(boundedMessages[1].content, 'message-3', 'oldest history is discarded');
  assert.equal(boundedMessages.at(-1).content, 'message-22');

  const longResponse = await request('POST', '/api/ai/chat', {
    feature: 'document',
    messages: [{ role: 'user', content: `${'x'.repeat(8100)}   ` }],
  });
  assert.equal(longResponse.status, 200);
  assert.equal(prompts.at(-1).messages[1].content.length, 8000);
});

test('chat route returns a branded unavailable response when no AI provider is configured', async () => {
  setNoProviders();
  const response = await request('POST', '/api/ai/chat', {
    feature: 'writing',
    messages: [{ role: 'user', content: 'Write a short greeting.' }],
  });
  assert.equal(response.status, 503);
  assert.equal(response.data.code, 'AI_NOT_CONFIGURED');
  assert.equal(response.data.error, 'Connect AI is not configured yet. Please try again later.');
});

test('provider diagnostics are not exposed in the client error response', async () => {
  process.env.AI_PROVIDER = 'openai';
  process.env.OPENAI_API_KEY = 'test-only-key';
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { message: 'internal-provider-detail-should-not-leak' },
  }), { status: 429, headers: { 'content-type': 'application/json' } });
  console.error = () => {};

  const response = await request('POST', '/api/ai/chat', {
    feature: 'chat',
    messages: [{ role: 'user', content: 'Hello' }],
  });
  assert.equal(response.status, 502);
  assert.equal(response.data.code, 'AI_UPSTREAM');
  assert.equal(response.data.error, 'Connect AI is temporarily unavailable. Try again.');
  assert.doesNotMatch(JSON.stringify(response.data), /internal-provider-detail/);
});
