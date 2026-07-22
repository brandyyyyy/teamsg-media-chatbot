'use strict';

/**
 * Uniform contract every LLM backend (OpenAI, Gemini, ...) must implement.
 * aiEngine.js only ever talks to this interface via a neutral "turns" log,
 * so adding a third provider later means writing one new file here - the
 * tool-calling loop, grounding rules, and REST/UI layers never change.
 */
class BaseLLMProvider {
  constructor({ providerId, providerLabel }) {
    if (new.target === BaseLLMProvider) {
      throw new Error('BaseLLMProvider is abstract and cannot be instantiated directly');
    }
    if (!providerId || !providerLabel) {
      throw new Error('BaseLLMProvider requires both providerId and providerLabel');
    }
    this.providerId = providerId;
    this.providerLabel = providerLabel;
  }

  /**
   * Run one model turn.
   *
   * @param {object} params
   * @param {string} params.systemPrompt
   * @param {Array<Turn>} params.turns - neutral conversation log, oldest first:
   *   { role: 'user', content: string }
   *   { role: 'assistant', content: string|null, toolCalls?: [{id, name, args}] }
   *   { role: 'tool', toolCallId: string, toolName: string, result: any }
   * @param {Array<{name: string, description: string, parameters: object}>} params.tools
   *   parameters is a plain JSON Schema object (already used as OpenAI's
   *   `parameters` field and as Gemini's `parametersJsonSchema` field).
   * @returns {Promise<{content: string|null, toolCalls: Array<{id: string, name: string, args: object}>}>}
   */
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  async converse({ systemPrompt, turns, tools }) {
    throw new Error(`${this.constructor.name} must implement converse()`);
  }
}

module.exports = { BaseLLMProvider };
