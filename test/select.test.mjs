import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	formatMicros,
	parseUsdToMicros,
	selectWithinBudget,
} from '../dist/nodes/Redpine/select.js';

const usd = (value) => parseUsdToMicros(value, false);
const row = (id, cost, locked = true) => ({ id, cost, locked });

test('parses dollar strings to exact microdollars', () => {
	assert.equal(parseUsdToMicros('0.000001', true), 1);
	assert.equal(parseUsdToMicros('12.5', true), 12_500_000);
	assert.equal(parseUsdToMicros('0', true), 0);
	assert.equal(parseUsdToMicros('0.000000', true), 0);
	assert.equal(parseUsdToMicros('.25', true), 250_000);
	assert.equal(parseUsdToMicros('1E-7', true), 1, 'sub-micro cost rounds up');
	assert.equal(parseUsdToMicros('1E-7', false), 0, 'sub-micro budget rounds down');
	assert.equal(parseUsdToMicros('1e3', false), 1_000_000_000);
	for (const bad of ['', '.', '-1', 'abc', '1.2.3', 'NaN']) {
		assert.throws(() => parseUsdToMicros(bad, true), undefined, bad);
	}
});

test('money arithmetic is exact where floats are not', () => {
	assert.notEqual(0.1 + 0.2, 0.3);
	assert.equal(usd('0.1') + usd('0.2'), usd('0.3'));
	// A float budget that is 0.30000000000000004 must not buy a 0.300001 row.
	assert.equal(usd(0.1 + 0.2), 300_000);
	assert.equal(formatMicros(usd('0.1') + usd('0.2')), '0.300000');
	assert.equal(formatMicros(1), '0.000001');
	assert.equal(formatMicros(12_500_000), '12.500000');
});

test('buys rows under the cap and skips the one that would exceed it', () => {
	// 0.1 + 0.2 plus one microdollar of rounding allowance per row is exactly 0.300002.
	const rows = [row('a', '0.100000'), row('b', '0.200000'), row('c', '0.000001')];
	const sel = selectWithinBudget(rows, 10, usd('0.300002'));
	assert.deepEqual(sel.keep, ['a', 'b']);
	assert.deepEqual(sel.toUnlock, ['a', 'b']);
	assert.equal(sel.quotedMicros, 300_000);
	assert.deepEqual(sel.skipped, [{ id: 'c', reason: 'overBudget' }]);
});

test('reserves one microdollar of rounding allowance per bought row', () => {
	const rows = [row('a', '0.100000'), row('b', '0.200000')];
	const sel = selectWithinBudget(rows, 10, usd('0.3'));
	assert.deepEqual(sel.keep, ['a']);
	assert.deepEqual(sel.skipped, [{ id: 'b', reason: 'overBudget' }]);
});

test('$0 quotes get the rounding allowance too', () => {
	const zeros = [row('a', '0.000000'), row('b', '0.000000'), row('c', '0.000000')];
	assert.deepEqual(selectWithinBudget(zeros, 10, 0).toUnlock, [], 'nothing is bought at a $0 cap');
	assert.deepEqual(selectWithinBudget(zeros, 10, 2).toUnlock, ['a', 'b']);
	assert.deepEqual(selectWithinBudget(zeros, 10, 3).toUnlock, ['a', 'b', 'c']);
});

test('stops buying at the first over-budget row instead of walking to a cheaper one', () => {
	const rows = [row('big', '5.000000'), row('small', '0.010000')];
	const sel = selectWithinBudget(rows, 10, usd('1'));
	assert.deepEqual(sel.keep, []);
	assert.deepEqual(sel.skipped, [
		{ id: 'big', reason: 'overBudget' },
		{ id: 'small', reason: 'belowSkipped' },
	]);
});

test('already-unlocked rows below a skipped row are still delivered', () => {
	const rows = [row('big', '5.000000'), row('prior', '0.100000', false), row('small', '0.010000')];
	const sel = selectWithinBudget(rows, 10, usd('1'));
	assert.deepEqual(sel.keep, ['prior']);
	assert.deepEqual(sel.toUnlock, []);
	assert.deepEqual(
		sel.skipped.map((s) => s.reason),
		['overBudget', 'belowSkipped'],
	);
});

test('skips locked rows with a null or missing cost', () => {
	const rows = [row('unknown', null), { id: 'missing', locked: true }, row('priced', '0.01')];
	const sel = selectWithinBudget(rows, 10, usd('1'));
	assert.deepEqual(sel.keep, [], 'nothing ranked below an unpriced row is bought');
	assert.deepEqual(sel.skipped, [
		{ id: 'unknown', reason: 'unknownCost' },
		{ id: 'missing', reason: 'belowSkipped' },
		{ id: 'priced', reason: 'belowSkipped' },
	]);
	const missingFirst = selectWithinBudget([{ id: 'missing', locked: true }, row('p', '0.01')], 10, usd('1'));
	assert.deepEqual(missingFirst.skipped[0], { id: 'missing', reason: 'unknownCost' });
});

test('already-unlocked rows are delivered and count against the budget', () => {
	// 0.5 already bought (+1 allowance) leaves 0.499999 of a 1.0 cap.
	const rows = [row('prior', '0.500000', false), row('fits', '0.400000'), row('over', '0.100000')];
	const sel = selectWithinBudget(rows, 10, usd('1'));
	assert.deepEqual(sel.keep, ['prior', 'fits']);
	assert.deepEqual(sel.toUnlock, ['fits']);
	assert.equal(sel.priorMicros, 500_000);
	assert.deepEqual(sel.skipped, [{ id: 'over', reason: 'overBudget' }]);
});

test('an already-unlocked row with no quote spends the rest of the budget', () => {
	const rows = [row('prior', null, false), row('cheap', '0.000001')];
	const sel = selectWithinBudget(rows, 10, usd('100'));
	assert.deepEqual(sel.keep, ['prior']);
	assert.equal(sel.priorUnknown, true);
	assert.deepEqual(sel.skipped, [{ id: 'cheap', reason: 'overBudget' }]);
});

test('at a $0 cap only already-unlocked rows are delivered', () => {
	const rows = [row('prior', '0.01', false), row('free', '0.000000'), row('paid', '0.01')];
	const sel = selectWithinBudget(rows, 10, 0);
	assert.deepEqual(sel.keep, ['prior']);
	assert.deepEqual(sel.toUnlock, []);
});

test('stops delivering at maxResults, counting already-unlocked rows', () => {
	const rows = [row('a', '0.01', false), row('b', '0.01'), row('c', '0.01'), row('d', '0.01')];
	const sel = selectWithinBudget(rows, 2, usd('100'));
	assert.deepEqual(sel.keep, ['a', 'b']);
	assert.deepEqual(sel.toUnlock, ['b']);
	assert.deepEqual(
		sel.skipped.map((s) => s.reason),
		['maxResults', 'maxResults'],
	);
});

// ---- properties over random previews ----

function prng(seed) {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

const roundHalfUp = (x) => Math.floor(x + 0.5);

function randomPreview(rand) {
	const n = 1 + Math.floor(rand() * 30);
	return Array.from({ length: n }, (_, i) => {
		// Exact cost in fractional microdollars, often sub-microdollar.
		const exact = rand() < 0.3 ? rand() * 0.9 : rand() * 200_000;
		const quote = rand() < 0.1 ? null : formatMicros(roundHalfUp(exact));
		return { id: `r${i}`, locked: true, cost: quote, exact, group: Math.floor(rand() * 3) };
	});
}

// The server: each collection's rows charged as one rounded sum, at least one
// microdollar when anything in the group is billable.
function serverCharge(rows) {
	const groups = new Map();
	for (const r of rows) groups.set(r.group, (groups.get(r.group) ?? 0) + r.exact);
	let total = 0;
	for (const exact of groups.values()) total += exact > 0 ? Math.max(1, roundHalfUp(exact)) : 0;
	return total;
}

test('property: the modelled server charge never exceeds the cap', () => {
	const rand = prng(42);
	for (let t = 0; t < 2000; t++) {
		const rows = randomPreview(rand);
		const cap = Math.floor(rand() * 1_000_000);
		const sel = selectWithinBudget(rows, 1 + Math.floor(rand() * 30), cap);
		const bought = rows.filter((r) => sel.toUnlock.includes(r.id));
		assert.ok(
			serverCharge(bought) <= cap,
			`case ${t}: charged ${serverCharge(bought)} > cap ${cap}`,
		);
	}
});

test('property: an idempotent replay selects the same ids and buys nothing new', () => {
	const rand = prng(7);
	for (let t = 0; t < 2000; t++) {
		const rows = randomPreview(rand);
		const maxResults = 1 + Math.floor(rand() * 30);
		const cap = Math.floor(rand() * 1_000_000);
		const first = selectWithinBudget(rows, maxResults, cap);
		// Attempt 1's unlock was charged; its response was lost. The replayed
		// preview shows those rows unlocked, with their quoted cost intact.
		const bought = new Set(first.toUnlock);
		const replay = rows.map((r) => ({ ...r, locked: !bought.has(r.id) }));
		const second = selectWithinBudget(replay, maxResults, cap);
		assert.deepEqual(second.toUnlock, [], `case ${t}: replay bought ${second.toUnlock}`);
		assert.deepEqual(second.keep, first.keep, `case ${t}`);
	}
});

test('Astra case: prior spend is charged before any purchase, whatever its rank', () => {
	// A=$0.60 ranks above B=$0.40. At $0.50 A does not fit, so nothing is bought
	// (B is not bought in A's place); suppose B was then bought by an explicit Unlock.
	const first = selectWithinBudget([row('A', '0.600000'), row('B', '0.400000')], 2, usd('0.5'));
	assert.deepEqual(first.toUnlock, []);
	// Attempt 2 at $0.70 and Max Results 1: buying A would total $1.00.
	const second = selectWithinBudget(
		[row('A', '0.600000'), row('B', '0.400000', false)],
		1,
		usd('0.7'),
	);
	assert.deepEqual(second.toUnlock, []);
	assert.deepEqual(second.keep, ['B']);
	assert.equal(second.priorMicros, 400_000);
});

test('an unlocked row with no usable quote ranked after a selectable row: nothing bought', () => {
	for (const cost of [null, undefined, 'abc', '']) {
		const sel = selectWithinBudget([row('a', '0.100000'), row('b', cost, false)], 10, usd('100'));
		assert.deepEqual(sel.toUnlock, [], String(cost));
		assert.deepEqual(sel.keep, ['b']);
		assert.equal(sel.priorUnknown, true);
	}
});

test('prior spend includes unlocked rows that are not delivered', () => {
	const rows = [row('a', '0.100000'), row('b', '0.200000', false), row('c', '0.300000', false)];
	const sel = selectWithinBudget(rows, 1, usd('1'));
	assert.equal(sel.priorMicros, 500_000);
	assert.deepEqual(sel.toUnlock, ['a']);
	assert.deepEqual(
		sel.skipped.map((s) => s.reason),
		['maxResults', 'maxResults'],
	);
	// With $0.60 left after prior spend counted, a $0.6 row does not fit.
	const tight = selectWithinBudget([row('x', '0.600000'), ...rows.slice(1)], 1, usd('1.1'));
	assert.deepEqual(tight.toUnlock, []);
});

test('a locked row with an unparseable quote is skipped, not fatal', () => {
	const sel = selectWithinBudget([row('bad', '1.2.3'), row('ok', '0.1')], 10, usd('1'));
	assert.deepEqual(sel.skipped, [
		{ id: 'bad', reason: 'unknownCost' },
		{ id: 'ok', reason: 'belowSkipped' },
	]);
	assert.deepEqual(sel.toUnlock, []);
});
