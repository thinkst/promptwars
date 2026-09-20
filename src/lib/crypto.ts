const ITERATIONS = 100_000;
const KEY_LEN = 32; // bytes

function bufToB64(buf: ArrayBuffer): string {
	return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function b64ToBuf(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
	const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
	return crypto.subtle.deriveBits(
		{ name: "PBKDF2", hash: "SHA-256", salt: salt, iterations: iterations },
		material,
		KEY_LEN * 8,
	);
}

export async function hashPassword(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const hash = await deriveKey(password, salt, ITERATIONS);
	return `${ITERATIONS}$${bufToB64(salt.buffer)}$${bufToB64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const parts = stored.split("$");
	if (parts.length !== 3) return false;
	const iterations = parseInt(parts[0], 10);
	if (!iterations) return false;
	const salt = b64ToBuf(parts[1]);
	const expected = b64ToBuf(parts[2]);
	const hash = await deriveKey(password, salt, iterations);
	const actual = new Uint8Array(hash);
	if (actual.length !== expected.length) return false;
	let diff = 0;
	for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
	return diff === 0;
}