// Anthropic API list prices (USD per million tokens), used to show the API-equivalent value of
// usage. With a Claude subscription the user doesn't pay these; they show what it would cost.
// Cache writes are billed at 1.25× input (5-minute cache), cache reads at 0.1× input unless listed.
export interface Price {
  input: number;
  output: number;
  cacheRead?: number;
}

const TABLE: [RegExp, Price][] = [
  [/fable-5-1|mythos-5-1/, { input: 10, output: 50 }],
  [/fable-5|mythos-5/, { input: 10, output: 50, cacheRead: 0.25 }],
  [/opus-5-5/, { input: 4, output: 20, cacheRead: 0.2 }],
  [/opus-5|opus-4-8|opus-4-7|opus-4-6|opus-4-5/, { input: 5, output: 25 }],
  [/opus-4/, { input: 15, output: 75 }],
  [/sonnet-5-5|sonnet-5/, { input: 2, output: 10, cacheRead: 0.2 }],
  [/sonnet-4|sonnet-3/, { input: 3, output: 15 }],
  [/haiku-5-5/, { input: 0.1, output: 0.5 }],
  [/haiku-4-5/, { input: 1, output: 5 }],
  [/haiku-3-5/, { input: 0.8, output: 4 }],
  [/haiku/, { input: 0.25, output: 1.25 }],
];

export function priceOf(model: string): Price | undefined {
  const m = model.toLowerCase();
  return TABLE.find(([re]) => re.test(m))?.[1];
}

export interface Tokens {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** API-equivalent cost in USD; undefined when the model has no known price. */
export function costOf(model: string, t: Tokens): number | undefined {
  const p = priceOf(model);
  if (!p) return undefined;
  const M = 1_000_000;
  return (t.input * p.input + t.output * p.output + t.cacheWrite * p.input * 1.25 + t.cacheRead * (p.cacheRead ?? p.input * 0.1)) / M;
}

/** Friendly model name: claude-opus-5-5 → Opus 5.5 */
export function modelLabel(model: string): string {
  const m = /(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?/i.exec(model);
  if (!m) return model;
  const name = m[1][0].toUpperCase() + m[1].slice(1);
  return `${name} ${m[2]}${m[3] && m[3].length <= 2 ? '.' + m[3] : ''}`;
}
