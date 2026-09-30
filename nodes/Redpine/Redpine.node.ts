import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	INode,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { formatMicros, parseUsdToMicros, selectWithinBudget } from './select';

const SEARCH_URL = 'https://api.redpine.ai/api/v1/search';
const MAX_COLLECTIONS = 5;

interface SearchResponse extends IDataObject {
	queryId: string;
	results: Array<IDataObject & { id: string; locked: boolean; cost?: string | null }>;
}

type RequestContext = IExecuteFunctions | ILoadOptionsFunctions;

// Every Redpine HTTP call goes through here, which makes it the one place to
// enforce that an unlock always names the results it buys: the API reads a
// missing resultIds as "unlock everything".
async function redpineRequest(
	this: RequestContext,
	method: IHttpRequestMethods,
	path: string,
	body?: IDataObject,
	qs?: IDataObject,
	headers?: IDataObject,
) {
	if (path === '/unlock') {
		const ids = body?.resultIds;
		if (
			!Array.isArray(ids) ||
			ids.length === 0 ||
			!ids.every((id) => typeof id === 'string' && id)
		) {
			throw new NodeOperationError(
				this.getNode(),
				'Refusing to unlock without a list of result IDs',
			);
		}
	}
	return this.helpers.httpRequestWithAuthentication.call(this, 'redpineApi', {
		method,
		url: `${SEARCH_URL}${path}`,
		body,
		qs,
		headers,
		json: true,
	});
}

// FNV-1a, twice with different offsets for 64 bits. Only has to tell apart the
// request bodies one node sends for one item within one execution.
function fingerprint(text: string): string {
	let a = 0x811c9dc5;
	let b = 0x01000193 ^ 0x9e3779b9;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		a = Math.imul(a ^ c, 0x01000193);
		b = Math.imul(b ^ c, 0x01000193);
	}
	return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/**
 * Idempotency key for the Search and Unlock preview. Retry on Fail reruns the
 * node inside the same execution with the same execution id and node id
 * (n8n-core WorkflowExecute retry loop; the AI tool path retries in
 * get-input-connection-data), so a retry replays the first attempt's queryId
 * and its unlock ledger instead of starting a new preview and buying again.
 *
 * The body fingerprint keeps distinct searches apart where run index cannot:
 * an AI Agent calling this tool twice, or a loop, reuses execution, node and
 * item index, and the tool path bumps its run index on every retry.
 */
function idempotencyKey(executionId: string, nodeId: string, itemIndex: number, body: IDataObject) {
	return `n8n:${executionId}:${nodeId}:${itemIndex}:${fingerprint(JSON.stringify(body))}`;
}

/**
 * The auto-generated AI tool variant of this node has the type
 * `<package>.redpineTool`; n8n-workflow's isToolType applies the same suffix
 * rule. It runs this same execute() with the model's tool arguments as the
 * input item.
 */
function isToolCall(node: INode): boolean {
	return (node.type.split('.').pop() ?? '').endsWith('Tool');
}

function isExpression(value: unknown): boolean {
	return typeof value === 'string' && value.startsWith('=');
}

/** Message, code and HTTP status from a Redpine `{error: {code, message}}` response. */
function describeError(error: unknown): IDataObject {
	const e = (error ?? {}) as {
		message?: string;
		description?: string | null;
		httpCode?: string | null;
		context?: { data?: unknown };
		response?: { status?: number; data?: unknown };
	};
	const data = (e.context?.data ?? e.response?.data) as { error?: unknown } | undefined;
	const envelope =
		data && typeof data.error === 'object' && data.error !== null
			? (data.error as { code?: string; message?: string; requestId?: string })
			: undefined;
	const status = Number(e.httpCode ?? e.response?.status);
	return {
		error: envelope?.message ?? e.description ?? e.message ?? String(error),
		code: envelope?.code ?? null,
		httpStatus: Number.isInteger(status) && status > 0 ? status : null,
		requestId: envelope?.requestId ?? null,
	};
}

/**
 * One output item per result, each carrying the response-level fields
 * (queryId, costs, filter diagnostics). With no results, a single item with
 * just the response-level fields, so filter warnings and the queryId are not
 * lost when a search matches nothing.
 */
function toItems(response: SearchResponse, onlyIds: Set<string> | null, extra: IDataObject = {}) {
	const { results, ...rest } = response;
	const rows = onlyIds ? results.filter((row) => onlyIds.has(row.id)) : results;
	if (rows.length === 0) return [{ ...rest, ...extra }];
	return rows.map((row) => ({ ...row, ...rest, ...extra }));
}

function parseIds(node: INode, value: unknown, itemIndex: number): string[] {
	let raw: unknown[];
	if (Array.isArray(value)) raw = value;
	else if (typeof value === 'string') raw = value.split(',');
	else if (typeof value === 'number') raw = [value];
	else raw = [null];
	const ids: string[] = [];
	for (const id of raw) {
		if (typeof id !== 'string' && typeof id !== 'number') {
			throw new NodeOperationError(
				node,
				'Result IDs must be a comma-separated list or an array of IDs',
				{ itemIndex },
			);
		}
		const trimmed = String(id).trim();
		if (trimmed) ids.push(trimmed);
	}
	if (ids.length === 0) {
		throw new NodeOperationError(node, 'Result IDs is empty. List the IDs to unlock.', {
			itemIndex,
		});
	}
	return ids;
}

// The API requires exactly one of `collection` / `collections`; it has no default.
function parseCollections(node: INode, value: unknown, itemIndex: number): string[] {
	const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
	const names = [
		...new Set(raw.map((name) => (typeof name === 'string' ? name.trim() : ''))),
	].filter((name) => name !== '');
	if (names.length === 0) {
		throw new NodeOperationError(node, 'Choose at least one collection to search', { itemIndex });
	}
	if (names.length > MAX_COLLECTIONS) {
		throw new NodeOperationError(node, `Choose at most ${MAX_COLLECTIONS} collections`, {
			itemIndex,
		});
	}
	return names;
}

function parseFilters(node: INode, value: unknown, itemIndex: number): IDataObject | undefined {
	let parsed = value;
	if (typeof value === 'string') {
		try {
			parsed = value.trim() ? JSON.parse(value) : undefined;
		} catch (error) {
			throw new NodeOperationError(node, `Filters is not valid JSON: ${(error as Error).message}`, {
				itemIndex,
			});
		}
	}
	if (parsed === null || parsed === undefined) return undefined;
	if (typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new NodeOperationError(node, 'Filters must be a JSON object', { itemIndex });
	}
	return Object.keys(parsed).length ? (parsed as IDataObject) : undefined;
}

export class Redpine implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Redpine',
		name: 'redpine',
		icon: { light: 'file:redpine.svg', dark: 'file:redpine.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			'Search licensed publisher collections and open-access research as cited full text',
		defaults: {
			name: 'Redpine',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'redpineApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [{ name: 'Search', value: 'search' }],
				default: 'search',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['search'] } },
				options: [
					{
						name: 'Get Results',
						value: 'getResults',
						description: 'Re-fetch the results of an earlier search, free for 7 days',
						action: 'Get search results',
					},
					{
						name: 'Preview',
						value: 'preview',
						description: 'Search and return teasers with per-result prices. Free.',
						action: 'Preview search results',
					},
					{
						name: 'Search and Unlock',
						value: 'searchAndUnlock',
						description:
							'Preview, then buy the full text of the top results within a cost cap. Spends credit.',
						action: 'Search and unlock results',
					},
					{
						name: 'Unlock',
						value: 'unlock',
						description:
							'Buy the full text of previewed results. Spends credit. Not available to an AI Agent.',
						action: 'Unlock search results',
					},
				],
				default: 'preview',
			},
			{
				displayName: 'Query',
				name: 'query',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'e.g. GLP-1 agonists and cardiovascular outcomes',
				description: 'What to search for, in natural language',
				displayOptions: {
					show: { resource: ['search'], operation: ['preview', 'searchAndUnlock'] },
				},
			},
			{
				displayName: 'Collection Names or IDs',
				name: 'collections',
				type: 'multiOptions',
				typeOptions: { loadOptionsMethod: 'getCollections' },
				required: true,
				default: [],
				description:
					'Collections to search, 1 to 5; as an expression, e.g. {{ ["redpine-science"] }}. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				displayOptions: {
					show: { resource: ['search'], operation: ['preview', 'searchAndUnlock'] },
				},
			},
			{
				displayName: 'Max Results',
				name: 'maxResults',
				type: 'number',
				required: true,
				typeOptions: { minValue: 1, maxValue: 30 },
				default: 3,
				description: 'Most results to deliver, already-unlocked ones included',
				displayOptions: { show: { resource: ['search'], operation: ['searchAndUnlock'] } },
			},
			{
				displayName: 'Max Cost Per Run (USD)',
				name: 'maxCost',
				type: 'number',
				required: true,
				typeOptions: { minValue: 0, numberPrecision: 6 },
				default: 0,
				description:
					'Most this node may charge per input item, in US dollars, retries included. Results that would go over the cap are skipped; at 0 nothing is bought. As an AI tool this must be a fixed number, not an expression.',
				displayOptions: { show: { resource: ['search'], operation: ['searchAndUnlock'] } },
			},
			{
				displayName: 'Query ID',
				name: 'queryId',
				type: 'string',
				required: true,
				default: '',
				description: 'The queryId returned by a Preview',
				displayOptions: { show: { resource: ['search'], operation: ['unlock', 'getResults'] } },
			},
			{
				displayName: 'Result IDs',
				name: 'resultIds',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'e.g. id1, id2',
				description:
					'Comma-separated result IDs from the preview, or an expression returning an array',
				displayOptions: {
					show: { resource: ['search'], operation: ['unlock'] },
				},
			},
			{
				displayName: 'Options',
				name: 'searchOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: {
					show: { resource: ['search'], operation: ['preview', 'searchAndUnlock'] },
				},
				options: [
					{
						displayName: 'Filters (JSON)',
						name: 'filters',
						type: 'json',
						default: '{}',
						description:
							'Metadata filters, e.g. {"journal": "Nature"} or {"and": [{"field": "publication_date", "gte": "2020-01-01"}]}',
					},
					{
						displayName: 'Number of Results',
						name: 'resultCount',
						type: 'number',
						typeOptions: { minValue: 1, maxValue: 30 },
						default: 10,
						description:
							'How many results the search returns, 1 to 30. For Search and Unlock, the candidates to choose from; defaults to 10 or Max Results, whichever is larger.',
					},
				],
			},
			{
				displayName: 'Options',
				name: 'deliveryOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: {
					show: { resource: ['search'], operation: ['unlock', 'searchAndUnlock', 'getResults'] },
				},
				options: [
					{
						displayName: 'Include Figures',
						name: 'includeFigures',
						type: 'boolean',
						default: false,
						description:
							"Whether to return figure images, as base64 in each unlocked result's metadata. Free, but makes responses larger.",
					},
				],
			},
		],
	};

	methods = {
		loadOptions: {
			async getCollections(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const response = (await redpineRequest.call(this, 'GET', '/collections')) as {
					collections: Array<{ name: string; description?: string | null }>;
				};
				return response.collections.map((collection) => ({
					name: collection.name,
					value: collection.name,
					description: collection.description ?? undefined,
				}));
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const operation = this.getNodeParameter('operation', i) as string;
				let output: IDataObject[];

				// As an AI tool the model fills the parameters, so it must not reach an
				// uncapped purchase or set its own cap.
				if (isToolCall(this.getNode())) {
					if (
						operation !== 'preview' &&
						operation !== 'getResults' &&
						operation !== 'searchAndUnlock'
					) {
						throw new NodeOperationError(
							this.getNode(),
							'Unlock is not available to an AI Agent. Use Search and Unlock, which is capped by Max Cost.',
							{ itemIndex: i },
						);
					}
					if (operation === 'searchAndUnlock' && isExpression(this.getNode().parameters.maxCost)) {
						throw new NodeOperationError(
							this.getNode(),
							'As an AI tool, Max Cost Per Run must be a fixed number set by the workflow, not an expression',
							{ itemIndex: i },
						);
					}
				}

				if (operation === 'getResults') {
					const queryId = this.getNodeParameter('queryId', i) as string;
					const { includeFigures } = this.getNodeParameter('deliveryOptions', i) as IDataObject;
					const response = (await redpineRequest.call(
						this,
						'GET',
						`/results/${encodeURIComponent(queryId)}`,
						undefined,
						includeFigures ? { includeFigures: true } : undefined,
					)) as SearchResponse;
					output = toItems(response, null);
				} else if (operation === 'unlock') {
					const queryId = this.getNodeParameter('queryId', i) as string;
					const { includeFigures } = this.getNodeParameter('deliveryOptions', i) as IDataObject;
					const ids = parseIds(this.getNode(), this.getNodeParameter('resultIds', i), i);
					const response = (await redpineRequest.call(this, 'POST', '/unlock', {
						queryId,
						resultIds: ids,
						includeFigures: includeFigures === true,
					})) as SearchResponse;
					output = toItems(response, new Set(ids));
				} else {
					const query = this.getNodeParameter('query', i) as string;
					const options = this.getNodeParameter('searchOptions', i) as IDataObject;
					const collections = parseCollections(
						this.getNode(),
						this.getNodeParameter('collections', i),
						i,
					);
					const filters = parseFilters(this.getNode(), options.filters, i);

					const body: IDataObject = { query };
					if (collections.length === 1) body.collection = collections[0];
					if (collections.length > 1) body.collections = collections;
					if (filters) body.filters = filters;

					if (operation === 'preview') {
						if (options.resultCount !== undefined) body.limit = options.resultCount;
						const response = (await redpineRequest.call(
							this,
							'POST',
							'/preview',
							body,
						)) as SearchResponse;
						output = toItems(response, null);
					} else {
						const maxResults = this.getNodeParameter('maxResults', i) as number;
						const maxCost = this.getNodeParameter('maxCost', i) as number;
						const { includeFigures } = this.getNodeParameter('deliveryOptions', i) as IDataObject;
						// Budget rounds down past six decimals, so a float like 0.1 + 0.2 never loosens it.
						if (!(Number(maxCost) >= 0)) {
							throw new NodeOperationError(this.getNode(), 'Max Cost Per Run must be 0 or more', {
								itemIndex: i,
							});
						}
						const maxCostMicros = parseUsdToMicros(maxCost, false);
						body.limit = options.resultCount ?? Math.max(10, maxResults);

						const executionId = this.getExecutionId();
						const headers = executionId
							? { 'Idempotency-Key': idempotencyKey(executionId, this.getNode().id, i, body) }
							: undefined;
						const preview = (await redpineRequest.call(
							this,
							'POST',
							'/preview',
							body,
							undefined,
							headers,
						)) as SearchResponse;
						const selection = selectWithinBudget(preview.results, maxResults, maxCostMicros);

						// Skip the unlock call when every kept result is already unlocked. On an
						// idempotent retry those are the rows the failed attempt already bought.
						let response = preview;
						if (selection.toUnlock.length > 0) {
							response = (await redpineRequest.call(this, 'POST', '/unlock', {
								queryId: preview.queryId,
								resultIds: selection.toUnlock,
								includeFigures: includeFigures === true,
							})) as SearchResponse;
						}

						output = toItems(response, new Set(selection.keep), {
							runSummary: {
								maxResults,
								maxCost: formatMicros(maxCostMicros),
								quotedCost: formatMicros(selection.quotedMicros),
								alreadyUnlockedCost: selection.priorUnknown
									? null
									: formatMicros(selection.priorMicros),
								costCharged: selection.toUnlock.length > 0 ? (response.costCharged ?? '0') : '0',
								deliveredIds: selection.keep,
								unlockedIds: selection.toUnlock,
								skipped: selection.skipped,
							},
						});
					}
				}

				returnData.push(...output.map((json) => ({ json, pairedItem: { item: i } })));
			} catch (error) {
				// Errors that are already node errors ignore a new itemIndex, so set it here.
				if (error instanceof NodeApiError || error instanceof NodeOperationError) {
					error.context.itemIndex = i;
				}
				if (this.continueOnFail()) {
					returnData.push({ json: describeError(error), pairedItem: { item: i } });
					continue;
				}
				// Both constructors hand back an error that is already of their own type.
				if (error instanceof NodeOperationError) {
					throw new NodeOperationError(this.getNode(), error, { itemIndex: i });
				}
				throw new NodeApiError(this.getNode(), error as JsonObject, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
