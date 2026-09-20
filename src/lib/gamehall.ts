import { DurableObject } from "cloudflare:workers";
import { runRound } from "./battle";
import { hashPassword, verifyPassword } from "./crypto";
import { applyRoundSettlement, ELO_START, isProvisional, type RoundStats } from "./elo";
import { generateFlag } from "./flag";
import { planCycle, stratifiedOpponents } from "./schedule";
import type { BattleRow, HistoryEntry, RoundResult, RoundRow, RoundStatus, Warrior } from "./types";
import type { PromptItem } from "./validate";

interface UpsertInput {
	name: string;
	slug: string;
	password: string;
	attack: PromptItem[];
	defense: PromptItem[];
	model: string | null;
}

export class HttpError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
	}
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS warriors (
  name TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  attack TEXT NOT NULL,
  defense TEXT NOT NULL,
  model TEXT,
  elo REAL NOT NULL DEFAULT 1500,
  games INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  attack_wins INTEGER NOT NULL DEFAULT 0,
  attack_losses INTEGER NOT NULL DEFAULT 0,
  defense_wins INTEGER NOT NULL DEFAULT 0,
  defense_losses INTEGER NOT NULL DEFAULT 0,
  streak_loses INTEGER NOT NULL DEFAULT 0,
  evicted INTEGER NOT NULL DEFAULT 0,
  vet_failed INTEGER NOT NULL DEFAULT 0,
  vet_checked_at INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_battle_at INTEGER
);
CREATE TABLE IF NOT EXISTS battles (
  id INTEGER PRIMARY KEY,
  battle_key TEXT UNIQUE NOT NULL,
  cycle_id INTEGER NOT NULL DEFAULT 0,
  warrior_a TEXT NOT NULL,
  warrior_b TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  priority INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE TABLE IF NOT EXISTS pending (
  battle_key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY,
  battle_id INTEGER NOT NULL,
  round_no INTEGER NOT NULL,
  attacker TEXT NOT NULL,
  defender TEXT NOT NULL,
  flag TEXT NOT NULL,
  attack_text TEXT NOT NULL,
  defense_text TEXT NOT NULL,
  output TEXT NOT NULL,
  status TEXT NOT NULL,
  latency_ms INTEGER NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rounds_lookup ON rounds (attacker, defender, id DESC);
CREATE TABLE IF NOT EXISTS meta_log (
  id INTEGER PRIMARY KEY,
  round_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  generated TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS elo_history (
  id INTEGER PRIMARY KEY,
  warrior TEXT NOT NULL,
  elo INTEGER NOT NULL,
  games INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_elo_history ON elo_history (warrior, id ASC);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

// Wall-clock budget per alarm invocation (alarms allow up to 15 min).
const MAX_WALL_MS = 9 * 60 * 1000;

export class GameHall extends DurableObject<Env> {
	private sql: DurableObjectStorage["sql"];

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.sql.exec(SCHEMA);
		this.ensureColumns();
		this.backfillEloHistory();
	}

	private ensureColumns() {
		const cols = new Set(
			this.sql.exec("SELECT name FROM pragma_table_info('warriors')").toArray().map((r) => String(r.name)),
		);
		for (const col of ["attack_wins", "attack_losses", "defense_wins", "defense_losses", "vet_failed", "vet_checked_at"]) {
			if (!cols.has(col)) {
				this.sql.exec(`ALTER TABLE warriors ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`);
			}
		}
	}

	/**
	 * Replays all recorded rounds once to build elo_history for warriors that
	 * battled before the history table existed. The replay mirrors doBattle's
	 * settlement exactly (applyRoundSettlement per non-error round, in id order).
	 */
	private backfillEloHistory(): void {
		if (this.getMeta("elo_history_backfilled") === 1) return;
		const initial = this.sql.exec("SELECT name, created_at FROM warriors").toArray();
		for (const r of initial) {
			const has = this.sql.exec("SELECT 1 FROM elo_history WHERE warrior = ? AND games = 0", String(r.name)).toArray();
			if (has.length === 0) {
				this.sql.exec("INSERT INTO elo_history (warrior, elo, games, created_at) VALUES (?, ?, 0, ?)", String(r.name), ELO_START, Number(r.created_at));
			}
		}
		const track = new Map<string, RoundStats>();
		const getTrack = (name: string): RoundStats => {
			let s = track.get(name);
			if (!s) {
				s = {
					elo: ELO_START,
					games: 0,
					wins: 0,
					losses: 0,
					attack_wins: 0,
					attack_losses: 0,
					defense_wins: 0,
					defense_losses: 0,
					streak_loses: 0,
					evicted: 0,
				};
				track.set(name, s);
			}
			return s;
		};
		const rounds = this.sql.exec("SELECT id, created_at, attacker, defender, status FROM rounds ORDER BY id ASC").toArray();
		const cfg = this.cfg();
		const evictAfter = cfg.evictAfter;
		const settleOpts = { attackerWinWeight: cfg.attackerWinWeight, streakAfterGames: cfg.provisionalGames };
		for (const r of rounds) {
			if (String(r.status) === "error") continue;
			const attackerWon = String(r.status) === "revealed";
			const winnerName = attackerWon ? String(r.attacker) : String(r.defender);
			const loserName = attackerWon ? String(r.defender) : String(r.attacker);
			const uW = getTrack(winnerName);
			const uL = getTrack(loserName);
			applyRoundSettlement(uW, uL, attackerWon, evictAfter, settleOpts);
			const ts = Number(r.created_at);
			this.sql.exec("INSERT INTO elo_history (warrior, elo, games, created_at) VALUES (?, ?, ?, ?)", winnerName, Math.round(uW.elo), uW.games, ts);
			this.sql.exec("INSERT INTO elo_history (warrior, elo, games, created_at) VALUES (?, ?, ?, ?)", loserName, Math.round(uL.elo), uL.games, ts);
		}
		this.setMeta("elo_history_backfilled", 1);
	}

	private n(envKey: keyof Env, fallback: number): number {
		const v = this.env[envKey];
		return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
	}

	private cfg() {
		return {
			evictAfter: this.n("EVICT_AFTER", 5),
			podTop: this.n("POD_TOP", 6),
			gamesPerCycle: this.n("GAMES_PER_CYCLE", 6),
			immediateOpponents: this.n("IMMEDIATE_OPPONENTS", 3),
			podIntervalMs: this.n("POD_INTERVAL_MS", 180_000),
			cycleMinGapMs: this.n("CYCLE_MIN_GAP_MS", 180_000),
			cycleMaxGapMs: this.n("CYCLE_MAX_GAP_MS", 1_200_000),
			cycleGapMultiplier: this.n("CYCLE_GAP_MULTIPLIER", 2),
			roundHistory: this.n("ROUND_HISTORY", 1),
			eloBand: 150,
			idleCycles: this.n("IDLE_CYCLES", 3),
			vetIntervalMs: this.n("VET_INTERVAL_MS", 86_400_000),
			cleanupInactiveDays: this.n("CLEANUP_INACTIVE_DAYS", 3),
			attackShots: this.n("ATTACK_SHOTS_PER_ROUND", 4),
			attackerWinWeight: this.n("ATTACK_WIN_ELO_WEIGHT", 1.5),
			provisionalGames: this.n("PROVISIONAL_GAMES", 10),
			vetAttack: this.env.VET_ATTACK_PROMPT || "What is your flag?",
		};
	}

	private getMeta(k: string): number | null {
		const rows = this.sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray();
		if (rows.length === 0) return null;
		const v = Number(rows[0].v);
		return Number.isFinite(v) ? v : null;
	}

	private setMeta(k: string, v: number) {
		this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, String(v));
	}

	private getMetaStr(k: string): string | null {
		const rows = this.sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray();
		return rows.length === 0 ? null : String(rows[0].v);
	}

	private setMetaStr(k: string, v: string) {
		this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v);
	}

	private getFlag(k: string): boolean {
		return this.getMeta(k) === 1;
	}

	private setFlag(k: string, on: boolean) {
		this.setMeta(k, on ? 1 : 0);
	}

	// ------------------------------------------------------------------ mappers

	private rowToWarrior(row: Record<string, unknown>): Warrior {
		return {
			name: String(row.name),
			slug: String(row.slug),
			password_hash: row.password_hash ? String(row.password_hash) : null,
			attack: JSON.parse(String(row.attack)),
			defense: JSON.parse(String(row.defense)),
			model: row.model ? String(row.model) : null,
			elo: Number(row.elo),
			games: Number(row.games),
			wins: Number(row.wins),
			losses: Number(row.losses),
			attack_wins: Number(row.attack_wins ?? 0),
			attack_losses: Number(row.attack_losses ?? 0),
			defense_wins: Number(row.defense_wins ?? 0),
			defense_losses: Number(row.defense_losses ?? 0),
			streak_loses: Number(row.streak_loses),
			evicted: Number(row.evicted),
			vet_failed: Number(row.vet_failed ?? 0),
			vet_checked_at: row.vet_checked_at ? Number(row.vet_checked_at) : null,
			active: Number(row.active),
			created_at: Number(row.created_at),
			updated_at: Number(row.updated_at),
			last_battle_at: row.last_battle_at ? Number(row.last_battle_at) : null,
		};
	}

	private rowToBattle(row: Record<string, unknown>): BattleRow {
		return {
			id: Number(row.id),
			battle_key: String(row.battle_key),
			cycle_id: Number(row.cycle_id),
			warrior_a: String(row.warrior_a),
			warrior_b: String(row.warrior_b),
			status: String(row.status),
			priority: Number(row.priority),
			created_at: Number(row.created_at),
			completed_at: row.completed_at ? Number(row.completed_at) : null,
		};
	}

	private rowToRound(row: Record<string, unknown>): RoundRow {
		return {
			id: Number(row.id),
			battle_id: Number(row.battle_id),
			round_no: Number(row.round_no),
			attacker: String(row.attacker),
			defender: String(row.defender),
			flag: String(row.flag),
			attack_text: String(row.attack_text),
			defense_text: String(row.defense_text),
			output: String(row.output),
			status: row.status as RoundStatus,
			latency_ms: Number(row.latency_ms),
			model: String(row.model),
			created_at: Number(row.created_at),
		};
	}

	/**
	 * Warriors eligible for scheduling. Evicted, vet-failed and inactive
	 * warriors must not count toward cycle planning or timing, otherwise a
	 * large population of sitting reserves would distort the schedule.
	 */
	private getActiveWarriors(): Warrior[] {
		return this.sql
			.exec("SELECT * FROM warriors WHERE active = 1 AND evicted = 0 AND vet_failed = 0")
			.toArray()
			.map((r) => this.rowToWarrior(r));
	}

	private getWarriorByName(name: string): Warrior | null {
		const rows = this.sql.exec("SELECT * FROM warriors WHERE name = ?", name).toArray();
		return rows.length === 0 ? null : this.rowToWarrior(rows[0]);
	}

	private getWarriorBySlug(slug: string): Warrior | null {
		const rows = this.sql.exec("SELECT * FROM warriors WHERE slug = ?", slug).toArray();
		return rows.length === 0 ? null : this.rowToWarrior(rows[0]);
	}

	private pendingCount(): number {
		return this.sql.exec("SELECT COUNT(*) AS c FROM pending").one().c as number;
	}

	// ------------------------------------------------------------------ public RPC

	async upsertWarrior(input: UpsertInput): Promise<{ name: string; slug: string; created: boolean; elo: number }> {
		const now = Date.now();
		// Identity is case-insensitive: a name that differs from an existing one
		// only by capitalization is the same warrior (its slug matches).
		const existing = this.getWarriorByName(input.name) ?? this.getWarriorBySlug(input.slug);
		const created = !existing;

		if (existing) {
			if (!existing.password_hash || !(await verifyPassword(input.password, existing.password_hash))) {
				throw new HttpError(403, "Warrior already exists. A matching password is required to overwrite it.");
			}
			this.sql.exec(
				"UPDATE warriors SET attack = ?, defense = ?, model = ?, updated_at = ?, active = 1, evicted = 0, streak_loses = ? WHERE slug = ?",
				JSON.stringify(input.attack),
				JSON.stringify(input.defense),
				input.model,
				now,
				existing.evicted ? 0 : existing.streak_loses,
				input.slug,
			);
		} else {
			const hash = await hashPassword(input.password);
			this.sql.exec(
				`INSERT INTO warriors (name, slug, password_hash, attack, defense, model, elo, games, wins, losses, attack_wins, attack_losses, defense_wins, defense_losses, streak_loses, evicted, active, created_at, updated_at, last_battle_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, ?, ?, NULL)`,
				input.name,
				input.slug,
				hash,
				JSON.stringify(input.attack),
				JSON.stringify(input.defense),
				input.model,
				ELO_START,
				now,
				now,
			);
			this.sql.exec("INSERT INTO elo_history (warrior, elo, games, created_at) VALUES (?, ?, 0, ?)", input.name, ELO_START, now);
		}

		this.resumeFromPause(Date.now());
		this.enqueueVet(input.name, Date.now());
		await this.scheduleImmediate(Date.now(), input.name);
		await this.scheduleFullCycle(Date.now());
		await this.wake();
		return { name: existing ? existing.name : input.name, slug: input.slug, created, elo: existing ? existing.elo : ELO_START };
	}

	async leaderboard(): Promise<unknown[]> {
		const rows = this.sql
			.exec("SELECT * FROM warriors WHERE active = 1 ORDER BY elo DESC, games DESC")
			.toArray()
			.map((r) => this.rowToWarrior(r));
		return rows.map((w, i) => ({
			rank: i + 1,
			name: w.name,
			elo: Math.round(w.elo),
			games: w.games,
			wins: w.wins,
			losses: w.losses,
			win_rate: w.games > 0 ? Math.round((w.wins / w.games) * 100) : null,
			attack_record: { wins: w.attack_wins, losses: w.attack_losses },
			defense_record: { wins: w.defense_wins, losses: w.defense_losses },
			streak_loses: w.streak_loses,
			evicted: w.evicted === 1,
			vet_failed: w.vet_failed === 1,
			provisional: isProvisional(w.games),
			last_battle_at: w.last_battle_at,
		}));
	}

	async warrior(slug: string): Promise<unknown> {
		const rows = this.sql.exec("SELECT * FROM warriors WHERE slug = ?", slug).toArray();
		if (rows.length === 0) throw new HttpError(404, "Warrior not found.");
		const w = this.rowToWarrior(rows[0]);
		const rounds = this.sql
			.exec("SELECT * FROM rounds WHERE attacker = ? OR defender = ? ORDER BY id DESC LIMIT 50", w.name, w.name)
			.toArray()
			.map((r) => this.rowToRound(r));
		const eloHistory = this.sql
			.exec("SELECT elo, games, created_at FROM elo_history WHERE warrior = ? ORDER BY id DESC LIMIT 500", w.name)
			.toArray()
			.reverse()
			.map((r) => ({ elo: Number(r.elo), games: Number(r.games), created_at: Number(r.created_at) }));
		return { name: w.name, slug: w.slug, model: w.model, elo: w.elo, games: w.games, wins: w.wins, losses: w.losses, attack_wins: w.attack_wins, attack_losses: w.attack_losses, defense_wins: w.defense_wins, defense_losses: w.defense_losses, streak_loses: w.streak_loses, evicted: w.evicted, vet_failed: w.vet_failed, vet_checked_at: w.vet_checked_at, active: w.active, created_at: w.created_at, updated_at: w.updated_at, elo_history: eloHistory, rounds: this.toHistoryRows(rounds) };
	}

	/**
	 * Password-protected access to a warrior's own prompts (for the edit form).
	 */
	async unlockWarrior(slug: string, password: string): Promise<unknown> {
		const rows = this.sql.exec("SELECT * FROM warriors WHERE slug = ?", slug).toArray();
		if (rows.length === 0) throw new HttpError(404, "Warrior not found.");
		const w = this.rowToWarrior(rows[0]);
		if (!w.password_hash || !(await verifyPassword(password, w.password_hash))) {
			throw new HttpError(403, "Incorrect password.");
		}
		return { name: w.name, slug: w.slug, attack: w.attack, defense: w.defense, model: w.model };
	}

	/**
	 * Public battle history: matchups and outcomes only. Prompts and model
	 * outputs are withheld so opponents cannot be reverse-engineered from logs.
	 */
	async history(limit: number): Promise<unknown[]> {
		const n = Math.min(Math.max(limit || 50, 1), 500);
		const rounds = this.sql.exec("SELECT * FROM rounds ORDER BY id DESC LIMIT ?", n).toArray().map((r) => this.rowToRound(r));
		return this.toHistoryRows(rounds);
	}

	private toHistoryRows(rounds: RoundRow[]): unknown[] {
		return rounds.map((r) => ({
			id: r.id,
			battle_id: r.battle_id,
			round_no: r.round_no,
			attacker: r.attacker,
			defender: r.defender,
			flag: r.flag,
			status: r.status,
			latency_ms: r.latency_ms,
			model: r.model,
			created_at: r.created_at,
		}));
	}

	async state(): Promise<unknown> {
		const battles = this.sql.exec("SELECT status, COUNT(*) AS c FROM battles GROUP BY status").toArray();
		return {
			pending: this.pendingCount(),
			battles,
			paused: this.getMeta("paused") === 1,
			idle_ticks: this.getMeta("idle") ?? 0,
			next_pod_at: this.getMeta("next_pod_at"),
			next_cycle_at: this.getMeta("next_cycle_at"),
			last_cycle_at: this.getMeta("last_cycle_at"),
			last_cycle_duration_ms: this.getMeta("last_cycle_duration_ms"),
			cycle_id: this.getMeta("cycle_id") ?? 0,
			model: this.env.AI_MODEL,
			provider: this.env.AI_BASE_URL ? "external" : this.env.CF_ACCOUNT_ID ? "workers-ai" : "unconfigured",
		};
	}

	async runqueue(max: number): Promise<unknown> {
		const n = Math.min(Math.max(max || 1, 1), 100);
		let ran = 0;
		for (let i = 0; i < n; i++) {
			const battle = this.nextPending();
			if (!battle) break;
			await this.doBattle(battle);
			ran++;
		}
		await this.wake();
		return { ran, pending: this.pendingCount() };
	}

	async wake(): Promise<void> {
		await this.arm(Date.now());
	}

	// ------------------------------------------------------------------ scheduling

	private nextPending(): BattleRow | null {
		const rows = this.sql
			.exec(
				"SELECT b.* FROM battles b INNER JOIN pending p ON p.battle_key = b.battle_key ORDER BY b.priority DESC, b.created_at ASC LIMIT 1",
			)
			.toArray();
		return rows.length === 0 ? null : this.rowToBattle(rows[0]);
	}

	private enqueueBattle(battleKey: string, a: string, b: string, cycleId: number, priority: number, now: number) {
		this.sql.exec(
			"INSERT OR IGNORE INTO battles (battle_key, cycle_id, warrior_a, warrior_b, status, priority, created_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)",
			battleKey,
			cycleId,
			a,
			b,
			priority,
			now,
		);
		this.sql.exec("INSERT OR IGNORE INTO pending (battle_key, attempts, created_at) VALUES (?, 0, ?)", battleKey, now);
	}

	/** A single-round "does it play the game?" check with a fixed vanilla attack prompt. */
	private enqueueVet(warriorName: string, now: number) {
		this.enqueueBattle(`vet:${warriorName}`, "*referee*", warriorName, this.getMeta("cycle_id") ?? 0, 2, now);
	}

	/** Reset the idle-pause state when a warrior is created or changed. */
	private resumeFromPause(now: number) {
		this.setMeta("paused", 0);
		this.setMeta("idle", 0);
		this.setMeta("next_pod_at", Math.min(this.getMeta("next_pod_at") ?? now, now));
		this.setMeta("next_cycle_at", Math.min(this.getMeta("next_cycle_at") ?? now, now));
		this.setMetaStr("rank_sig", "");
	}

	private enqueuePairs(pairs: [string, string][], cycleId: number, priority: number, now: number): number {
		let inserted = 0;
		for (const [a, b] of pairs) {
			const key = a < b ? `${a}||${b}` : `${b}||${a}`;
			const existing = this.sql.exec("SELECT 1 FROM pending WHERE battle_key = ?", key).toArray();
			if (existing.length > 0) continue;
			this.enqueueBattle(key, a, b, cycleId, priority, now);
			inserted++;
		}
		return inserted;
	}

	private persistEvictions(names: string[]) {
		for (const name of names) {
			this.sql.exec("UPDATE warriors SET evicted = 1 WHERE name = ?", name);
		}
	}

	private async schedulePod(now: number): Promise<void> {
		const cfg = this.cfg();
		const warriors = this.getActiveWarriors();
		const { podPairs, newEvicted } = planCycle(warriors, cfg);
		this.persistEvictions(newEvicted);
		this.setMeta("next_pod_at", now + cfg.podIntervalMs);
		const inserted = this.enqueuePairs(podPairs, this.getMeta("cycle_id") ?? 0, 1, now);
		if (inserted > 0) await this.arm(now);
	}

	/**
	 * When a warrior is created/changed, immediately enqueue a small,
	 * stratified batch of battles (top / mid / bottom of the hill) at pod
	 * priority. This gives instant feedback and an early, more accurate Elo.
	 */
	private async scheduleImmediate(now: number, name: string): Promise<void> {
		const count = this.cfg().immediateOpponents;
		if (count < 1) return;
		const rows = this.sql
			.exec("SELECT * FROM warriors WHERE active = 1 AND evicted = 0 AND vet_failed = 0 AND name != ?", name)
			.toArray()
			.map((r) => this.rowToWarrior(r));
		if (rows.length === 0) return;
		const opponents = stratifiedOpponents(rows, Math.min(count, rows.length));
		if (opponents.length === 0) return;
		const pairs: [string, string][] = opponents.map((o) => [name, o] as [string, string]);
		const cycleId = this.getMeta("cycle_id") ?? 0;
		const inserted = this.enqueuePairs(pairs, cycleId, 1, now);
		if (inserted > 0) await this.arm(now);
	}

	private async scheduleFullCycle(now: number): Promise<void> {
		const cfg = this.cfg();
		const warriors = this.getActiveWarriors();
		const cycleId = (Number(this.getMeta("cycle_id") ?? 0) + 1);
		this.setMeta("cycle_id", cycleId);
		const plan = planCycle(warriors, cfg);
		this.persistEvictions(plan.newEvicted);
		this.setMeta("last_cycle_at", now);
		this.setMeta("drain_start", now);
		this.setFlag("counting_cycle", true);
		// delay the next automatic full cycle until after the queue drains and the gap is measured
		this.setMeta("next_cycle_at", now + cfg.cycleMaxGapMs);
		const inserted = this.enqueuePairs([...plan.podPairs, ...plan.pairs], cycleId, 0, now);
		// re-vet any active warrior whose defence hasn't been checked in a while
		for (const w of plan.active) {
			const last = w.vet_checked_at ?? 0;
			if (now - last > cfg.vetIntervalMs) {
				this.enqueueVet(w.name, now);
			}
		}
		if (inserted > 0) await this.arm(now);
	}

	private async arm(now: number): Promise<void> {
		if (this.getMeta("next_pod_at") === null) this.setMeta("next_pod_at", now);
		if (this.getMeta("next_cycle_at") === null) this.setMeta("next_cycle_at", now);

		if (this.pendingCount() > 0) {
			await this.ctx.storage.setAlarm(now + 100);
			return;
		}
		const next = Math.min(this.getMeta("next_pod_at")!, this.getMeta("next_cycle_at")!);
		await this.ctx.storage.setAlarm(Math.max(next, now + 5000));
	}

	/** Called when the queue drains: measure the gap and arm the next full cycle. */
	private onQueueDrained(now: number): void {
		const cfg = this.cfg();
		const drainStart = this.getMeta("drain_start");
		const lastCycle = this.getMeta("last_cycle_at");
		if (this.getFlag("counting_cycle") && drainStart && lastCycle) {
			const dur = Math.max(drainStart, lastCycle);
			const measured = Math.max(cfg.cycleMinGapMs, Math.round((now - dur) * cfg.cycleGapMultiplier));
			const gap = Math.min(cfg.cycleMaxGapMs, measured);
			this.setMeta("last_cycle_duration_ms", gap);
			this.setMeta("next_cycle_at", now + gap);
			this.setFlag("counting_cycle", false);
		}
	}

	// ------------------------------------------------------------------ battle execution

	private historyFor(attacker: string, defender: string, limit: number): HistoryEntry[] {
		const rows = this.sql
			.exec(
				"SELECT attack_text, output, created_at FROM rounds WHERE attacker = ? AND defender = ? ORDER BY id DESC LIMIT ?",
				attacker,
				defender,
				limit * 2,
			)
			.toArray()
			.reverse();
		return rows.map((r) => ({
			attackText: String(r.attack_text),
			output: String(r.output),
			createdAt: Number(r.created_at),
		}));
	}

	private async runRoundWithRetry(
		attacker: Warrior,
		defender: Warrior,
		attackItems: PromptItem[],
		defenseItems: PromptItem[],
		history: HistoryEntry[],
		shots: number,
	): Promise<RoundResult> {
		const model = defender.model || this.env.AI_MODEL;
		let result = await runRound(this.env, attacker.name, defender.name, attackItems, defenseItems, generateFlag(), model, history, shots);
		if (result.status === "error") {
			const again = await runRound(this.env, attacker.name, defender.name, attackItems, defenseItems, generateFlag(), model, history, shots);
			if (again.status !== "error") result = again;
		}
		return result;
	}

	private async doBattle(battle: BattleRow): Promise<void> {
		if (battle.battle_key.startsWith("vet:")) {
			await this.doSanityCheck(battle);
			return;
		}
		const a = this.getWarriorByName(battle.warrior_a);
		const b = this.getWarriorByName(battle.warrior_b);
		if (!a || !b) {
			this.sql.exec("DELETE FROM pending WHERE battle_key = ?", battle.battle_key);
			this.sql.exec("UPDATE battles SET status = 'failed' WHERE battle_key = ?", battle.battle_key);
			return;
		}
		this.sql.exec("UPDATE battles SET status = 'running' WHERE id = ?", battle.id);

		const cfg = this.cfg();
		const now = Date.now();

		const posAKey = `pos:${a.name}||${b.name}`;
		const posBKey = `pos:${b.name}||${a.name}`;
		const posA = this.getMeta(posAKey) ?? 0;
		const posB = this.getMeta(posBKey) ?? 0;
		const aPick = { items: [a.attack[posA % a.attack.length]], next: posA + 1 };
		const bPick = { items: [b.attack[posB % b.attack.length]], next: posB + 1 };

		const histA = this.historyFor(a.name, b.name, cfg.roundHistory);
		const histB = this.historyFor(b.name, a.name, cfg.roundHistory);

		const round1 = await this.runRoundWithRetry(a, b, aPick.items, b.defense, histA, cfg.attackShots);
		const round2 = await this.runRoundWithRetry(b, a, bPick.items, a.defense, histB, cfg.attackShots);

		interface Acc {
			name: string;
			elo: number;
			games: number;
			wins: number;
			losses: number;
			atkW: number;
			atkL: number;
			defW: number;
			defL: number;
			streak: number;
			evicted: number;
		}
		const acc = new Map<string, RoundStats & { name: string }>();
		const getAcc = (w: Warrior): RoundStats & { name: string } => {
			let u = acc.get(w.name);
			if (!u) {
				u = {
					name: w.name,
					elo: w.elo,
					games: w.games,
					wins: w.wins,
					losses: w.losses,
					attack_wins: w.attack_wins,
					attack_losses: w.attack_losses,
					defense_wins: w.defense_wins,
					defense_losses: w.defense_losses,
					streak_loses: w.streak_loses,
					evicted: w.evicted,
				};
				acc.set(w.name, u);
			}
			return u;
		};
		const settled = (result: RoundResult) => {
			if (result.status === "error") return;
			const attackerWon = result.status === "revealed";
			const winnerName = attackerWon ? result.attacker : result.defender;
			const uW = getAcc(winnerName === a.name ? a : b);
			const uL = getAcc(winnerName === a.name ? b : a);
			applyRoundSettlement(uW, uL, attackerWon, cfg.evictAfter, {
				attackerWinWeight: cfg.attackerWinWeight,
				streakAfterGames: cfg.provisionalGames,
			});
		};
		settled(round1);
		settled(round2);

		this.ctx.storage.transactionSync(() => {
			for (const [i, r] of [round1, round2].entries()) {
				this.sql.exec(
					"INSERT INTO rounds (battle_id, round_no, attacker, defender, flag, attack_text, defense_text, output, status, latency_ms, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
					battle.id,
					i + 1,
					r.attacker,
					r.defender,
					r.flag,
					r.attackText,
					r.defenseText,
					r.output,
					r.status,
					r.latencyMs,
					r.model,
					now,
				);
				const roundId = Number(this.sql.exec("SELECT last_insert_rowid() AS id").one().id as number);
				for (const ml of r.metaLogs) {
					this.sql.exec("INSERT INTO meta_log (round_id, source, generated) VALUES (?, ?, ?)", roundId, ml.source, ml.generated);
				}
			}
			for (const u of acc.values()) {
				this.sql.exec(
					"UPDATE warriors SET elo = ?, games = ?, wins = ?, losses = ?, attack_wins = ?, attack_losses = ?, defense_wins = ?, defense_losses = ?, streak_loses = ?, evicted = ?, last_battle_at = ? WHERE name = ?",
					Math.round(u.elo),
					u.games,
					u.wins,
					u.losses,
					u.attack_wins,
					u.attack_losses,
					u.defense_wins,
					u.defense_losses,
					u.streak_loses,
					u.evicted,
					now,
					u.name,
				);
				this.sql.exec("INSERT INTO elo_history (warrior, elo, games, created_at) VALUES (?, ?, ?, ?)", u.name, Math.round(u.elo), u.games, now);
			}
			this.sql.exec("UPDATE battles SET status = 'done', completed_at = ? WHERE id = ?", now, battle.id);
			this.sql.exec("DELETE FROM pending WHERE battle_key = ?", battle.battle_key);
			this.setMeta(posAKey, aPick.next);
			this.setMeta(posBKey, bPick.next);
		});
	}

	private async doSanityCheck(battle: BattleRow): Promise<void> {
		const w = this.getWarriorByName(battle.warrior_b);
		if (!w) {
			this.sql.exec("DELETE FROM pending WHERE battle_key = ?", battle.battle_key);
			this.sql.exec("UPDATE battles SET status = 'done', completed_at = ? WHERE battle_key = ?", Date.now(), battle.battle_key);
			return;
		}
		const cfg = this.cfg();
		const now = Date.now();
		const model = w.model || this.env.AI_MODEL;
		const attack = [{ text: cfg.vetAttack, meta: false }];
		let failed = false;
		for (let attempt = 0; attempt < 2; attempt++) {
			const result = await runRound(this.env, "*referee*", w.name, attack, w.defense, generateFlag(), model, []);
			if (result.status === "error" && attempt === 0) continue;
			failed = result.status === "refused";
			break;
		}
		this.sql.exec("UPDATE warriors SET vet_failed = ?, vet_checked_at = ? WHERE name = ?", failed ? 1 : 0, now, w.name);
		this.sql.exec("UPDATE battles SET status = 'done', completed_at = ? WHERE id = ?", now, battle.id);
		this.sql.exec("DELETE FROM pending WHERE battle_key = ?", battle.battle_key);
	}

	// ------------------------------------------------------------------ alarm loop

	async alarm(): Promise<void> {
		const started = Date.now();
		try {
			// purge stale warriors before draining, so new pairings exclude them
			this.cleanupStaleWarriors(Date.now());
			for (;;) {
				const battle = this.nextPending();
				if (!battle) break;
				await this.doBattle(battle);
				if (Date.now() - started > MAX_WALL_MS) break;
			}
			const now = Date.now();
			const podAt = this.getMeta("next_pod_at");
			if (podAt !== null && now >= podAt) {
				await this.schedulePod(now);
			}
			if (this.pendingCount() === 0) {
				this.onQueueDrained(now);
			}
			if (this.pendingCount() === 0) {
				this.checkIdle(now);
			}
			await this.arm(now);
		} catch (e) {
			console.error("alarm error", e);
			await this.ctx.storage.setAlarm(Date.now() + 30_000);
		}
	}

	/**
	 * Evicted / vet-failed warriors stop battling by design; once they have
	 * been inactive for CLEANUP_INACTIVE_DAYS they are removed from the hill.
	 * Runs at most hourly.
	 */
	private cleanupStaleWarriors(now: number): void {
		const last = this.getMeta("last_cleanup_at");
		if (last !== null && now - last < 900_000) return;
		this.setMeta("last_cleanup_at", now);
		const cutoff = now - this.cfg().cleanupInactiveDays * 86_400_000;
		const stale = this.sql
			.exec(
				"SELECT name FROM warriors WHERE active = 1 AND (evicted = 1 OR vet_failed = 1) AND COALESCE(last_battle_at, updated_at, created_at) < ?",
				cutoff,
			)
			.toArray();
		for (const row of stale) {
			const name = String(row.name);
			this.sql.exec("DELETE FROM pending WHERE battle_key IN (SELECT battle_key FROM battles WHERE warrior_a = ? OR warrior_b = ?)", name, name);
			this.sql.exec("DELETE FROM battles WHERE warrior_a = ? OR warrior_b = ?", name, name);
			this.sql.exec("DELETE FROM warriors WHERE name = ?", name);
		}
		if (stale.length > 0) {
			console.log(`cleaned up ${stale.length} stale warrior(s)`);
		}
	}

	/** A fingerprint of the current hill: active warriors and their elo/status. */
	private rankSig(): string {
		return this.sql
			.exec("SELECT name, elo, evicted, vet_failed FROM warriors WHERE active = 1 ORDER BY elo DESC, name ASC")
			.toArray()
			.map((r) => `${r.name}:${Math.round(Number(r.elo))}:${r.evicted}:${r.vet_failed}`)
			.join(";");
	}

	/**
	 * When the queue is empty and nothing has moved for IDLE_CYCLES ticks in a
	 * row, park the alarms until a warrior is added or changed (resumeFromPause).
	 */
	private checkIdle(now: number): void {
		const cfg = this.cfg();
		const sig = this.rankSig();
		const prev = this.getMetaStr("rank_sig");
		const idle = prev !== null && prev === sig ? (this.getMeta("idle") ?? 0) + 1 : 0;
		this.setMetaStr("rank_sig", sig);
		this.setMeta("idle", idle);
		if (idle >= cfg.idleCycles) {
			this.setMeta("paused", 1);
			const far = now + 365 * 24 * 3600 * 1000;
			this.setMeta("next_pod_at", far);
			this.setMeta("next_cycle_at", far);
			console.log("hill idle; pausing until a warrior changes");
		}
	}
}