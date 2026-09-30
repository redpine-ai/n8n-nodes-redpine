import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { Redpine } from '../dist/nodes/Redpine/Redpine.node.js';

// n8n-workflow's ESM build does not load under plain Node; the node itself uses the CJS one.
const { NodeApiError } = createRequire(import.meta.url)('n8n-workflow');

const NODE_TYPE = '@redpine-ai/n8n-nodes-redpine.redpine';
const TOOL_TYPE = '@redpine-ai/n8n-nodes-redpine.redpineTool';
const row = (id, cost, locked = true) => ({ id, cost, locked });

// A fake n8n execute context. `handler(path, options)` plays the API.
function fakeContext({
	params,
	rawParams = {},
	handler,
	items = [{ json: {} }],
	type = NODE_TYPE,
	continueOnFail = false,
	executionId = 'exec-1',
}) {
	const calls = [];
	const node = { id: 'node-uuid', name: 'Redpine', type, typeVersion: 1, parameters: rawParams };
	return {
		calls,
		getInputData: () => items,
		getNodeParameter: (name, i) => (typeof params === 'function' ? params(i) : params)[name],
		getNode: () => structuredClone(node),
		getExecutionId: () => executionId,
		continueOnFail: () => continueOnFail,
		helpers: {
			async httpRequestWithAuthentication(credential, options) {
				calls.push({ credential, ...options });
				return handler(options.url.replace('https://api.redpine.ai/api/v1/search', ''), options);
			},
		},
	};
}

const run = (ctx) => new Redpine().execute.call(ctx);

const sauParams = (maxCost, extra = {}) => ({
	operation: 'searchAndUnlock',
	query: 'q',
	maxResults: 2,
	maxCost,
	collections: ['redpine-science'],
	searchOptions: {},
	deliveryOptions: {},
	...extra,
});

// ---- 1. an unlock always names its results ----

test('no input can send an unlock without a non-empty list of result ids', async () => {
	const inputs = [
		undefined,
		null,
		'',
		' , ',
		[],
		{},
		[''],
		[null],
		[{}],
		true,
		false,
		'false',
		'0',
		0,
		['a', 'b'],
		'a, b',
	];
	for (const resultIds of inputs) {
		const ctx = fakeContext({
			params: { operation: 'unlock', queryId: 'q', resultIds, deliveryOptions: {} },
			handler: () => ({ queryId: 'q', costToUnlockRemaining: '0', results: [] }),
		});
		await run(ctx).catch(() => {});
		for (const call of ctx.calls) {
			const ids = call.body?.resultIds;
			assert.ok(
				Array.isArray(ids) &&
					ids.length > 0 &&
					ids.every((id) => typeof id === 'string' && id.trim()),
				`input ${JSON.stringify(resultIds)} sent ${JSON.stringify(call.body)}`,
			);
		}
	}
});

test('empty, blank and object Result IDs are refused before any request', async () => {
	for (const resultIds of ['', ' , ', [], {}, null]) {
		const ctx = fakeContext({
			params: { operation: 'unlock', queryId: 'q', resultIds, deliveryOptions: {} },
			handler: () => assert.fail('no request expected'),
		});
		await assert.rejects(run(ctx), /Result IDs/);
		assert.equal(ctx.calls.length, 0);
	}
});

test('there is no Unlock All option left in the node', () => {
	const names = new Redpine().description.properties.map((p) => p.name);
	assert.ok(!names.includes('unlockAll'));
});

test('every HTTP call goes through the one guarded request function', () => {
	const source = readFileSync(
		new URL('../dist/nodes/Redpine/Redpine.node.js', import.meta.url),
		'utf8',
	);
	assert.equal(source.match(/httpRequestWithAuthentication/g).length, 1);
	assert.match(source, /Refusing to unlock without a list of result IDs/);
});

// ---- 2 and 3. Search and Unlock: cap, idempotency key, replay ----

test('Search and Unlock skips the unlock call when nothing needs buying', async () => {
	const ctx = fakeContext({
		params: sauParams(0),
		handler: () => ({
			queryId: 'q1',
			costToUnlockRemaining: '0.5',
			costCharged: null,
			results: [row('free', '0.000000'), row('b', '0.5')],
		}),
	});
	const [items] = await run(ctx);
	assert.equal(ctx.calls.length, 1);
	assert.equal(ctx.calls[0].url, 'https://api.redpine.ai/api/v1/search/preview');
	assert.equal(ctx.calls[0].credential, 'redpineApi');
	assert.equal(items.length, 1, 'one item with the response fields and summary');
	assert.equal(items[0].json.runSummary.costCharged, '0');
	assert.deepEqual(
		items[0].json.runSummary.skipped.map((s) => s.reason),
		['overBudget', 'overBudget'],
	);
});

test('Search and Unlock unlocks only the kept locked ids', async () => {
	const ctx = fakeContext({
		params: sauParams(1),
		handler: (path) =>
			path === '/preview'
				? {
						queryId: 'q2',
						costToUnlockRemaining: '0.4',
						results: [row('a', '0.1'), row('b', null), row('c', '0.2'), row('d', '0.1')],
					}
				: {
						queryId: 'q2',
						costToUnlockRemaining: '0.1',
						costCharged: '0.300000',
						results: [
							row('a', '0.1', false),
							row('b', null),
							row('c', '0.2', false),
							row('d', '0.1'),
						],
					},
	});
	const [items] = await run(ctx);
	assert.equal(ctx.calls.length, 2);
	assert.deepEqual(ctx.calls[1].body, {
		queryId: 'q2',
		resultIds: ['a', 'c'],
		includeFigures: false,
	});
	assert.deepEqual(
		items.map((i) => i.json.id),
		['a', 'c'],
	);
	assert.equal(items[0].json.runSummary.costCharged, '0.300000');
	assert.equal(items[0].json.runSummary.quotedCost, '0.300000');
});

test('Search and Unlock rejects a negative cap before any request', async () => {
	const ctx = fakeContext({
		params: sauParams(-1),
		handler: () => assert.fail('no request expected'),
	});
	await assert.rejects(run(ctx), /Max Cost Per Run must be 0 or more/);
	assert.equal(ctx.calls.length, 0);
});

// A server implementing the Idempotency-Key contract plus the unlock ledger.
function idempotentServer(rows, { loseFirstUnlockResponse }) {
	const byKey = new Map();
	const unlocked = new Set();
	const state = { charged: 0, unlockCalls: 0, previews: 0 };
	const price = new Map(rows.map((r) => [r.id, Math.round(Number(r.cost) * 1e6)]));
	const shape = (queryId, extra = {}) => ({
		queryId,
		costToUnlockRemaining: '0',
		results: rows.map((r) => ({ ...r, locked: !unlocked.has(r.id) })),
		...extra,
	});
	const handler = (path, options) => {
		if (path === '/preview') {
			state.previews++;
			const key = options.headers?.['Idempotency-Key'];
			const body = JSON.stringify(options.body);
			if (key && byKey.has(key)) {
				if (byKey.get(key).body !== body) throw new Error('IDEMPOTENCY_KEY_REUSED');
				return shape(byKey.get(key).queryId);
			}
			const queryId = `q${state.previews}`;
			if (key) byKey.set(key, { body, queryId });
			unlocked.clear(); // a fresh queryId has an empty ledger
			return shape(queryId);
		}
		state.unlockCalls++;
		let delta = 0;
		for (const id of options.body.resultIds) {
			if (!unlocked.has(id)) delta += price.get(id);
			unlocked.add(id);
		}
		state.charged += delta;
		if (loseFirstUnlockResponse && state.unlockCalls === 1) throw new Error('socket hang up');
		return shape(options.body.queryId, { costCharged: (delta / 1e6).toFixed(6) });
	};
	return { handler, state, byKey };
}

test('Retry on Fail after a lost unlock response charges nothing new', async () => {
	const rows = [row('a', '0.300000'), row('b', '0.300000'), row('c', '0.300000')];
	const server = idempotentServer(rows, { loseFirstUnlockResponse: true });
	const cap = 0.7;
	const params = sauParams(cap, { maxResults: 3 });

	// Attempt 1: preview, unlock a + b (0.6 of 0.7), then the response is lost.
	const first = fakeContext({ params, handler: server.handler });
	await assert.rejects(run(first), /socket hang up/);
	assert.equal(server.state.charged, 600_000);

	// Attempt 2: n8n reruns the node in the same execution.
	const second = fakeContext({ params, handler: server.handler });
	const [items] = await run(second);
	const keys = [first, second].map((c) => c.calls[0].headers['Idempotency-Key']);
	assert.equal(keys[0], keys[1], 'same key on retry');
	assert.match(keys[0], /^n8n:exec-1:node-uuid:0:[0-9a-f]{16}$/);
	assert.equal(second.calls.length, 1, 'the replay makes no unlock call');
	assert.deepEqual(
		items.map((i) => i.json.id),
		['a', 'b'],
	);
	assert.equal(items[0].json.runSummary.alreadyUnlockedCost, '0.600000');
	assert.ok(server.state.charged <= cap * 1e6, `charged ${server.state.charged}`);
});

test('without an idempotent server a retry could buy twice, which the key prevents', async () => {
	// Control: the same flow against a server that ignores the header.
	const rows = [row('a', '0.300000'), row('b', '0.300000')];
	const server = idempotentServer(rows, { loseFirstUnlockResponse: true });
	const ignoring = (path, options) => server.handler(path, { ...options, headers: undefined });
	const params = sauParams(0.7);
	await assert.rejects(run(fakeContext({ params, handler: ignoring })), /socket hang up/);
	await run(fakeContext({ params, handler: ignoring }));
	assert.equal(
		server.state.charged,
		1_200_000,
		'the documented limit when the server lacks the feature',
	);
});

test('distinct searches in one execution get distinct keys; no key without an execution id', async () => {
	const handler = () => ({ queryId: 'q', costToUnlockRemaining: '0', results: [] });
	const a = fakeContext({ params: sauParams(0, { query: 'first' }), handler });
	const b = fakeContext({ params: sauParams(0, { query: 'second' }), handler });
	await run(a);
	await run(b);
	assert.notEqual(a.calls[0].headers['Idempotency-Key'], b.calls[0].headers['Idempotency-Key']);
	const items = [{ json: {} }, { json: {} }];
	const two = fakeContext({ params: sauParams(0), handler, items });
	await run(two);
	assert.notEqual(two.calls[0].headers['Idempotency-Key'], two.calls[1].headers['Idempotency-Key']);
	const none = fakeContext({ params: sauParams(0), handler, executionId: '' });
	await run(none);
	assert.equal(none.calls[0].headers, undefined);
	assert.ok(a.calls[0].headers['Idempotency-Key'].length <= 255);
});

test('Preview does not send an idempotency key', async () => {
	const ctx = fakeContext({
		params: {
			operation: 'preview',
			query: 'q',
			collections: ['redpine-science'],
			searchOptions: {},
		},
		handler: () => ({ queryId: 'q', costToUnlockRemaining: '0', results: [] }),
	});
	await run(ctx);
	assert.equal(ctx.calls[0].headers, undefined);
});

// ---- 4. AI tool path ----

test('as an AI tool, Unlock is refused before any request', async () => {
	const ctx = fakeContext({
		type: TOOL_TYPE,
		params: { operation: 'unlock', queryId: 'q', resultIds: 'a', deliveryOptions: {} },
		handler: () => assert.fail('no request expected'),
	});
	await assert.rejects(run(ctx), /not available to an AI Agent/);
	assert.equal(ctx.calls.length, 0);
});

test('as an AI tool, Search and Unlock refuses a Max Cost that is an expression', async () => {
	for (const raw of ['={{ $fromAI("maxCost", "", "number") }}', '={{ $json.maxCost }}']) {
		const ctx = fakeContext({
			type: TOOL_TYPE,
			params: sauParams(1000),
			rawParams: { operation: 'searchAndUnlock', maxCost: raw },
			handler: () => assert.fail('no request expected'),
		});
		await assert.rejects(run(ctx), /fixed number/);
		assert.equal(ctx.calls.length, 0);
	}
});

test('as an AI tool, Preview, Get Results and a fixed-cap Search and Unlock run', async () => {
	const handler = () => ({ queryId: 'q', costToUnlockRemaining: '0', results: [], latencyMs: 1 });
	for (const [params, rawParams] of [
		[{ operation: 'preview', query: 'q', collections: ['redpine-science'], searchOptions: {} }, {}],
		[{ operation: 'getResults', queryId: 'q', deliveryOptions: {} }, {}],
		[sauParams(0.5), { maxCost: 0.5 }],
		[sauParams(0), {}], // default Max Cost is not stored in parameters
	]) {
		const ctx = fakeContext({ type: TOOL_TYPE, params, rawParams, handler });
		await run(ctx);
		assert.equal(ctx.calls.length, 1);
	}
});

test('the regular node may still use an expression for Max Cost', async () => {
	const ctx = fakeContext({
		params: sauParams(0),
		rawParams: { maxCost: '={{ $json.budget }}' },
		handler: () => ({ queryId: 'q', costToUnlockRemaining: '0', results: [] }),
	});
	await run(ctx);
	assert.equal(ctx.calls.length, 1);
});

// ---- 5 and 6. errors ----

class AxiosError extends Error {}
function apiFailure(status, envelope) {
	const error = new AxiosError(`Request failed with status code ${status}`);
	error.response = { status, data: { error: envelope } };
	return error;
}

const previewParams = {
	operation: 'preview',
	query: 'q',
	collections: ['redpine-science'],
	searchOptions: {},
};
const node = { id: 'node-uuid', name: 'Redpine', type: NODE_TYPE, typeVersion: 1, parameters: {} };

test('an API error on the second item reports item index 1', async () => {
	let n = 0;
	const ctx = fakeContext({
		params: previewParams,
		items: [{ json: {} }, { json: {} }],
		handler: () => {
			if (n++ === 0) return { queryId: 'q', costToUnlockRemaining: '0', results: [] };
			// What httpRequestWithAuthentication throws: an already-built NodeApiError.
			throw new NodeApiError(
				node,
				apiFailure(402, { code: 'INSUFFICIENT_CREDITS', message: 'Balance too low' }),
			);
		},
	});
	const error = await run(ctx).then(
		() => assert.fail('expected a throw'),
		(e) => e,
	);
	assert.ok(error instanceof NodeApiError);
	assert.equal(error.context.itemIndex, 1);
});

test('Continue On Fail keeps the Redpine error code, message and HTTP status', async () => {
	let n = 0;
	const ctx = fakeContext({
		params: previewParams,
		items: [{ json: {} }, { json: {} }],
		continueOnFail: true,
		handler: () => {
			if (n++ === 0) return { queryId: 'q', costToUnlockRemaining: '0', results: [] };
			throw new NodeApiError(
				node,
				apiFailure(402, {
					code: 'INSUFFICIENT_CREDITS',
					message: 'Balance too low',
					requestId: 'req-1',
				}),
			);
		},
	});
	const [items] = await run(ctx);
	assert.equal(items.length, 2);
	assert.deepEqual(items[1], {
		json: {
			error: 'Balance too low',
			code: 'INSUFFICIENT_CREDITS',
			httpStatus: 402,
			requestId: 'req-1',
		},
		pairedItem: { item: 1 },
	});
});

test('Continue On Fail on a validation error has no code or status', async () => {
	const ctx = fakeContext({
		params: { operation: 'unlock', queryId: 'q', resultIds: '', deliveryOptions: {} },
		continueOnFail: true,
		handler: () => assert.fail('no request expected'),
	});
	const [items] = await run(ctx);
	assert.equal(items[0].json.code, null);
	assert.equal(items[0].json.httpStatus, null);
	assert.match(items[0].json.error, /Result IDs is empty/);
	assert.deepEqual(items[0].pairedItem, { item: 0 });
});

// ---- collections are required ----

test('an empty collection selection is refused before any request', async () => {
	for (const collections of [[], undefined, '', ' , ', [''], [null]]) {
		for (const params of [
			{ operation: 'preview', query: 'q', collections, searchOptions: {} },
			sauParams(1, { collections }),
		]) {
			const ctx = fakeContext({ params, handler: () => assert.fail('no request expected') });
			await assert.rejects(run(ctx), /Choose at least one collection/);
			assert.equal(ctx.calls.length, 0);
		}
	}
});

test('one collection is sent as collection, several as collections, duplicates dropped', async () => {
	const handler = () => ({ queryId: 'q', costToUnlockRemaining: '0', results: [] });
	const one = fakeContext({
		params: { operation: 'preview', query: 'q', collections: ['a', 'a'], searchOptions: {} },
		handler,
	});
	await run(one);
	assert.deepEqual(one.calls[0].body, { query: 'q', collection: 'a' });
	const two = fakeContext({
		params: { operation: 'preview', query: 'q', collections: ['a', 'b'], searchOptions: {} },
		handler,
	});
	await run(two);
	assert.deepEqual(two.calls[0].body, { query: 'q', collections: ['a', 'b'] });
	const six = fakeContext({
		params: {
			operation: 'preview',
			query: 'q',
			collections: ['a', 'b', 'c', 'd', 'e', 'f'],
			searchOptions: {},
		},
		handler,
	});
	await assert.rejects(run(six), /at most 5/);
	assert.equal(six.calls.length, 0);
});
