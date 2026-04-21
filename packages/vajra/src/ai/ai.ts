/**
 * Vajra AI — High-level AI client with multi-provider, cost tracking, token budgets.
 */

import type { AIProvider, CompletionOptions, CompletionResult, StreamChunk, Message, ToolDefinition } from './provider';

/** USD per 1 million tokens, separate input/output rates. */
export interface ModelPricing {
  input: number;
  output: number;
}

/**
 * Best-effort pricing table shipped with the framework.
 *
 * Providers change prices. Treat these as last-known-good snapshots, not a
 * contract. Override via new AI({ pricing: { ... } }) for anything that
 * matters to your billing.
 */
export const DEFAULT_AI_PRICING: Record<string, ModelPricing> = {
  // Claude (legacy ids kept so existing apps keep working)
  'claude-sonnet-4-20250514': { input: 3, output: 15 },
  'claude-opus-4-20250514': { input: 15, output: 75 },
  'claude-haiku-4-20250514': { input: 0.8, output: 4 },
  // OpenAI
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4-turbo': { input: 10, output: 30 },
};

interface AIOptions {
  provider: AIProvider;
  defaultModel?: string;
  maxTokenBudget?: number;
  onUsage?: (usage: UsageRecord) => void;
  /**
   * Pricing table override. Merged on top of DEFAULT_AI_PRICING.
   * Keys are provider model IDs; values are USD per 1M tokens.
   *
   * @example
   *   new AI({
   *     provider: claudeProvider,
   *     pricing: { 'claude-sonnet-4-6': { input: 3, output: 15 } },
   *   });
   */
  pricing?: Record<string, ModelPricing>;
  /**
   * Called once per model the first time it appears in a completion
   * without a matching pricing entry. Defaults to a single console.warn
   * per missing model. Pass a no-op to silence.
   */
  onMissingPricing?: (model: string) => void;
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

function buildEstimator(
  overrides: Record<string, ModelPricing> | undefined,
  onMissing: (model: string) => void,
): (model: string, p: number, c: number) => number {
  const table: Record<string, ModelPricing> = { ...DEFAULT_AI_PRICING, ...(overrides ?? {}) };
  const warned = new Set<string>();
  return (model, promptTokens, completionTokens) => {
    const pricing = table[model];
    if (!pricing) {
      if (!warned.has(model)) {
        warned.add(model);
        onMissing(model);
      }
      return 0;
    }
    return (promptTokens / 1_000_000 * pricing.input) + (completionTokens / 1_000_000 * pricing.output);
  };
}

export class AI {
  private provider: AIProvider;
  private defaultModel?: string;
  private maxTokenBudget: number;
  private totalTokensUsed = 0;
  private usageHistory: UsageRecord[] = [];
  private onUsage?: (usage: UsageRecord) => void;
  private estimator: (model: string, p: number, c: number) => number;

  constructor(options: AIOptions) {
    this.provider = options.provider;
    this.defaultModel = options.defaultModel;
    this.maxTokenBudget = options.maxTokenBudget ?? Infinity;
    this.onUsage = options.onUsage;
    const onMissing = options.onMissingPricing ?? ((model: string) => {
      console.warn(
        `[Vajra AI] No pricing entry for model "${model}". Cost tracked as 0. ` +
        `Pass { pricing: { "${model}": { input, output } } } to AI() to fix.`,
      );
    });
    this.estimator = buildEstimator(options.pricing, onMissing);
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
      estimatedCost: this.estimator(result.model, result.usage.promptTokens, result.usage.completionTokens),
      timestamp: Date.now(),
    };

    this.totalTokensUsed += result.usage.totalTokens;
    this.usageHistory.push(record);
    this.onUsage?.(record);
  }
}
