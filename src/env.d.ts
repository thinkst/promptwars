/**
 * Secrets set via `wrangler secret put` are not known to `wrangler types`.
 * These declarations merge into the generated global `Env` interface.
 */
interface Env {
	AI_BASE_URL?: string;
	AI_API_KEY?: string;
	CF_ACCOUNT_ID?: string;
	CF_API_TOKEN?: string;
	TURNSTILE_SECRET?: string;
	DEV_API_KEY?: string;
}