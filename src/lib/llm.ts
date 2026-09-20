export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface LlmConfig {
	baseUrl?: string;
	apiKey?: string;
	cfAccountId?: string;
	cfApiToken?: string;
	model: string;
	maxTokens: number;
	timeoutMs: number;
	minIntervalMs: number;
	maxRetries: number;
}

export interface LlmEnvLike {
	AI_BASE_URL?: string;
	AI_API_KEY?: string;
	CF_ACCOUNT_ID?: string;
	CF_API_TOKEN?: string;
	AI_MODEL?: string;
	AI_MAX_TOKENS?: number;
	AI_TIMEOUT_MS?: number;
	AI_MIN_INTERVAL_MS?: number;
}

export function resolveLlmConfig(env: LlmEnvLike): LlmConfig {
	const base = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d);
	if (env.AI_BASE_URL && env.AI_API_KEY) {
		return {
			baseUrl: env.AI_BASE_URL.replace(/\/+$/, ""),
			apiKey: env.AI_API_KEY,
			model: env.AI_MODEL || "gpt-4o-mini",
			maxTokens: base(env.AI_MAX_TOKENS, 1024),
			timeoutMs: base(env.AI_TIMEOUT_MS, 90_000),
			minIntervalMs: base(env.AI_MIN_INTERVAL_MS, 3_000),
			maxRetries: 2,
		};
	}
	if (env.CF_ACCOUNT_ID && env.CF_API_TOKEN) {
		return {
			baseUrl: `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/v1`,
			apiKey: env.CF_API_TOKEN,
			model: env.AI_MODEL || "@cf/meta/llama-3.3-70b-instruct",
			maxTokens: base(env.AI_MAX_TOKENS, 1024),
			timeoutMs: base(env.AI_TIMEOUT_MS, 90_000),
			minIntervalMs: base(env.AI_MIN_INTERVAL_MS, 3_000),
			maxRetries: 2,
		};
	}
	throw new LlmError("No LLM provider configured: set AI_BASE_URL+AI_API_KEY or CF_ACCOUNT_ID+CF_API_TOKEN.", "config");
}

export class LlmError extends Error {
	constructor(
		message: string,
		public kind: "timeout" | "rate" | "http" | "empty" | "config" | "aborted",
	) {
		super(message);
	}
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class ModelCooldown {
	private lastCallAt = new Map<string, number>();
	constructor(private minIntervalMs: number) {}
	async wait(model: string): Promise<void> {
		const now = Date.now();
		const last = this.lastCallAt.get(model) ?? 0;
		const delay = last + this.minIntervalMs - now;
		if (delay > 0) await sleep(delay);
		this.lastCallAt.set(model, now + Math.max(delay, 0));
	}
}

const cooldowns = new WeakMap<LlmConfig, ModelCooldown>();

function cooldownFor(cfg: LlmConfig): ModelCooldown {
	let c = cooldowns.get(cfg);
	if (!c) {
		c = new ModelCooldown(cfg.minIntervalMs);
		cooldowns.set(cfg, c);
	}
	return c;
}

export interface ChatOptions {
	model?: string;
	temperature?: number;
	maxTokens?: number;
}

export async function chat(env: LlmEnvLike, messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
	const cfg = resolveLlmConfig(env);
	const model = opts.model || cfg.model;
	const cooldown = cooldownFor(cfg);

	let lastError: unknown;
	for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
		await cooldown.wait(model);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
		try {
			const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${cfg.apiKey}`,
				},
				body: JSON.stringify({
					model,
					messages,
					temperature: opts.temperature ?? 0.7,
					max_tokens: opts.maxTokens ?? cfg.maxTokens,
					stream: false,
				}),
				signal: controller.signal,
			});
			if (res.status === 429 || res.status >= 500) {
				lastError = new LlmError(`HTTP ${res.status} from provider`, "rate");
				if (attempt < cfg.maxRetries) {
					await sleep((attempt + 1) * cfg.minIntervalMs);
					continue;
				}
				throw lastError;
			}
			if (!res.ok) {
				const text = await res.text().catch(() => "");
				throw new LlmError(`Provider returned HTTP ${res.status}: ${text.slice(0, 300)}`, "http");
			}
			const data = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
			const content = data.choices?.[0]?.message?.content;
			if (typeof content === "string") return content;
			throw new LlmError("Provider returned no text content.", "empty");
		} catch (e) {
			console.log("Error with chat() " + e);
			if (controller.signal.aborted) {
				throw new LlmError("LLM call timed out.", "timeout");
			}
			if (e instanceof LlmError) throw e;
			lastError = e;
			if (attempt < cfg.maxRetries) {
				await sleep((attempt + 1) * cfg.minIntervalMs);
				continue;
			}
			throw lastError;
		} finally {
			clearTimeout(timer);
		}
	}
	throw lastError;
}