// Model providers: run Claude Code against other models through an Anthropic-compatible endpoint
// (Ollama, LM Studio, LiteLLM, OpenRouter, or anything custom). Claude Code reads
// ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL; API keys live in VS Code's
// SecretStorage, never in files.
import type * as vscode from 'vscode';

export interface Provider {
  id: string;
  name: string;
  preset: PresetId;
  baseUrl: string;
  model: string;
  /** whether a key is stored in SecretStorage under secretKey(id) */
  hasKey: boolean;
}

export type PresetId = 'ollama' | 'lmstudio' | 'litellm' | 'openrouter' | 'custom';

export interface Preset {
  id: PresetId;
  label: string;
  detail: string;
  baseUrl: string;
  /** fixed token for local servers that require one but ignore it */
  localToken?: string;
  needsKey: boolean;
  /** how to list models: Ollama's /api/tags or OpenAI-style /v1/models */
  list?: 'ollama' | 'openai';
}

export const PRESETS: Preset[] = [
  { id: 'ollama', label: 'Ollama (local)', detail: 'Llama, Qwen, Gemma, DeepSeek… on this machine (Ollama 0.14+)', baseUrl: 'http://localhost:11434', localToken: 'ollama', needsKey: false, list: 'ollama' },
  { id: 'lmstudio', label: 'LM Studio (local)', detail: 'Models loaded in LM Studio', baseUrl: 'http://localhost:1234', localToken: 'lmstudio', needsKey: false, list: 'openai' },
  { id: 'litellm', label: 'LiteLLM proxy', detail: 'Any model behind your LiteLLM gateway', baseUrl: 'http://localhost:4000', needsKey: true, list: 'openai' },
  { id: 'openrouter', label: 'OpenRouter', detail: 'GPT, Gemini, Llama, Qwen, DeepSeek and more with one key', baseUrl: 'https://openrouter.ai/api', needsKey: true },
  { id: 'custom', label: 'Custom (Anthropic-compatible)', detail: 'Any endpoint that speaks the Anthropic Messages API', baseUrl: '', needsKey: true },
];

export const secretKey = (id: string) => `agentlens.provider.${id}`;

/** Environment that points Claude Code at the provider. */
export function providerEnv(p: Provider, key: string | undefined): Record<string, string> {
  const preset = PRESETS.find((x) => x.id === p.preset);
  const token = key ?? preset?.localToken ?? '';
  return {
    ANTHROPIC_BASE_URL: p.baseUrl.replace(/\/+$/, ''),
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_API_KEY: '', // don't fall back to an Anthropic key
    ANTHROPIC_MODEL: p.model,
    // every model slot uses the provider's model, so nothing silently calls Anthropic
    ANTHROPIC_DEFAULT_OPUS_MODEL: p.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: p.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: p.model,
    CLAUDE_CODE_SUBAGENT_MODEL: p.model,
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
  };
}

/** Models the provider offers (local servers and gateways can list them). */
export async function listModels(preset: Preset, baseUrl: string, key?: string): Promise<string[]> {
  if (!preset.list) return [];
  const url = baseUrl.replace(/\/+$/, '') + (preset.list === 'ollama' ? '/api/tags' : '/v1/models');
  const res = await fetch(url, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const body: any = await res.json();
  const names: string[] = preset.list === 'ollama' ? (body.models ?? []).map((m: any) => m.name ?? m.model) : (body.data ?? []).map((m: any) => m.id);
  return names.filter(Boolean).sort();
}

/** Provider of a model id, for icons and labels. */
export type Vendor = 'anthropic' | 'openai' | 'google' | 'meta' | 'qwen' | 'deepseek' | 'mistral' | 'xai' | 'other';
export function vendorOf(model?: string): Vendor {
  const m = (model ?? '').toLowerCase();
  if (/claude|opus|sonnet|haiku|fable|mythos/.test(m)) return 'anthropic';
  if (/gpt|o1|o3|o4|codex|openai/.test(m)) return 'openai';
  if (/gemini|gemma|google/.test(m)) return 'google';
  if (/llama|meta/.test(m)) return 'meta';
  if (/qwen/.test(m)) return 'qwen';
  if (/deepseek/.test(m)) return 'deepseek';
  if (/mistral|mixtral|codestral|devstral/.test(m)) return 'mistral';
  if (/grok|xai/.test(m)) return 'xai';
  return 'other';
}

export type SecretStore = Pick<vscode.SecretStorage, 'get' | 'store' | 'delete'>;
