/**
 * Vajra AI — High-level AI client with multi-provider, cost tracking, token budgets.
 */

import type { AIProvider, CompletionOptions, CompletionResult, StreamChunk, Message, ToolDefinition } from './provider';

interface AIOptions {
  provider: AIProvider;
  defaultModel?: string;
  maxTokenBudget?: number;
  onUsage?: (usage: UsageRecord) => void;
}

export interface UsageRecord {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCost: number;
  timestamp: number;
}

// Approximate pricing per 1M tokens (input/output)
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-20250514': { input: 3, output: 15 },
  'claude-opus-4-20250514': { input: 15, output: 75 },
  'claude-haiku-4-20250514': { input: 0.8, output: 4 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4-turbo': { input: 10, output: 30 },
};

function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const pricing = PRICING[model];
  if (!pricing) return 0;
  return (promptTokens / 1_000_000 * pricing.input) + (completionTokens / 1_000_000 * pricing.output);
}

export class AI {
  private provider: AIProvider;
  private defaultModel?: string;
  private maxTokenBudget: number;
  private totalTokensUsed = 0;
  private usageHistory: UsageRecord[] = [];
  private onUsage?: (usage: UsageRecord) => void;

  constructor(options: AIOptions) {
    this.provider = options.provider;
    this.defaultModel = options.defaultModel;
    this.maxTokenBudget = options.maxTokenBudget ?? Infinity;
    this.onUsage = options.onUsage;
  }

  /** Send a completion request */
  async complete(options: CompletionOptions): Promise<CompletionResult> {
    if (this.totalTokensUsed >= this.maxTokenBudget) {
      throw new Error('Token budget exceeded');
    }

    const opts = { ...options, model: options.model ?? this.defaultModel };
    const result = await this.provider.complete(opts);

    this.trackUsage(result);
    return result;
  }

  /** Stream a completion request */
  async *stream(options: CompletionOptions): AsyncGenerator<StreamChunk> {
    if (this.totalTokensUsed >= this.maxTokenBudget) {
      yield { type: 'error', error: 'Token budget exceeded' };
      return;
    }

    const opts = { ...options, model: options.model ?? this.defaultModel };
    for await (const chunk of this.provider.stream(opts)) {
      yield chunk;
      if (chunk.type === 'done' && chunk.usage) {
        this.trackUsage({
          content: '',
          model: opts.model ?? '',
          usage: chunk.usage,
          finishReason: 'stop',
        });
      }
    }
  }

  /** Simple chat: send a message, get a string back */
  async chat(prompt: string, options?: Partial<CompletionOptions>): Promise<string> {
    const result = await this.complete({
      ...options,
      messages: [
        ...(options?.messages ?? []),
        { role: 'user', content: prompt },
      ],
    });
    return result.content;
  }

  /** Get usage statistics */
  get usage(): { totalTokens: number; totalCost: number; history: UsageRecord[] } {
    const totalCost = this.usageHistory.reduce((sum, r) => sum + r.estimatedCost, 0);
    return {
      totalTokens: this.totalTokensUsed,
      totalCost: Math.round(totalCost * 10000) / 10000,
      history: [...this.usageHistory],
    };
  }

  /** Reset usage tracking */
  resetUsage(): void {
    this.totalTokensUsed = 0;
    this.usageHistory = [];
  }

  private trackUsage(result: CompletionResult): void {
    const record: UsageRecord = {
      provider: this.provider.name,
      model: result.model,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      totalTokens: result.usage.totalTokens,
      estimatedCost: estimateCost(result.model, result.usage.promptTokens, result.usage.completionTokens),
      timestamp: Date.now(),
    };

    this.totalTokensUsed += result.usage.totalTokens;
    this.usageHistory.push(record);
    this.onUsage?.(record);
  }
}
