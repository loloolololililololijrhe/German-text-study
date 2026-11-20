// Asking Claude to write a reading text. The request goes straight from the
// browser to the Claude API using the learner's own key.

import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT, TEXT_SCHEMA } from './lib/prompt.js';
import { MODELS } from './lib/models.js';

export class GenerationError extends Error {
  constructor(message, { aborted = false } = {}) {
    super(message);
    this.aborted = aborted;
  }
}

/** The tokens a finished request used. */
function usageOf(message) {
  const u = message.usage || {};
  return {
    inTok: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
    outTok: u.output_tokens || 0,
  };
}

/**
 * Send one request whose answer must follow `schema`, and return the finished
 * message. `onText` receives the answer piece by piece as it arrives.
 */
async function ask({ apiKey, model, system, prompt, schema, effort, maxTokens, onText, signal }) {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const params = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: prompt }],
    // The schema guarantees parseable output.
    output_config: { effort, format: { type: 'json_schema', schema } },
  };

  // If a safety classifier declines the request, let the API retry it on the
  // fallback model it recommends instead of failing. Haiku has no fallback.
  const useFallback = MODELS.find((m) => m.id === model)?.fallback;
  const stream = useFallback
    ? client.beta.messages.stream(
        { ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' },
        { signal },
      )
    : client.messages.stream(params, { signal });
  if (onText) stream.on('text', onText);
  try {
    return await stream.finalMessage();
  } catch (err) {
    throw explain(err);
  }
}

/**
 * Stream one reading text. `onText` receives each piece of the JSON document as
 * it arrives. Resolves when the text is complete, with the tokens the request
 * used ({ inTok, outTok }); rejects with GenerationError.
 */
export async function generateText({ apiKey, model, prompt, onText, signal }) {
  // A short text at a known level needs little deliberation, and the learner
  // is waiting, so keep thinking brief.
  const message = await ask({
    apiKey,
    model,
    system: SYSTEM_PROMPT,
    prompt,
    schema: TEXT_SCHEMA,
    effort: 'low',
    maxTokens: 32000,
    onText,
    signal,
  });
  if (message.stop_reason === 'refusal') {
    throw new GenerationError('Claude declined to write this text. Try a different topic.');
  }
  if (message.stop_reason === 'max_tokens') {
    throw new GenerationError('The text was cut off before it finished. Try a shorter length.');
  }
  return usageOf(message);
}

/**
 * Ask for an answer in the shape of `schema` and return it parsed, with the
 * tokens used: { answer, inTok, outTok }. Rejects with GenerationError.
 */
export async function askJson({ apiKey, model, system, prompt, schema, signal }) {
  // Weighing a learner's numbers deserves more thought than writing a short text.
  const message = await ask({ apiKey, model, system, prompt, schema, effort: 'medium', maxTokens: 16000, signal });
  if (message.stop_reason === 'refusal') throw new GenerationError('Claude declined to answer this request.');
  if (message.stop_reason === 'max_tokens') throw new GenerationError('Claude’s answer was cut off. Please try again.');
  const text = (message.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  try {
    return { answer: JSON.parse(text), ...usageOf(message) };
  } catch {
    throw new GenerationError('Claude’s answer could not be read. Please try again.');
  }
}

function explain(err) {
  if (err instanceof Anthropic.APIUserAbortError) return new GenerationError('Cancelled.', { aborted: true });
  if (err instanceof Anthropic.AuthenticationError) {
    return new GenerationError('Claude rejected the API key. Check it in Settings.');
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new GenerationError(
      'This API key is not allowed to use the selected model. Pick another model in Settings.',
    );
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new GenerationError('The selected model is not available for this API key. Pick another model in Settings.');
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new GenerationError('Claude is rate-limiting this key. Wait a minute and try again.');
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new GenerationError('Could not reach Claude. Check your internet connection and try again.');
  }
  if (err instanceof Anthropic.APIError) {
    const detail = err.error?.error?.message || err.message;
    return new GenerationError(`Claude returned an error (${err.status ?? 'unknown'}): ${detail}`);
  }
  return new GenerationError(err?.message || 'Something went wrong while writing the text.');
}
