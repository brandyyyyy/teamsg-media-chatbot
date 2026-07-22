'use strict';

const { GoogleGenAI } = require('@google/genai');
const { BaseLLMProvider } = require('./baseProvider');

/**
 * FunctionDeclaration.parametersJsonSchema accepts a plain JSON Schema
 * object directly - the same shape already used for OpenAI's `parameters`
 * field, so tool specs defined once in aiEngine.js work for both providers
 * unmodified. (Confirmed against the installed @google/genai type defs.)
 */
function toGeminiTools(tools) {
  if (!tools.length) return undefined;
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parametersJsonSchema: t.parameters,
      })),
    },
  ];
}

/** FunctionResponse.response must be a JSON object; wrap non-object tool results. */
function normalizeToolResponse(result) {
  if (result && typeof result === 'object' && !Array.isArray(result)) return result;
  return { output: result };
}

/**
 * Gemini's Content.role only accepts 'user' or 'model' (no dedicated
 * 'function' role in this SDK version), so function responses are sent
 * back as a 'user' Content whose parts carry functionResponse entries.
 * Consecutive tool turns from one assistant turn are grouped into a single
 * Content, matching how Gemini expects parallel tool-call results.
 */
function toGeminiContents(turns) {
  const contents = [];
  let pendingToolParts = null;

  const flushPendingTools = () => {
    if (pendingToolParts && pendingToolParts.length) {
      contents.push({ role: 'user', parts: pendingToolParts });
    }
    pendingToolParts = null;
  };

  for (const turn of turns) {
    if (turn.role === 'user') {
      flushPendingTools();
      contents.push({ role: 'user', parts: [{ text: turn.content }] });
    } else if (turn.role === 'assistant') {
      flushPendingTools();
      const parts = [];
      if (turn.content) parts.push({ text: turn.content });
      for (const tc of turn.toolCalls || []) {
        const part = { functionCall: { id: tc.id, name: tc.name, args: tc.args || {} } };
        // Gemini requires the exact thoughtSignature from the original
        // functionCall part to be echoed back when replaying it in history,
        // or it rejects the request with "missing thought_signature".
        if (tc.thoughtSignature) part.thoughtSignature = tc.thoughtSignature;
        parts.push(part);
      }
      contents.push({ role: 'model', parts });
    } else if (turn.role === 'tool') {
      if (!pendingToolParts) pendingToolParts = [];
      pendingToolParts.push({
        functionResponse: {
          id: turn.toolCallId,
          name: turn.toolName,
          response: normalizeToolResponse(turn.result),
        },
      });
    }
  }
  flushPendingTools();
  return contents;
}

class GeminiProvider extends BaseLLMProvider {
  constructor({ apiKey, model }) {
    super({ providerId: 'gemini', providerLabel: 'Google Gemini' });
    if (!apiKey) throw new Error('GeminiProvider requires an apiKey');
    this.model = model;
    this.client = new GoogleGenAI({ apiKey });
    // Per-API-call token usage, most recent call last. Read by callers that
    // want to cost out a whole chat() turn (which may span several calls).
    this.usageLog = [];
  }

  async converse({ systemPrompt, turns, tools }) {
    const response = await this.client.models.generateContent({
      model: this.model,
      contents: toGeminiContents(turns),
      config: {
        systemInstruction: systemPrompt,
        tools: toGeminiTools(tools),
        temperature: 0.2,
      },
    });

    const usage = response.usageMetadata || {};
    this.usageLog.push({
      promptTokens: usage.promptTokenCount || 0,
      // Thinking/reasoning tokens are billed as output but not reflected in
      // candidatesTokenCount, so they must be added in separately.
      outputTokens: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0),
      totalTokens: usage.totalTokenCount || 0,
    });

    // Read raw candidate parts (not the response.functionCalls/response.text
    // convenience getters) because thoughtSignature lives as a sibling field
    // on the same Part as functionCall, and the getters don't surface it.
    const candidate = response.candidates && response.candidates[0];
    const parts = (candidate && candidate.content && candidate.content.parts) || [];

    let content = null;
    const toolCalls = [];
    let callIndex = 0;
    for (const part of parts) {
      if (part.text) content = (content || '') + part.text;
      if (part.functionCall) {
        toolCalls.push({
          id: part.functionCall.id || `${part.functionCall.name}_${callIndex}`,
          name: part.functionCall.name,
          args: part.functionCall.args || {},
          thoughtSignature: part.thoughtSignature,
        });
        callIndex += 1;
      }
    }

    return { content, toolCalls };
  }
}

module.exports = { GeminiProvider };
