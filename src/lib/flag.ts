const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export function generateFlag(length = 12): string {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	let flag = "";
	for (let i = 0; i < length; i++) {
		flag += ALPHABET[bytes[i] % ALPHABET.length];
	}
	return flag;
}