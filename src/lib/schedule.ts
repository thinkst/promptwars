import type { Warrior } from "./types";

export interface SchedulerConfig {
	evictAfter: number;
	podTop: number;
	gamesPerCycle: number;
	eloBand: number;
}

export interface CyclePlan {
	pairs: [string, string][];
	podPairs: [string, string][];
	newEvicted: string[];
	active: Warrior[];
	activeCount: number;
}

function shuffle<T>(arr: T[]): T[] {
	const a = arr.slice();
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

function pairKey(a: string, b: string): string {
	return a < b ? `${a}||${b}` : `${b}||${a}`;
}

/**
 * Picks `count` opponents spread evenly across the Elo range (bottom, middle,
 * top) so a fresh warrior gets a well-calibrated first batch of battles.
 */
export function stratifiedOpponents(active: Warrior[], count: number): string[] {
	const sorted = [...active].sort((a, b) => a.elo - b.elo);
	if (sorted.length === 0 || count < 1) return [];
	if (count >= sorted.length) return sorted.map((w) => w.name);
	const out: string[] = [];
	const step = sorted.length / count;
	for (let i = 0; i < count; i++) {
		const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(i * step + step / 2 - 0.5)));
		if (!out.includes(sorted[idx].name)) out.push(sorted[idx].name);
	}
	return out;
}

export function checkEvictions(warriors: Warrior[], evictAfter: number): { active: Warrior[]; newEvicted: string[] } {
	const newEvicted: string[] = [];
	const active: Warrior[] = [];
	for (const w of warriors) {
		if (w.active !== 1) continue;
		if (w.vet_failed) continue;
		if (w.evicted || w.streak_loses >= evictAfter) {
			if (!w.evicted && w.streak_loses >= evictAfter) {
				w.evicted = 1;
				newEvicted.push(w.name);
			}
			continue;
		}
		active.push(w);
	}
	return { newEvicted, active };
}

export function planCycle(warriors: Warrior[], cfg: SchedulerConfig): CyclePlan {
	const { active, newEvicted } = checkEvictions(warriors, cfg.evictAfter);
	if (active.length < 2) {
		return { pairs: [], podPairs: [], newEvicted, active, activeCount: active.length };
	}

	const sorted = [...active].sort((a, b) => b.elo - a.elo);
	const pod = sorted.slice(0, cfg.podTop);
	const rest = sorted.slice(cfg.podTop);

	const podPairs: [string, string][] = [];
	for (let i = 0; i < pod.length; i++) {
		for (let j = i + 1; j < pod.length; j++) {
			podPairs.push([pod[i].name, pod[j].name]);
		}
	}

	const seen = new Set<string>();
	const pairs: [string, string][] = [];
	const addPair = (a: string, b: string) => {
		if (a === b) return;
		const k = pairKey(a, b);
		if (seen.has(k)) return;
		seen.add(k);
		pairs.push([a, b]);
	};

	const band = cfg.eloBand;

	const pickOpponents = (w: Warrior, pool: Warrior[], count: number): Warrior[] => {
		const candidates = pool.filter((o) => o.name !== w.name);
		return shuffle(candidates).slice(0, count);
	};

	const targets = sorted.length > cfg.podTop ? rest : [];
	for (const w of [...pod, ...rest]) {
		const higher = targets.filter((o) => o.elo - w.elo > band);
		const similar = targets.filter((o) => Math.abs(o.elo - w.elo) <= band);
		const lower = targets.filter((o) => w.elo - o.elo > band);

		const g = cfg.gamesPerCycle;
		const hiCount = Math.ceil(g / 3);
		const loCount = Math.max(1, Math.floor(g / 6));
		const simCount = Math.max(0, g - hiCount - loCount);

		for (const o of pickOpponents(w, higher, hiCount)) addPair(w.name, o.name);
		for (const o of pickOpponents(w, similar, simCount)) addPair(w.name, o.name);
		for (const o of pickOpponents(w, lower, loCount)) addPair(w.name, o.name);
	}

	return { pairs, podPairs, newEvicted, active, activeCount: active.length };
}