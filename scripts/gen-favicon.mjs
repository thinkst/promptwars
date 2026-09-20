/**
 * Generates public/favicon.ico (16x16, 32-bit BGRA BMP-in-ICO).
 * Pixel-art pennant: pole + waving flag in the app's palette.
 * Run: node scripts/gen-favicon.mjs
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 16;
const COLORS = {
	" ": [0, 0, 0, 0], // transparent
	F: [87, 255, 196, 255], // accent
	"|": [232, 237, 243, 255], // pole
	o: [97, 176, 255, 255], // accent2
	b: [43, 54, 66, 255], // base
};

const ART = [
	"....FFFF|.......",
	"....FFFF|o......",
	"....FFFF|.......",
	"....FFFF|o......",
	"....FFFF|.......",
	"....FFFF|.......",
	"....FFFF|.......",
	"....FFFFFFFFFF F",
	"........|.......",
	"........|.......",
	"........|.......",
	"........|.......",
	"........|.......",
	"........|.......",
	"........|.......",
	"........bbb.....",
];

const frame = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
	for (let x = 0; x < SIZE; x++) {
		const ch = (ART[y] ?? "").charAt(x) || " ";
		const c = COLORS[ch] ?? COLORS[" "];
		const i = (y * SIZE + x) * 4;
		frame[i] = c[0];
		frame[i + 1] = c[1];
		frame[i + 2] = c[2];
		frame[i + 3] = c[3];
	}
}

function makeIco(width, height, rgba) {
	const infoSize = 40;
	const rowSize = width * 4;
	const pixelSize = rowSize * height;
	const andRowBytes = ((width + 31) >> 5) * 4;
	const andSize = andRowBytes * height;
	const imageSize = infoSize + pixelSize + andSize;
	const buffer = Buffer.alloc(6 + 16 + imageSize);
	let o = 0;
	buffer.writeUInt16LE(0, o); o += 2; // reserved
	buffer.writeUInt16LE(1, o); o += 2; // type: icon
	buffer.writeUInt16LE(1, o); o += 2; // image count
	buffer[o++] = width; // width
	buffer[o++] = height; // height
	buffer[o++] = 0; // palette
	buffer[o++] = 0; // reserved
	buffer.writeUInt16LE(1, o); o += 2; // planes
	buffer.writeUInt16LE(32, o); o += 2; // bit depth
	buffer.writeUInt32LE(imageSize, o); o += 4;
	buffer.writeUInt32LE(6 + 16, o); o += 4; // data offset
	// BITMAPINFOHEADER
	buffer.writeUInt32LE(infoSize, o); o += 4;
	buffer.writeInt32LE(width, o); o += 4;
	buffer.writeInt32LE(height * 2, o); o += 4; // includes AND mask
	buffer.writeUInt16LE(1, o); o += 2;
	buffer.writeUInt16LE(32, o); o += 2;
	buffer.writeUInt32LE(0, o); o += 4; // BI_RGB
	buffer.writeUInt32LE(pixelSize, o); o += 4;
	buffer.writeInt32LE(0, o); o += 4;
	buffer.writeInt32LE(0, o); o += 4;
	buffer.writeUInt32LE(0, o); o += 4;
	buffer.writeUInt32LE(0, o); o += 4;
	// bottom-up scanlines
	for (let y = height - 1; y >= 0; y--) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4;
			buffer[o++] = rgba[i + 2]; // B
			buffer[o++] = rgba[i + 1]; // G
			buffer[o++] = rgba[i + 0]; // R
			buffer[o++] = rgba[i + 3]; // A
		}
	}
	for (let y = 0; y < height; y++) {
		buffer.fill(0, o, o + andRowBytes);
		o += andRowBytes;
	}
	return buffer;
}

const here = resolve(fileURLToPath(import.meta.url), "..", "..");
writeFileSync(resolve(here, "public/favicon.ico"), makeIco(SIZE, SIZE, frame));
console.log("wrote public/favicon.ico");