/**
 * Vajra AI Provider — Unified multi-provider LLM interface.
 * Same API for Claude, GPT, Gemini, Ollama. Streaming-first.
 */

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  toolCallId?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface CompletionOptions {
  model?: string;
  messages: Message[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stop?: string[];
  tools?: ToolDefinition[];
  stream?: boolean;
}

export interface CompletionResult {
  content: string;
  toolCalls?: ToolCall[];
  model: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter';
}

export interface StreamChunk {
  type: 'text' | 'tool_call' | 'done' | 'error';
  content?: string;
  toolCall?: ToolCall;
  usage?: CompletionResult['usage'];
  error?: string;
}

export interface AIProvider {
  name: string;
  complete(options: CompletionOptions): Promise<CompletionResult>;
  stream(options: CompletionOptions): AsyncGenerator<StreamChunk>;
}

/** Claude (Anthropic) provider */
export function createClaudeProvider(config: {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
}): AIProvider {
  const baseUrl = config.baseUrl ?? 'https://api.anthropic.com';
  const defaultModel = config.defaultModel ?? 'claude-sonnet-4-20250514';

  function convertMessages(messages: Message[]): { system?: string; messages: any[] } {
    let system: string | undefined;
    const converted: any[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        system = msg.content;
      } else if (msg.role === 'tool') {
        converted.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: msg.toolCallId, content: msg.content }],
        });
      } else {
        converted.push({ role: msg.role, content: msg.content });
      }
    }

    return { system, messages: converted };
  }

  function convertTools(tools?: ToolDefinition[]): any[] | undefined {
    if (!tools?.length) return undefined;
    return tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }

  return {
    name: 'claude',

    async complete(options) {
      const { system, messages } = convertMessages(options.messages);
      const body: any = {
        model: options.model ?? defaultModel,
        messages,
        max_tokens: options.maxTokens ?? 4096,
      };
      if (system) body.system = system;
      if (options.temperature !== undefined) body.temperature = options.temperature;
      if (options.topP !== undefined) body.top_p = options.topP;
      if (options.stop) body.stop_sequences = options.stop;
      const tools = convertTools(options.tools);
      if (tools) body.tools = tools;

      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Claude API error (${res.status}): ${err}`);
      }

      const data = await res.json() as any;
      let content = '';
      const toolCalls: ToolCall[] = [];

      for (const block of data.content) {
        if (block.type === 'text') content += block.text;
        if (block.type === 'tool_use') {
          toolCalls.push({ id: block.id, name: block.name, arguments: block.input });
        }
      }

      return {
        content,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        model: data.model,
        usage: {
          promptTokens: data.usage.input_tokens,
          completionTokens: data.usage.output_tokens,
          totalTokens: data.usage.input_tokens + data.usage.output_tokens,
        },
        finishReason: data.stop_reason === 'end_turn' ? 'stop'
          : data.stop_reason === 'tool_use' ? 'tool_calls'
          : data.stop_reason === 'max_tokens' ? 'length'
          : 'stop',
      };
    },

    async *stream(options) {
      const { system, messages } = convertMessages(options.messages);
      const body: any = {
        model: options.model ?? defaultModel,
        messages,
        max_tokens: options.maxTokens ?? 4096,
        stream: true,
      };
      if (system) body.system = system;
      if (options.temperature !== undefined) body.temperature = options.temperature;
      const tools = convertTools(options.tools);
      if (tools) body.tools = tools;

      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        yield { type: 'error' as const, error: `Claude API error: ${res.status}` };
        return;
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            yield { type: 'done' as const };
            return;
          }

          try {
            const event = JSON.parse(data);
            if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
              yield { type: 'text' as const, content: event.delta.text };
            }
            if (event.type === 'message_delta' && event.usage) {
              yield {
                type: 'done' as const,
                usage: {
                  promptTokens: event.usage.input_tokens ?? 0,
                  completionTokens: event.usage.output_tokens ?? 0,
                  totalTokens: (event.usage.input_tokens ?? 0) + (event.usage.output_tokens ?? 0),
                },
              };
            }
          } catch { /* skip malformed lines */ }
        }
      }
    },
  };
}

/** OpenAI-compatible provider (GPT, Groq, Together, local) */
export function createOpenAIProvider(config: {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
}): AIProvider {
  const baseUrl = config.baseUrl ?? 'https://api.openai.com';
  const defaultModel = config.defaultModel ?? 'gpt-4o';

  function convertTools(tools?: ToolDefinition[]): any[] | undefined {
    if (!tools?.length) return undefined;
    return tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  return {
    name: 'openai',

    async complete(options) {
      const body: any = {
        model: options.model ?? defaultModel,
        messages: options.messages.map(m => ({ role: m.role, content: m.content, ...(m.name ? { name: m.name } : {}), ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}) })),
        max_tokens: options.maxTokens,
      };
      if (options.temperature !== undefined) body.temperature = options.temperature;
      if (options.topP !== undefined) body.top_p = options.topP;
      if (options.stop) body.stop = options.stop;
      const tools = convertTools(options.tools);
      if (tools) body.tools = tools;

      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`OpenAI API error (${res.status}): ${err}`);
      }

      const data = await res.json() as any;
      const choice = data.choices[0];
      const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((tc: any) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments),
      }));

      return {
        content: choice.message.content ?? '',
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        model: data.model,
        usage: {
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens,
        },
        finishReason: choice.finish_reason === 'tool_calls' ? 'tool_calls'
          : choice.finish_reason === 'length' ? 'length'
          : choice.finish_reason === 'content_filter' ? 'content_filter'
          : 'stop',
      };
    },

    async *stream(options) {
      const body: any = {
        model: options.model ?? defaultModel,
        messages: options.messages.map(m => ({ role: m.role, content: m.content })),
        max_tokens: options.maxTokens,
        stream: true,
      };
      if (options.temperature !== undefined) body.temperature = options.temperature;
      const tools = convertTools(options.tools);
      if (tools) body.tools = tools;

      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        yield { type: 'error' as const, error: `OpenAI API error: ${res.status}` };
        return;
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            yield { type: 'done' as const };
            return;
          }

          try {
            const event = JSON.parse(data);
            const delta = event.choices?.[0]?.delta;
            if (delta?.content) {
              yield { type: 'text' as const, content: delta.content };
            }
          } catch { /* skip */ }
        }
      }
    },
  };
}

/** Ollama provider (local models) */
export function createOllamaProvider(config: {
  baseUrl?: string;
  defaultModel?: string;
}): AIProvider {
  const baseUrl = config.baseUrl ?? 'http://localhost:11434';
  const defaultModel = config.defaultModel ?? 'llama3';

  return {
    name: 'ollama',

    async complete(options) {
      const body = {
        model: options.model ?? defaultModel,
        messages: options.messages.map(m => ({ role: m.role, content: m.content })),
        stream: false,
        options: {
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options.topP !== undefined ? { top_p: options.topP } : {}),
          ...(options.maxTokens ? { num_predict: options.maxTokens } : {}),
        },
      };

      const res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) throw new Error(`Ollama error: ${res.status}`);
      const data = await res.json() as any;

      return {
        content: data.message.content,
        model: data.model,
        usage: {
          promptTokens: data.prompt_eval_count ?? 0,
          completionTokens: data.eval_count ?? 0,
          totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
        },
        finishReason: 'stop',
      };
    },

    async *stream(options) {
      const body = {
        model: options.model ?? defaultModel,
        messages: options.messages.map(m => ({ role: m.role, content: m.content })),
        stream: true,
        options: {
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options.topP !== undefined ? { top_p: options.topP } : {}),
          ...(options.maxTokens ? { num_predict: options.maxTokens } : {}),
        },
      };

      const res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        yield { type: 'error' as const, error: `Ollama error: ${res.status}` };
        return;
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            if (data.message?.content) {
              yield { type: 'text' as const, content: data.message.content };
            }
            if (data.done) {
              yield { type: 'done' as const };
              return;
            }
          } catch { /* skip */ }
        }
      }
    },
  };
}
