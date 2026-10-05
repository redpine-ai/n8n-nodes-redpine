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

export type SkipReason = 'maxResults' | 'unknownCost' | 'overBudget' | 'belowSkipped';

export interface Selection {
	/** Ids to deliver, in relevance order: already unlocked plus newly bought. */
	keep: string[];
	/** Locked ids among `keep`: the ones the unlock call must include. */
	toUnlock: string[];
	skipped: Array<{ id: string; reason: SkipReason }>;
	/** Sum of the quoted costs of `toUnlock` (new purchases), in microdollars. */
	quotedMicros: number;
	/** Sum of the quoted costs of every row that arrived already unlocked, delivered or not. */
	priorMicros: number;
	/** True when an already-unlocked row had no usable quote; then nothing is bought. */
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

/** A row's quote in microdollars, or null when it is missing or unparseable. */
function quoteMicros(row: PreviewRow): number | null {
	if (row.cost === null || row.cost === undefined) return null;
	try {
		return parseUsdToMicros(row.cost, true);
	} catch {
		return null;
	}
}

/**
 * Pick what to deliver and what to buy.
 *
 * Every row counted against the cap costs its quote plus a one-microdollar
 * rounding allowance. The server charges each collection's rows as one sum
 * rounded to a microdollar (at least one microdollar when anything is
 * billable), not as the sum of the per-row quotes, and the two differ by
 * under one microdollar per row. A row quoted "0.000000" can still be worth
 * a fraction of a microdollar, and three of them can round up to one, so the
 * allowance applies to $0 quotes too.
 *
 * Rows that arrive already unlocked were bought earlier under this queryId:
 * on an idempotent retry, by the failed attempt of this run. All of them are
 * charged to the budget first, whatever their rank and whatever maxResults
 * is, because they were paid for whether or not they are delivered now. If
 * any of them has no usable quote, the prior spend is unknown and nothing is
 * bought.
 *
 * Then, in relevance order, up to maxResults rows are kept:
 * - an already-unlocked row is delivered;
 * - a locked row with a known quote is bought if it fits in what is left of
 *   the budget;
 * - a locked row with no usable quote is skipped: null means unknown, not free;
 * - once a locked row is skipped for either reason, no lower-ranked row is
 *   bought ('belowSkipped'). Buying stops rather than walking down to a
 *   cheaper, less relevant result, so the node never buys a worse result in
 *   place of a better one it could not afford. Already-unlocked rows below it
 *   are still delivered: they cost nothing now.
 *
 * Guarantee: when anything is bought, the prior rows' quotes plus the new
 * rows' quotes, each plus one microdollar, total at most maxCostMicros, and
 * the server's charge for those rows is at most that total. At a budget of 0
 * nothing is bought; only rows already unlocked under this queryId are
 * delivered.
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
	let stopped = false;
	for (const row of rows) {
		if (row.locked) continue;
		const cost = quoteMicros(row);
		if (cost === null) selection.priorUnknown = true;
		else {
			selection.priorMicros += cost;
			committed += cost + 1;
		}
	}
	for (const row of rows) {
		if (selection.keep.length >= maxResults) {
			selection.skipped.push({ id: row.id, reason: 'maxResults' });
			continue;
		}
		if (!row.locked) {
			selection.keep.push(row.id);
			continue;
		}
		if (stopped) {
			selection.skipped.push({ id: row.id, reason: 'belowSkipped' });
			continue;
		}
		const cost = quoteMicros(row);
		if (cost === null) {
			selection.skipped.push({ id: row.id, reason: 'unknownCost' });
			stopped = true;
			continue;
		}
		if (selection.priorUnknown || committed + cost + 1 > maxCostMicros) {
			selection.skipped.push({ id: row.id, reason: 'overBudget' });
			stopped = true;
			continue;
		}
		selection.keep.push(row.id);
		selection.toUnlock.push(row.id);
		selection.quotedMicros += cost;
		committed += cost + 1;
	}
	return selection;
}
