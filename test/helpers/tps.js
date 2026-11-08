// Shared TPS test fixtures: gateway requests, sample builders, and route seeding.
import { createTestApp } from './app.js';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Sends one chat completion through the gateway.
export async function chat(baseUrl, raw, model, { stream = false } = {}) {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${raw}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      ...(stream ? { stream: true } : {}),
    }),
  });
  const text = await response.text();
  return { status: response.status, text, provider: response.headers.get('x-smolrouter-provider') };
}

// Builds one valid or invalid TPS sample.
export function sample({
  effectiveTps = 200, contentTokens = 200, finishReason = 'stop', contentTtftMs = 100, cachedTokens = 0,
} = {}) {
  return {
    finishReason,
    contentTokens,
    effectiveTps,
    contentTps: effectiveTps,
    contentTtftMs,
    contentGenerationMs: 1000,
    cachedTokens,
  };
}

// Writes one SSE completion with the supplied token accounting.
export function sseUsage(res, { contentTokens = 200, reasoningTokens = 0, finishReason = 'stop' } = {}) {
  res.statusCode = 200;
  res.setHeader('content-type', 'text/event-stream');
  const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
  res.end([
    frame({ choices: [{ delta: { content: 'code '.repeat(20) } }] }),
    frame({ choices: [{ delta: {}, finish_reason: finishReason }] }),
    frame({
      choices: [],
      usage: {
        prompt_tokens: 10,
        completion_tokens: contentTokens + reasoningTokens,
        completion_tokens_details: { reasoning_tokens: reasoningTokens },
      },
    }),
    'data: [DONE]\n\n',
  ].join(''));
}

// Seeds a model with a preferred route and a fallback route.
export async function seedRoutes(upstreamA, upstreamB, { balanceStrategy = 'round_robin' } = {}) {
  const app = await createTestApp();
  const providerA = app.addProvider('preferred', upstreamA.baseUrl);
  const providerB = app.addProvider('fallback', upstreamB.baseUrl);
  const model = app.app.registry.createModel({ name: 'tps-model', balanceStrategy });
  const routeA = app.app.registry.createRoute({ modelId: model.id, providerId: providerA.id, upstreamModel: 'ua' });
  const routeB = app.app.registry.createRoute({
    modelId: model.id, providerId: providerB.id, upstreamModel: 'ub', priority: 2,
  });
  const { raw } = app.addToken('client', [model.id]);
  return { app, model, routeA, routeB, raw, providerA, providerB };
}
