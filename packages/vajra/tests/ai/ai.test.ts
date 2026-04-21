import { describe, it, expect } from 'bun:test';
import { AI, DEFAULT_AI_PRICING } from '../../src/index';
import type { AIProvider, CompletionOptions, CompletionResult, StreamChunk, ModelPricing } from '../../src/index';

// Mock provider for testing without real API calls
function createMockProvider(response: Partial<CompletionResult> = {}): AIProvider {
  return {
    name: 'mock',
    async complete(options: CompletionOptions): Promise<CompletionResult> {
      return {
        content: response.content ?? 'Mock response',
        model: response.model ?? 'mock-model',
        usage: response.usage ?? { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        finishReason: response.finishReason ?? 'stop',
        toolCalls: response.toolCalls,
      };
    },
    async *stream(options: CompletionOptions): AsyncGenerator<StreamChunk> {
      yield { type: 'text', content: response.content ?? 'Mock ' };
      yield { type: 'text', content: 'stream' };
      yield { type: 'done', usage: response.usage ?? { promptTokens: 10, completionTokens: 20, totalTokens: 30 } };
    },
  };
}

describe('AI Client', () => {
  it('sends completion request', async () => {
    const ai = new AI({ provider: createMockProvider({ content: 'Hello from AI' }) });
    const result = await ai.complete({
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(result.content).toBe('Hello from AI');
    expect(result.usage.totalTokens).toBe(30);
  });

  it('chat helper returns string', async () => {
    const ai = new AI({ provider: createMockProvider({ content: 'Quick answer' }) });
    const answer = await ai.chat('What is 2+2?');
    expect(answer).toBe('Quick answer');
  });

  it('tracks usage', async () => {
    const ai = new AI({ provider: createMockProvider() });
    await ai.chat('Test 1');
    await ai.chat('Test 2');

    expect(ai.usage.totalTokens).toBe(60);
    expect(ai.usage.history.length).toBe(2);
  });

  it('token budget enforcement', async () => {
    const ai = new AI({
      provider: createMockProvider({ usage: { promptTokens: 50, completionTokens: 50, totalTokens: 100 } }),
      maxTokenBudget: 50,
    });

    try {
      // First call uses 100 tokens but budget is only 50, checked AFTER first call
      await ai.chat('First call');
      // After first call, totalTokensUsed = 100, now exceeds budget of 50
      await ai.chat('Second call'); // Should throw
      expect(true).toBe(false);
    } catch (err) {
      expect((err as Error).message).toContain('Token budget exceeded');
    }
  });

  it('onUsage callback fires', async () => {
    let lastUsage: any = null;
    const ai = new AI({
      provider: createMockProvider(),
      onUsage: (usage) => { lastUsage = usage; },
    });

    await ai.chat('Test');
    expect(lastUsage).not.toBeNull();
    expect(lastUsage.provider).toBe('mock');
    expect(lastUsage.totalTokens).toBe(30);
  });

  it('resetUsage clears history', async () => {
    const ai = new AI({ provider: createMockProvider() });
    await ai.chat('Test');
    expect(ai.usage.totalTokens).toBe(30);

    ai.resetUsage();
    expect(ai.usage.totalTokens).toBe(0);
    expect(ai.usage.history.length).toBe(0);
  });

  it('streaming works', async () => {
    const ai = new AI({ provider: createMockProvider({ content: 'Hello' }) });
    const chunks: string[] = [];

    for await (const chunk of ai.stream({ messages: [{ role: 'user', content: 'Hi' }] })) {
      if (chunk.type === 'text' && chunk.content) {
        chunks.push(chunk.content);
      }
    }

    expect(chunks.length).toBeGreaterThan(0);
  });

  it('tool calls in response', async () => {
    const ai = new AI({
      provider: createMockProvider({
        content: '',
        toolCalls: [{ id: 'tc1', name: 'search', arguments: { q: 'test' } }],
        finishReason: 'tool_calls',
      }),
    });

    const result = await ai.complete({
      messages: [{ role: 'user', content: 'Search for test' }],
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe('search');
  });
});

describe('AI pricing config', () => {
  it('DEFAULT_AI_PRICING is exported with known models', () => {
    expect(DEFAULT_AI_PRICING['gpt-4o']).toEqual({ input: 2.5, output: 10 });
    expect(DEFAULT_AI_PRICING['claude-sonnet-4-20250514']).toBeDefined();
  });

  it('custom pricing overrides defaults', async () => {
    const ai = new AI({
      provider: createMockProvider({ model: 'my-custom-model', usage: { promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000 } }),
      pricing: { 'my-custom-model': { input: 1, output: 2 } },
      onMissingPricing: () => { /* silence warning */ },
    });
    await ai.chat('test');
    // 1M input * $1 + 1M output * $2 = $3
    expect(ai.usage.totalCost).toBe(3);
  });

  it('unknown model falls back to 0 cost and fires onMissingPricing once', async () => {
    let missingCalls = 0;
    const ai = new AI({
      provider: createMockProvider({ model: 'unknown-model' }),
      onMissingPricing: () => { missingCalls++; },
    });
    await ai.chat('first');
    await ai.chat('second');
    await ai.chat('third');

    expect(ai.usage.totalCost).toBe(0);
    expect(missingCalls).toBe(1); // deduped per model
  });

  it('merges defaults with overrides (default stays accessible)', async () => {
    const ai = new AI({
      provider: createMockProvider({
        model: 'gpt-4o',
        usage: { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 },
      }),
      pricing: { 'my-custom': { input: 99, output: 99 } }, // unrelated addition
      onMissingPricing: () => {},
    });
    await ai.chat('test');
    // gpt-4o default $2.5 / 1M input tokens
    expect(ai.usage.totalCost).toBe(2.5);
  });
});
