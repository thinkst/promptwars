import type { PromptItem } from "./validate";

export type { PromptItem };

export type RoundStatus = "revealed" | "defended" | "refused" | "error";

export interface RoundResult {
	attacker: string;
	defender: string;
	flag: string;
	attackText: string;
	defenseText: string;
	output: string;
	status: RoundStatus;
	latencyMs: number;
	model: string;
	metaLogs: { source: string; generated: string }[];
}

export interface HistoryEntry {
	attackText: string;
	output: string;
	createdAt: number;
}

export interface Warrior {
	name: string;
	slug: string;
	password_hash: string | null;
	attack: PromptItem[];
	defense: PromptItem[];
	model: string | null;
	elo: number;
	games: number;
	wins: number;
	losses: number;
	attack_wins: number;
	attack_losses: number;
	defense_wins: number;
	defense_losses: number;
	streak_loses: number;
	evicted: number;
	vet_failed: number;
	vet_checked_at: number | null;
	active: number;
	created_at: number;
	updated_at: number;
	last_battle_at: number | null;
}

export interface BattleRow {
	id: number;
	battle_key: string;
	cycle_id: number;
	warrior_a: string;
	warrior_b: string;
	status: string;
	priority: number;
	created_at: number;
	completed_at: number | null;
}

export interface PendingRow {
	battle_key: string;
	attempts: number;
	created_at: number;
}

export interface RoundRow {
	id: number;
	battle_id: number;
	round_no: number;
	attacker: string;
	defender: string;
	flag: string;
	attack_text: string;
	defense_text: string;
	output: string;
	status: RoundStatus;
	latency_ms: number;
	model: string;
	created_at: number;
}

export interface MetaLogRow {
	id: number;
	round_id: number;
	source: string;
	generated: string;
}