interface SiteverifyResult {
	success: boolean;
	"error-codes"?: string[];
	hostname?: string;
	action?: string;
}

export async function verifyTurnstile(secret: string, token: string, remoteip: string | null): Promise<SiteverifyResult> {
	if (!token) return { success: false, "error-codes": ["missing-input-response"] };
	const body: Record<string, string> = { secret, response: token };
	if (remoteip) body.remoteip = remoteip;
	const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(body).toString(),
	});
	const data = (await res.json()) as SiteverifyResult;
	return data;
}