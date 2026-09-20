export interface PromptItem {
	text: string;
	meta: boolean;
}

export interface ValidationResult<T> {
	ok: boolean;
	value?: T;
	error?: string;
}

const CONTROL_AND_HTML = /[<>&\x00-\x1f\x7f]/;

const PROFANITY: string[] = [
	"fuck",
	"shit",
	"cunt",
	"faggot",
	"nigger",
	"nigga",
	"bitch",
	"whore",
	"slut",
	"dick",
	"pussy",
	"asshole",
	"bastard",
	"cock",
	"douche",
];

function normalizeForProfanity(s: string): string {
	return s
		.toLowerCase()
		.replace(/[0@]/g, "a")
		.replace(/[1!|]/g, "i")
		.replace(/[3]/g, "e")
		.replace(/[4]/g, "a")
		.replace(/[5$]/g, "s")
		.replace(/[7]/g, "t")
		.replace(/\s+/g, " ");
}

function containsProfanity(s: string): boolean {
	const n = normalizeForProfanity(s);
	const tokens = n.split(/[^a-z]+/).filter(Boolean);
	for (const token of tokens) {
		if (PROFANITY.includes(token)) return true;
		for (const bad of PROFANITY) {
			if (token.includes(bad)) return true;
		}
	}
	return false;
}

export function toSlug(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}

export function sanitizeName(name: string, maxLen = 32): ValidationResult<{ name: string; slug: string }> {
	const trimmed = (name || "").trim();
	if (!trimmed) return { ok: false, error: "Warrior name is required." };
	if (trimmed.length > maxLen) return { ok: false, error: `Warrior name must be ${maxLen} characters or fewer.` };
	if (CONTROL_AND_HTML.test(trimmed)) return { ok: false, error: "Warrior names cannot contain HTML or control characters." };
	if (containsProfanity(trimmed)) return { ok: false, error: "Warrior names cannot contain profanity." };
	const slug = toSlug(trimmed);
	if (!slug) return { ok: false, error: "Warrior name must contain letters or digits." };
	return { ok: true, value: { name: trimmed, slug } };
}

export function validatePrompts(
	attack: unknown,
	defense: unknown,
	maxAttack = 8,
	maxLength = 4096,
): ValidationResult<{ attack: PromptItem[]; defense: PromptItem[] }> {
	if (!Array.isArray(defense) || defense.length === 0) {
		return { ok: false, error: "At least one defensive prompt is required." };
	}
	if (!Array.isArray(attack) || attack.length === 0) {
		return { ok: false, error: "At least one attack prompt is required." };
	}
	if (attack.length > maxAttack) {
		return { ok: false, error: `No more than ${maxAttack} attack prompts.` };
	}
	const parse = (items: unknown): PromptItem[] => {
		const out: PromptItem[] = [];
		for (const it of items as { text?: unknown; meta?: unknown }[]) {
			const text = typeof it?.text === "string" ? it.text.trim() : "";
			if (!text) continue;
			if (text.length > maxLength) {
				throw new ValidationFailure(`Prompt exceeds ${maxLength} characters.`);
			}
			out.push({ text, meta: it?.meta === true });
		}
		return out;
	};
	try {
		const a = parse(attack);
		const d = parse(defense);
		if (a.length === 0) return { ok: false, error: "At least one non-empty attack prompt is required." };
		if (d.length === 0) return { ok: false, error: "At least one non-empty defensive prompt is required." };
		for (const item of [...a, ...d]) {
			if (containsProfanity(item.text)) {
				return { ok: false, error: "Prompts cannot contain profanity." };
			}
		}
		return { ok: true, value: { attack: a, defense: d } };
	} catch (e) {
		if (e instanceof ValidationFailure) return { ok: false, error: e.message };
		throw e;
	}
}

export function validatePassword(password: unknown): ValidationResult<string> {
	const p = typeof password === "string" ? password : "";
	if (p.length < 8) return { ok: false, error: "A password of at least 8 characters is required." };
	if (p.length > 256) return { ok: false, error: "Password too long." };
	return { ok: true, value: p };
}

export function validateModel(model: unknown, allowlist: string[]): ValidationResult<string | null> {
	if (model == null || (typeof model === "string" && model.trim() === "")) return { ok: true, value: null };
	if (typeof model !== "string") return { ok: false, error: "Invalid model." };
	const value = model.trim();
	if (allowlist.length === 0) {
		return { ok: false, error: "Model overrides are disabled; only the league default model is allowed." };
	}
	if (!allowlist.includes(value)) {
		return { ok: false, error: `Model not in the approved list. Allowed: ${allowlist.map((m) => `\`${m}\``).join(", ")}.` };
	}
	return { ok: true, value };
}

export function parseModelAllowlist(raw: unknown): string[] {
	if (typeof raw !== "string" || !raw.trim()) return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((m): m is string => typeof m === "string") : [];
	} catch {
		return [];
	}
}

class ValidationFailure extends Error {}