/**
 * Vajra AI Agent — Tool-calling agent with automatic orchestration.
 * Handles multi-turn tool calling loops automatically.
 */

import type { AI } from './ai';
import type { Message, ToolDefinition, ToolCall, CompletionOptions } from './provider';

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

interface AgentOptions {
  ai: AI;
  tools: Tool[];
  systemPrompt?: string;
  maxIterations?: number;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  onToolCall?: (tool: string, args: Record<string, unknown>) => void;
  onToolResult?: (tool: string, result: string) => void;
}

interface AgentResult {
  content: string;
  toolCalls: { name: string; args: Record<string, unknown>; result: string }[];
  iterations: number;
}

export class Agent {
  private ai: AI;
  private tools: Tool[];
  private toolDefs: ToolDefinition[];
  private toolMap: Map<string, Tool>;
  private systemPrompt?: string;
  private maxIterations: number;
  private model?: string;
  private temperature?: number;
  private maxTokens?: number;
  private onToolCall?: (tool: string, args: Record<string, unknown>) => void;
  private onToolResult?: (tool: string, result: string) => void;

  constructor(options: AgentOptions) {
    this.ai = options.ai;
    this.tools = options.tools;
    this.systemPrompt = options.systemPrompt;
    this.maxIterations = options.maxIterations ?? 10;
    this.model = options.model;
    this.temperature = options.temperature;
    this.maxTokens = options.maxTokens;
    this.onToolCall = options.onToolCall;
    this.onToolResult = options.onToolResult;

    this.toolMap = new Map(options.tools.map(t => [t.name, t]));
    this.toolDefs = options.tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  /** Run the agent with a user message */
  async run(userMessage: string, history: Message[] = []): Promise<AgentResult> {
    const messages: Message[] = [...history];

    if (this.systemPrompt) {
      messages.unshift({ role: 'system', content: this.systemPrompt });
    }

    messages.push({ role: 'user', content: userMessage });

    const allToolCalls: { name: string; args: Record<string, unknown>; result: string }[] = [];
    let iterations = 0;

    while (iterations < this.maxIterations) {
      iterations++;

      const completionOpts: CompletionOptions = {
        messages,
        tools: this.toolDefs,
        model: this.model,
        temperature: this.temperature,
        maxTokens: this.maxTokens,
      };

      const result = await this.ai.complete(completionOpts);

      // No tool calls — return final content
      if (!result.toolCalls || result.toolCalls.length === 0) {
        return { content: result.content, toolCalls: allToolCalls, iterations };
      }

      // Add assistant message with tool calls
      messages.push({ role: 'assistant', content: result.content || '' });

      // Execute each tool call
      for (const toolCall of result.toolCalls) {
        const tool = this.toolMap.get(toolCall.name);
        if (!tool) {
          messages.push({
            role: 'tool',
            content: `Error: Unknown tool '${toolCall.name}'`,
            toolCallId: toolCall.id,
          });
          continue;
        }

        this.onToolCall?.(toolCall.name, toolCall.arguments);

        try {
          const toolResult = await tool.execute(toolCall.arguments);
          this.onToolResult?.(toolCall.name, toolResult);

          allToolCalls.push({
            name: toolCall.name,
            args: toolCall.arguments,
            result: toolResult,
          });

          messages.push({
            role: 'tool',
            content: toolResult,
            toolCallId: toolCall.id,
          });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          messages.push({
            role: 'tool',
            content: `Error executing ${toolCall.name}: ${errorMsg}`,
            toolCallId: toolCall.id,
          });
        }
      }
    }

    // Max iterations reached
    return {
      content: 'Agent reached maximum iterations without completing.',
      toolCalls: allToolCalls,
      iterations,
    };
  }
}
