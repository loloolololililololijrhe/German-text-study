// The Claude models offered in Settings. `fallback` marks models for which the
// API can retry a declined request on another model.

export const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (best writing)', fallback: true },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (faster, cheaper)', fallback: true },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (fastest, cheapest)', fallback: false },
];
