import { HttpError, GameHall } from "./lib/gamehall";
import { runRound } from "./lib/battle";
import { generateFlag } from "./lib/flag";
import { verifyTurnstile } from "./lib/turnstile";
import { parseModelAllowlist, sanitizeName, validateModel, validatePassword, validatePrompts } from "./lib/validate";
import type { PromptItem } from "./lib/validate";

export { GameHall };

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8" },
	});

function gameHall(env: Env): DurableObjectStub<GameHall> {
	return env.GAME_HALL.get(env.GAME_HALL.idFromName("global"));
}

async function readJson<T>(request: Request): Promise<T> {
	try {
		return (await request.json()) as T;
	} catch {
		throw new HttpError(400, "Invalid JSON body.");
	}
}

function authDevKey(request: Request, env: Env): boolean {
	const header = request.headers.get("authorization") || "";
	const key = (header.startsWith("Bearer ") ? header.slice(7) : "") || request.headers.get("x-dev-key") || "";
	return env.DEV_API_KEY !== undefined && key === env.DEV_API_KEY;
}

function errStatus(e: unknown): number | null {
	if (e instanceof HttpError) return e.status;
	if (typeof e === "object" && e !== null) {
		const anyE = e as { status?: unknown; cause?: unknown };
		if (typeof anyE.status === "number") return anyE.status;
		if (typeof anyE.cause === "object" && anyE.cause !== null && typeof (anyE.cause as { status?: unknown }).status === "number") {
			return (anyE.cause as { status: number }).status;
		}
	}
	return null;
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
	const { pathname, searchParams } = url;

	if (request.method === "GET" && pathname === "/api/config") {
		return json({
			turnstile_site_key: env.TURNSTILE_SITE_KEY,
			model: env.AI_MODEL,
			model_allowlist: parseModelAllowlist(env.MODEL_ALLOWLIST),
		});
	}

	if (request.method === "GET" && pathname === "/api/leaderboard") {
		return json(await gameHall(env).leaderboard());
	}

	if (request.method === "GET" && pathname === "/api/history") {
		const limit = Number(searchParams.get("limit") || "50");
		return json(await gameHall(env).history(Number.isFinite(limit) ? limit : 50));
	}

	if (request.method === "GET" && pathname === "/api/state") {
		return json(await gameHall(env).state());
	}

	if (request.method === "POST" && pathname === "/api/train") {
		const body = await readJson<{
			defense?: unknown;
			attack?: unknown;
			"cf-turnstile-response"?: unknown;
		}>(request);
		if (!env.TURNSTILE_SECRET) return json({ error: "Turnstile is not configured on the server." }, 503);
		const ts = await verifyTurnstile(env.TURNSTILE_SECRET, String(body["cf-turnstile-response"] ?? ""), request.headers.get("CF-Connecting-IP"));
		if (!ts.success) return json({ error: "Human verification failed. Please try again." }, 400);

		const toItems = (v: unknown): PromptItem[] => {
			if (typeof v === "string" && v.trim()) return [{ text: v.trim(), meta: false }];
			if (Array.isArray(v)) return v.filter((x): x is { text?: unknown } => typeof x === "object" && x !== null).map((x) => ({ text: String(x.text ?? ""), meta: false }));
			return [];
		};
		const prompts = validatePrompts(toItems(body.attack), toItems(body.defense), 1, env.MAX_PROMPT_LENGTH ?? 4096);
		if (!prompts.ok || !prompts.value) return json({ error: prompts.error }, 400);

		const flag = generateFlag();
		const result = await runRound(
			env,
			"You",
			"Referee",
			prompts.value.attack,
			prompts.value.defense,
			flag,
			env.AI_MODEL,
			[],
		);
		return json({
			flag,
			output: result.output,
			status: result.status,
			won: result.status === "revealed",
			latency_ms: result.latencyMs,
			model: result.model,
		});
	}

	const warriorMatch = pathname.match(/^\/api\/warriors\/([^/]+)$/);
	if (request.method === "GET" && warriorMatch) {
		return json(await gameHall(env).warrior(decodeURIComponent(warriorMatch[1])));
	}

	const unlockMatch = pathname.match(/^\/api\/warriors\/([^/]+)\/unlock$/);
	if (request.method === "POST" && unlockMatch) {
		const body = await readJson<{ password?: unknown }>(request);
		const password = typeof body.password === "string" ? body.password : "";
		return json(await gameHall(env).unlockWarrior(decodeURIComponent(unlockMatch[1]), password));
	}

	if (request.method === "POST" && pathname === "/api/warriors") {
		const body = await readJson<{
			name?: unknown;
			password?: unknown;
			attack?: unknown;
			defense?: unknown;
			model?: unknown;
			"cf-turnstile-response"?: unknown;
		}>(request);

		const passwordRes = validatePassword(body.password);
		if (!passwordRes.ok || !passwordRes.value) return json({ error: passwordRes.error }, 400);

		const nameRes = sanitizeName(String(body.name ?? ""), env.MAX_WARRIOR_NAME_LENGTH ?? 32);
		if (!nameRes.ok || !nameRes.value) return json({ error: nameRes.error }, 400);

		const promptsRes = validatePrompts(
			body.attack,
			body.defense,
			env.MAX_ATTACK_PROMPTS ?? 8,
			env.MAX_PROMPT_LENGTH ?? 4096,
		);
		if (!promptsRes.ok || !promptsRes.value) return json({ error: promptsRes.error }, 400);

		const allowlist = parseModelAllowlist(env.MODEL_ALLOWLIST);
		const modelRes = validateModel(body.model, allowlist);
		if (!modelRes.ok) return json({ error: modelRes.error }, 400);

		if (!env.TURNSTILE_SECRET) {
			return json({ error: "Turnstile is not configured on the server." }, 503);
		}
		const remoteip = request.headers.get("CF-Connecting-IP");
		const token = String(body["cf-turnstile-response"] ?? "");
		const ts = await verifyTurnstile(env.TURNSTILE_SECRET, token, remoteip);
		if (!ts.success) {
			return json({ error: "Human verification failed. Please try again.", codes: ts["error-codes"] }, 400);
		}

		const model = modelRes.value ?? null;
		const result = await gameHall(env).upsertWarrior({
			name: nameRes.value.name,
			slug: nameRes.value.slug,
			password: passwordRes.value,
			attack: promptsRes.value.attack as PromptItem[],
			defense: promptsRes.value.defense as PromptItem[],
			model,
		});
		return json({ ok: true, ...result }, result.created ? 201 : 200);
	}

	if (request.method === "POST" && pathname === "/api/dev/runqueue") {
		if (!authDevKey(request, env)) return json({ error: "Forbidden" }, 403);
		const max = Number(searchParams.get("max") || "1");
		return json(await gameHall(env).runqueue(Number.isFinite(max) ? max : 1));
	}

	return json({ error: "Not found" }, 404);
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		try {
			if (url.pathname.startsWith("/api/")) {
				return await handleApi(request, env, url);
			}
			// serve the SPA (index.html and assets)
			return await env.ASSETS.fetch(request);
		} catch (e) {
			const status = errStatus(e);
			if (status !== null) {
				return json({ error: e instanceof Error ? e.message : String(e) }, status);
			}
			console.error("handler error", e);
			return json({ error: "Internal error" }, 500);
		}
	},
} satisfies ExportedHandler<Env>;