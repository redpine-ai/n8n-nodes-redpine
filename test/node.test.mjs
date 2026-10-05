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

// A fake n8n execute context. `handler(path, options)` plays the API and
// returns a body, or `full(body, headers)` to set response headers. A plain
// preview body comes with `Idempotency-Status: created` unless
// `previewHeaders` says otherwise.
const FULL = Symbol('full');
const full = (body, headers) => ({ [FULL]: true, body, headers });

function fakeContext({
	params,
	rawParams = {},
	handler,
	items = [{ json: {} }],
	type = NODE_TYPE,
	continueOnFail = false,
	executionId = 'exec-1',
	runIndex = 0,
	previewHeaders = { 'idempotency-status': 'created' },
}) {
	const calls = [];
	const node = { id: 'node-uuid', name: 'Redpine', type, typeVersion: 1, parameters: rawParams };
	return {
		calls,
		getInputData: () => items,
		getNodeParameter: (name, i) => (typeof params === 'function' ? params(i) : params)[name],
		getNode: () => structuredClone(node),
		getExecutionId: () => executionId,
		getWorkflowDataProxy: () => ({ $thisRunIndex: runIndex }),
		continueOnFail: () => continueOnFail,
		helpers: {
			async httpRequestWithAuthentication(credential, options) {
				calls.push({ credential, ...options });
				const path = options.url.replace('https://api.redpine.ai/api/v1/search', '');
				const result = await handler(path, options);
				const response = result?.[FULL]
					? result
					: { body: result, headers: path === '/preview' ? previewHeaders : {} };
				return options.returnFullResponse
					? { body: response.body, headers: response.headers ?? {}, statusCode: 200 }
					: response.body;
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
		['overBudget', 'belowSkipped'],
	);
});

test('Search and Unlock unlocks only the kept locked ids', async () => {
	const ctx = fakeContext({
		params: sauParams(1, { maxResults: 4 }),
		handler: (path) =>
			path === '/preview'
				? {
						queryId: 'q2',
						costToUnlockRemaining: '0.4',
						results: [row('a', '0.1'), row('b', '0.2'), row('c', '5.0'), row('d', '0.1')],
					}
				: {
						queryId: 'q2',
						costToUnlockRemaining: '0.1',
						costCharged: '0.300000',
						results: [
							row('a', '0.1', false),
							row('b', '0.2', false),
							row('c', '5.0'),
							row('d', '0.1'),
						],
					},
	});
	const [items] = await run(ctx);
	assert.equal(ctx.calls.length, 2);
	assert.deepEqual(ctx.calls[1].body, {
		queryId: 'q2',
		resultIds: ['a', 'b'],
		includeFigures: false,
	});
	assert.deepEqual(
		items.map((i) => i.json.id),
		['a', 'b'],
	);
	assert.deepEqual(
		items[0].json.runSummary.skipped.map((s) => s.reason),
		['overBudget', 'belowSkipped'],
		'c does not fit, so d (ranked below it) is not bought either',
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
function idempotentServer(rows, { loseFirstUnlockResponse = false, honoursKey = true } = {}) {
	const byKey = new Map();
	const unlocked = new Set();
	const state = { charged: 0, unlockCalls: 0, previews: 0, resultsCalls: [] };
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
			const key = honoursKey ? options.headers?.['Idempotency-Key'] : undefined;
			const body = JSON.stringify(options.body);
			if (key && byKey.has(key)) {
				if (byKey.get(key).body !== body) throw new Error('422 IDEMPOTENCY_KEY_REUSED');
				return full(shape(byKey.get(key).queryId), { 'Idempotency-Status': 'replayed' });
			}
			const queryId = `q${state.previews}`;
			if (key) byKey.set(key, { body, queryId });
			unlocked.clear(); // a fresh queryId has an empty ledger
			return full(shape(queryId), key ? { 'Idempotency-Status': 'created' } : {});
		}
		if (path.startsWith('/results/')) {
			state.resultsCalls.push(options.qs);
			const body = shape(path.split('/')[2], { latencyMs: 1 });
			if (options.qs?.includeFigures) {
				body.results = body.results.map((r) =>
					r.locked ? r : { ...r, metadata: { figures: [{ image_data: 'base64' }] } },
				);
			}
			return body;
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
	return { handler, state, byKey, unlocked };
}

test('Retry on Fail after a lost unlock response charges nothing new', async () => {
	const rows = [row('a', '0.300000'), row('b', '0.300000'), row('c', '0.300000')];
	const server = idempotentServer(rows, { loseFirstUnlockResponse: true });
	const cap = 0.7;
	const params = sauParams(cap, { maxResults: 3 });

	// Attempt 1: preview, unlock a + b (0.6 of 0.7), then the response is lost.
	const first = fakeContext({ params, handler: server.handler, runIndex: 2 });
	await assert.rejects(run(first), /socket hang up/);
	assert.equal(server.state.charged, 600_000);

	// Attempt 2: n8n reruns the node in the same execution, same run index.
	const second = fakeContext({ params, handler: server.handler, runIndex: 2 });
	const [items] = await run(second);
	const keys = [first, second].map((c) => c.calls[0].headers['Idempotency-Key']);
	assert.equal(keys[0], keys[1], 'same key on retry');
	assert.equal(keys[0], 'n8n:exec-1:node-uuid:0:2');
	assert.equal(second.calls.length, 1, 'the replay makes no unlock call');
	assert.deepEqual(
		items.map((i) => i.json.id),
		['a', 'b'],
	);
	assert.equal(items[0].json.runSummary.alreadyUnlockedCost, '0.600000');
	assert.ok(server.state.charged <= cap * 1e6, `charged ${server.state.charged}`);
});

test('no Idempotency-Status on the preview: no purchase, and an error', async () => {
	const rows = [row('a', '0.300000')];
	const server = idempotentServer(rows, { honoursKey: false });
	const ctx = fakeContext({ params: sauParams(1), handler: server.handler });
	await assert.rejects(run(ctx), /no retry protection.*no purchase was made/);
	assert.equal(server.state.unlockCalls, 0);
	assert.equal(server.state.charged, 0);
	// An unknown status value is no better than none.
	const odd = fakeContext({
		params: sauParams(1),
		handler: () =>
			full(
				{ queryId: 'q', costToUnlockRemaining: '0', results: rows },
				{ 'Idempotency-Status': 'ignored' },
			),
	});
	await assert.rejects(run(odd), /no retry protection/);
	assert.equal(odd.calls.length, 1);
});

test('Idempotency-Status created and replayed both allow buying', async () => {
	for (const status of ['created', 'replayed', 'Created']) {
		const ctx = fakeContext({
			params: sauParams(1, { maxResults: 1 }),
			previewHeaders: { 'Idempotency-Status': status },
			handler: (path) => ({
				queryId: 'q',
				costToUnlockRemaining: '0.1',
				costCharged: path === '/unlock' ? '0.100000' : null,
				results: [row('a', '0.100000', path !== '/unlock')],
			}),
		});
		const [items] = await run(ctx);
		assert.equal(ctx.calls[1].url.endsWith('/unlock'), true, status);
		assert.equal(items[0].json.id, 'a');
	}
});

test('nothing to buy needs no retry protection', async () => {
	const ctx = fakeContext({
		params: sauParams(0),
		previewHeaders: {},
		handler: () => ({ queryId: 'q', costToUnlockRemaining: '0.5', results: [row('a', '0.5')] }),
	});
	const [items] = await run(ctx);
	assert.equal(ctx.calls.length, 1);
	assert.deepEqual(items[0].json.runSummary.deliveredIds, []);
});

test('regular node: the key ignores a re-evaluated body and changes per run', async () => {
	const handler = () => ({ queryId: 'q', costToUnlockRemaining: '0', results: [] });
	// Retry on Fail re-evaluates `{{ $now }}` in the query: same run index, same key.
	const a = fakeContext({
		params: sauParams(0, { query: 'news at 10:00:00' }),
		handler,
		runIndex: 0,
	});
	const b = fakeContext({
		params: sauParams(0, { query: 'news at 10:00:01' }),
		handler,
		runIndex: 0,
	});
	await run(a);
	await run(b);
	assert.equal(a.calls[0].headers['Idempotency-Key'], 'n8n:exec-1:node-uuid:0:0');
	assert.equal(a.calls[0].headers['Idempotency-Key'], b.calls[0].headers['Idempotency-Key']);
	// A loop iteration is a new run.
	const loop = fakeContext({ params: sauParams(0), handler, runIndex: 1 });
	await run(loop);
	assert.equal(loop.calls[0].headers['Idempotency-Key'], 'n8n:exec-1:node-uuid:0:1');
	// Two items in one run differ by item index.
	const two = fakeContext({ params: sauParams(0), handler, items: [{ json: {} }, { json: {} }] });
	await run(two);
	assert.notEqual(two.calls[0].headers['Idempotency-Key'], two.calls[1].headers['Idempotency-Key']);
	// No execution id, no key.
	const none = fakeContext({ params: sauParams(0), handler, executionId: '' });
	await run(none);
	assert.equal(none.calls[0].headers, undefined);
});

test('regular node: a retry whose body changed is refused by the server, never bought twice', async () => {
	const rows = [row('a', '0.300000')];
	const server = idempotentServer(rows, { loseFirstUnlockResponse: true });
	const first = fakeContext({
		params: sauParams(1, { query: 'news at 10:00:00' }),
		handler: server.handler,
	});
	await assert.rejects(run(first), /socket hang up/);
	const retry = fakeContext({
		params: sauParams(1, { query: 'news at 10:00:01' }),
		handler: server.handler,
	});
	await assert.rejects(run(retry), /IDEMPOTENCY_KEY_REUSED/);
	assert.equal(server.state.charged, 300_000);
});

test('AI tool: the key fingerprints the body canonically and ignores run index', async () => {
	const handler = () => ({ queryId: 'q', costToUnlockRemaining: '0', results: [] });
	const tool = (filters, runIndex, query = 'q') =>
		fakeContext({
			type: TOOL_TYPE,
			params: sauParams(0, { query, searchOptions: { filters } }),
			rawParams: {},
			handler,
			runIndex,
		});
	const a = tool({ journal: 'Nature', and: [{ field: 'x', gte: 1, lte: 2 }] }, 0);
	const b = tool('{"and":[{"lte":2,"gte":1,"field":"x"}],"journal":"Nature"}', 3);
	const c = tool({ journal: 'Nature' }, 0, 'another question');
	for (const ctx of [a, b, c]) await run(ctx);
	const [ka, kb, kc] = [a, b, c].map((ctx) => ctx.calls[0].headers['Idempotency-Key']);
	assert.match(ka, /^n8n:exec-1:node-uuid:0:[0-9a-f]{16}$/);
	assert.equal(ka, kb, 'reordered filter keys and a new run index give the same key');
	assert.notEqual(ka, kc, 'a different search gives a different key');
	assert.ok(ka.length <= 255);
});

test('prior spend is charged first: Astra case buys nothing on the second attempt', async () => {
	// A=$0.60 ranks above B=$0.40.
	const rows = [row('A', '0.600000'), row('B', '0.400000')];
	const server = idempotentServer(rows);
	const attempt1 = fakeContext({
		params: sauParams(0.5, { maxResults: 2 }),
		handler: server.handler,
	});
	await run(attempt1);
	// A, the better result, does not fit $0.50, so buying stops: B is not bought in its place.
	assert.deepEqual([...server.unlocked], []);
	assert.equal(server.state.charged, 0);
	// B is then bought by an explicit Unlock under the same queryId.
	server.handler('/unlock', { body: { queryId: 'q1', resultIds: ['B'] } });
	assert.equal(server.state.charged, 400_000);
	// Same key, cap raised to $0.70, Max Results 1: buying A would total $1.00.
	const attempt2 = fakeContext({
		params: sauParams(0.7, { maxResults: 1 }),
		handler: server.handler,
	});
	const [items] = await run(attempt2);
	assert.equal(server.state.unlockCalls, 1, 'no second unlock');
	assert.ok(server.state.charged <= 700_000);
	assert.deepEqual(
		items.map((i) => i.json.id),
		['B'],
	);
	assert.equal(items[0].json.runSummary.alreadyUnlockedCost, '0.400000');
});

test('Include Figures on a replay with nothing to buy fetches figures from Get Results', async () => {
	const rows = [row('a', '0.100000')];
	const server = idempotentServer(rows);
	const params = sauParams(1, { maxResults: 1, deliveryOptions: { includeFigures: true } });
	await run(fakeContext({ params, handler: server.handler }));
	const replay = fakeContext({ params, handler: server.handler });
	const [items] = await run(replay);
	assert.equal(server.state.unlockCalls, 1);
	assert.deepEqual(server.state.resultsCalls, [{ includeFigures: true }]);
	assert.equal(replay.calls[1].url, 'https://api.redpine.ai/api/v1/search/results/q1');
	assert.deepEqual(items[0].json.metadata, { figures: [{ image_data: 'base64' }] });
	assert.equal(
		items[0].json.costToUnlockRemaining,
		'0',
		'response fields still come from the preview',
	);
	// Without Include Figures there is no extra call.
	const plain = fakeContext({ params: sauParams(1, { maxResults: 1 }), handler: server.handler });
	await run(plain);
	assert.equal(plain.calls.length, 1);
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
