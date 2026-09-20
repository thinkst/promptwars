export const ELO_START = 1500;

export function expectedScore(ra: number, rb: number): number {
	return 1 / (1 + Math.pow(10, (rb - ra) / 400));
}

export function eloK(games: number): number {
	if (games < 20) return 40;
	if (games < 50) return 30;
	return 15;
}

export function isProvisional(games: number): boolean {
	return games < 10;
}

export interface EloDelta {
	winner: number;
	loser: number;
}

export function applyElo(winnerElo: number, loserElo: number, winnerGames: number, loserGames: number): EloDelta {
	const expected = expectedScore(winnerElo, loserElo);
	const k = Math.min(eloK(winnerGames), eloK(loserGames));
	const delta = Math.round(k * (1 - expected));
	return { winner: winnerElo + delta, loser: loserElo - delta };
}

export interface RoundStats {
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
}

export interface SettlementOpts {
	/** Multiply the Elo swing (winner gain / loser loss) for attacker wins. */
	attackerWinWeight?: number;
	/** Only accumulate the loser's eviction streak once games >= this. */
	streakAfterGames?: number;
}

/**
 * Mutates `winner`/`loser` to account for a completed non-error round.
 * Elo and games advance for both; the attack/defense split follows the
 * warrior who was the round's attacker. Attacker wins swing harder than
 * defender wins (base-rate balancing), and new warriors are eviction-immune
 * until they reach `streakAfterGames`.
 */
export function applyRoundSettlement(
	winner: RoundStats,
	loser: RoundStats,
	attackerWon: boolean,
	evictAfter: number,
	opts: SettlementOpts = {},
): void {
	const weight = attackerWon ? opts.attackerWinWeight ?? 1 : 1;
	const k = Math.min(eloK(winner.games), eloK(loser.games));
	const rawDelta = Math.round(k * (1 - expectedScore(winner.elo, loser.elo)));
	const delta = attackerWon ? Math.round(rawDelta * weight) : rawDelta;
	winner.elo += delta;
	loser.elo -= delta;
	winner.games += 1;
	loser.games += 1;
	winner.wins += 1;
	loser.losses += 1;
	if (attackerWon) {
		winner.attack_wins += 1;
		loser.defense_losses += 1;
	} else {
		winner.defense_wins += 1;
		loser.attack_losses += 1;
	}
	winner.streak_loses = 0;
	const streakAfter = opts.streakAfterGames ?? 0;
	loser.streak_loses = loser.games >= streakAfter ? loser.streak_loses + 1 : 0;
	if (loser.streak_loses >= evictAfter) loser.evicted = 1;
}