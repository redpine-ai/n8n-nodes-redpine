// Pure selection and money logic for the Search and Unlock operation. No n8n
// imports, so the unit tests can load this file directly.

// The API quotes costs as decimal US dollar strings with six decimal places
// (microdollars). All arithmetic here is on integer microdollars.
const MICROS_PER_USD = 1_000_000;

export interface PreviewRow {
	id: string;
	locked: boolean;
	cost?: string | null;
}

export type SkipReason = 'maxResults' | 'unknownCost' | 'overBudget';

export interface Selection {
	/** Ids to deliver, in relevance order: already unlocked plus newly bought. */
	keep: string[];
	/** Locked ids among `keep`: the ones the unlock call must include. */
	toUnlock: string[];
	skipped: Array<{ id: string; reason: SkipReason }>;
	/** Sum of the quoted costs of `toUnlock` (new purchases), in microdollars. */
	quotedMicros: number;
	/** Sum of the quoted costs of rows that arrived already unlocked. */
	priorMicros: number;
	/** True when an already-unlocked row had no quoted cost, so priorMicros is a floor. */
	priorUnknown: boolean;
}

/**
 * Parse a non-negative decimal dollar amount into integer microdollars.
 * Digits past the sixth decimal place round up when `roundUp` is set (a
 * cost), down otherwise (a budget), so rounding never loosens a cap.
 */
export function parseUsdToMicros(value: string | number, roundUp: boolean): number {
	const text = String(value).trim();
	const match = /^(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
	if (!match || (!match[1] && !match[2])) {
		throw new Error(`Not a dollar amount: "${text}"`);
	}
	const digits = (match[1] || '') + (match[2] || '');
	// Position of the decimal point within `digits`, after the exponent.
	const point = (match[1] || '').length + Number(match[3] || 0) + 6;
	const padded = point > digits.length ? digits.padEnd(point, '0') : digits;
	const whole = point <= 0 ? '0' : padded.slice(0, point);
	const rest = point <= 0 ? digits : padded.slice(point);
	let micros = Number(whole || '0');
	if (roundUp && /[1-9]/.test(rest)) micros += 1;
	if (!Number.isSafeInteger(micros)) {
		throw new Error(`Dollar amount out of range: "${text}"`);
	}
	return micros;
}

export function formatMicros(micros: number): string {
	const whole = Math.floor(micros / MICROS_PER_USD);
	const frac = String(micros % MICROS_PER_USD).padStart(6, '0');
	return `${whole}.${frac}`;
}

/**
 * Walk the preview in relevance order and pick what to deliver.
 *
 * Every row counted against the cap costs its quote plus a one-microdollar
 * rounding allowance. The server charges each collection's rows as one sum
 * rounded to a microdollar (at least one microdollar when anything is
 * billable), not as the sum of the per-row quotes, and the two differ by
 * under one microdollar per row. A row quoted "0.000000" can still be worth
 * a fraction of a microdollar, and three of them can round up to one, so the
 * allowance applies to $0 quotes too.
 *
 * - A locked row with a known quote is bought while the running total stays
 *   within the budget. A row that would overshoot is skipped and the walk
 *   continues, so a cheaper, lower-ranked row can still fit.
 * - A locked row with no quote is skipped: null means unknown, not free.
 * - A row that is already unlocked is delivered and counted against both
 *   maxResults and the budget. A fresh preview has no such rows. They appear
 *   when an idempotent retry replays the same queryId, and then they are the
 *   rows the earlier attempt of this run bought. Counting them the same way
 *   that attempt did reproduces its decisions exactly, so the retry selects
 *   the same ids and buys nothing new. An already-unlocked row without a
 *   quote is treated as having spent the whole remaining budget.
 *
 * Guarantee: sum(quoted cost + 1 microdollar) over the rows counted is at
 * most maxCostMicros, except when rows that arrived already unlocked exceed
 * it on their own, and the server's charge for the rows counted is at most
 * that sum. At a budget of 0 nothing is bought; only rows already unlocked
 * under this queryId are delivered.
 */
export function selectWithinBudget(
	rows: PreviewRow[],
	maxResults: number,
	maxCostMicros: number,
): Selection {
	const selection: Selection = {
		keep: [],
		toUnlock: [],
		skipped: [],
		quotedMicros: 0,
		priorMicros: 0,
		priorUnknown: false,
	};
	let committed = 0;
	let exhausted = false;
	for (const row of rows) {
		if (selection.keep.length >= maxResults) {
			selection.skipped.push({ id: row.id, reason: 'maxResults' });
			continue;
		}
		const cost =
			row.cost === null || row.cost === undefined ? null : parseUsdToMicros(row.cost, true);
		if (!row.locked) {
			selection.keep.push(row.id);
			if (cost === null) {
				selection.priorUnknown = true;
				exhausted = true;
			} else {
				selection.priorMicros += cost;
				committed += cost + 1;
			}
			continue;
		}
		if (cost === null) {
			selection.skipped.push({ id: row.id, reason: 'unknownCost' });
			continue;
		}
		if (exhausted || committed + cost + 1 > maxCostMicros) {
			selection.skipped.push({ id: row.id, reason: 'overBudget' });
			continue;
		}
		selection.keep.push(row.id);
		selection.toUnlock.push(row.id);
		selection.quotedMicros += cost;
		committed += cost + 1;
	}
	return selection;
}
