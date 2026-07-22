'use strict';

const OpenAI = require('openai');
const { BaseLLMProvider } = require('./baseProvider');

function toOpenAITools(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

function toOpenAIMessages(systemPrompt, turns) {
  const messages = [{ role: 'system', content: systemPrompt }];
  for (const turn of turns) {
    if (turn.role === 'user') {
      messages.push({ role: 'user', content: turn.content });
    } else if (turn.role === 'assistant') {
      const msg = { role: 'assistant', content: turn.content || null };
      if (turn.toolCalls && turn.toolCalls.length) {
        msg.tool_calls = turn.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) },
        }));
      }
      messages.push(msg);
    } else if (turn.role === 'tool') {
      messages.push({ role: 'tool', tool_call_id: turn.toolCallId, content: JSON.stringify(turn.result) });
    }
  }
  return messages;
}

class OpenAIProvider extends BaseLLMProvider {
  constructor({ apiKey, model }) {
    super({ providerId: 'openai', providerLabel: 'OpenAI' });
    if (!apiKey) throw new Error('OpenAIProvider requires an apiKey');
    this.model = model;
    this.client = new OpenAI({ apiKey });
    // Per-API-call token usage, most recent call last. Read by callers that
    // want to cost out a whole chat() turn (which may span several calls).
    this.usageLog = [];
  }

  async converse({ systemPrompt, turns, tools }) {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: toOpenAIMessages(systemPrompt, turns),
      tools: tools.length ? toOpenAITools(tools) : undefined,
      tool_choice: tools.length ? 'auto' : undefined,
      temperature: 0.2,
    });

    const usage = response.usage || {};
    this.usageLog.push({
      promptTokens: usage.prompt_tokens || 0,
      outputTokens: usage.completion_tokens || 0,
      totalTokens: usage.total_tokens || 0,
    });

    const message = response.choices[0].message;
    const toolCalls = (message.tool_calls || []).map((tc) => {
      let args = {};
      try {
        args = JSON.parse(tc.function.arguments || '{}');
      } catch {
        args = {};
      }
      return { id: tc.id, name: tc.function.name, args };
    });

    return { content: message.content || null, toolCalls };
  }
}

module.exports = { OpenAIProvider };
