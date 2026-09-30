# @redpine-ai/n8n-nodes-redpine

This is an n8n community node. It lets you use [Redpine](https://redpine.ai) in your n8n workflows.

Redpine searches licensed publisher collections and open-access research, as full text rather than abstracts. Every result is cited to its source, and publishers are paid when their content is used.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/sustainable-use-license/) workflow automation platform.

[Installation](#installation)
[Credentials](#credentials)
[Operations](#operations)
[Costs](#costs)
[Usage](#usage)
[Compatibility](#compatibility)
[Resources](#resources)

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation. In **Settings > Community Nodes > Install**, enter the npm package name `@redpine-ai/n8n-nodes-redpine`.

## Credentials

The node authenticates with a Redpine API key.

1. Sign in to the [Redpine dashboard](https://app.redpine.ai).
2. Open **Settings > API Keys** and create a key. It starts with `sk_live_`.
3. In n8n, create a **Redpine API** credential and paste the key.

n8n tests the credential by reading the key's query quota, which is free.

## Operations

All operations are under the **Search** resource.

> **Warning: Unlock and Search and Unlock spend your Redpine credit balance.** Preview and Get Results are free.

### Preview (free)

Runs a search and returns every result as a teaser, with the price to unlock each one. It never charges, and works at a zero balance.

- **Query**: what to search for.
- **Collection Names or IDs**: required, 1 to 5 collections. Pick them from the list, which shows the collections your key can search, or give names with an expression, for example `{{ ["redpine-science"] }}`. There is no default collection; an empty selection is refused before any request.
- **Options**
  - **Filters (JSON)**: metadata filters, passed to the API unchanged, for example `{"journal": "Nature"}` or `{"and": [{"field": "publication_date", "gte": "2020-01-01"}]}`. See the [API docs](https://docs.redpine.ai) for the fields and operators.
  - **Number of Results**: 1 to 30, default 10.

Output: one item per result (`id`, `text`, `metadata`, `collection`, `locked`, `figureCount`, `tokens`, `cost`), each also carrying the response fields `queryId`, `costToUnlockRemaining`, `costCharged` and, when present, `filterWarnings` and `filtersApplied`. When the search matches nothing, the node outputs one item with only the response fields, so the `queryId` and any filter warnings are not lost.

`cost` is the price in US dollars to unlock that result, as a decimal string. A `null` cost means the price is unknown, not that the result is free.

### Unlock (spends credit)

Buys the full text of results from an earlier Preview.

- **Query ID**: the `queryId` from the Preview.
- **Result IDs**: comma-separated result IDs, or an expression returning an array. Required and never empty: the node always names the results it buys, and there is no "unlock everything" option.
- **Options > Include Figures**: return figure images as base64 in each result's metadata. Free, but responses get larger.

You are charged only for results not already unlocked; re-sending an ID costs nothing. Output: one item per requested result, with `costCharged` set to what this call charged.

Unlock is not capped, so it is not available when the node runs as an AI Agent tool.

### Search and Unlock (spends credit, capped)

The unattended path: preview, then buy the best results that fit within a cost cap, in one step.

- **Query**, **Options**: as for Preview. Number of Results here sets how many candidates to choose from; it defaults to 10 or Max Results, whichever is larger.
- **Max Results**: the most results to deliver.
- **Max Cost Per Run (USD)**: the most this node may charge per input item, retries included (see below). Default 0, which buys nothing.

How results are chosen, walking the preview in relevance order:

1. Locked results with a known cost are bought while the running total stays within Max Cost. A result that would go over is skipped and the walk continues, so a cheaper result further down can still fit.
2. Locked results with an unknown (`null`) cost are skipped. Unknown does not mean free.
3. Results that are already unlocked are delivered, and their price counts against both Max Cost and Max Results (see Retries). An already-unlocked result with an unknown price uses up the rest of the budget.
4. The walk stops once Max Results are kept.

The node then unlocks only the chosen locked results. If there are none, it makes no unlock call.

Costs are added up in whole microdollars, never floating point. Each result counted also reserves one microdollar, including results priced at $0.000000: the API charges each collection's results as one rounded sum rather than the sum of the listed prices, and the two differ by less than one microdollar per result. What is guaranteed: for the results this node buys, the API's charge is at most the listed prices plus one microdollar each, and that total is at most Max Cost. At a Max Cost of 0 nothing is bought.

#### Retries

With **Retry on Fail**, a retry after an unlock whose response was lost could otherwise buy again. The node sends an `Idempotency-Key` header on the Search and Unlock preview, built from the execution id, the node id, the item index and a fingerprint of the search. A retry within the same execution sends the same key, the API returns the same `queryId` with the results the failed attempt bought already unlocked, and because those count against Max Cost the retry selects the same results and is charged nothing new.

Limits:

- A manual re-run of a failed execution gets a new execution id, so a new key and a new preview. It can buy up to Max Cost again.
- The same search at the same item position, repeated within one execution (for example in a loop), reuses the first search's results and buys nothing new.
- An API version without idempotency support ignores the header; a retry then previews afresh and can buy up to Max Cost again.

Output: one item per delivered result, each with a `runSummary` object: `maxResults`, `maxCost`, `quotedCost` (sum of the prices of results bought by this run), `alreadyUnlockedCost` (sum of the prices of results that arrived already unlocked; `null` if any had no price), `costCharged` (what the API charged this run), `deliveredIds`, `unlockedIds` and `skipped` (each with a reason: `maxResults`, `unknownCost` or `overBudget`). When nothing is delivered, one item with the response fields and the `runSummary`.

### Get Results (free)

Re-fetches the results of an earlier search by **Query ID**, free for 7 days. Results you have unlocked come back in full; the rest stay as teasers. **Options > Include Figures** returns figures for the unlocked results.

## Costs

Prices are set per collection and quoted per result in US dollars. Preview shows each result's price before you pay, and `costToUnlockRemaining` shows what unlocking everything still locked would cost. Check your balance and usage in the [Redpine dashboard](https://app.redpine.ai).

## Usage

The node can be used as a tool by the n8n AI Agent (the **Redpine Tool** node). As a tool it runs only **Preview**, **Get Results** and **Search and Unlock**; **Unlock** is refused. For Search and Unlock, **Max Cost Per Run** must be a fixed number: an expression, including `$fromAI()`, is refused, because the model supplies the tool's input and could otherwise set its own budget.

With **Continue On Fail**, a failed item outputs `error` (the message), `code` (the Redpine error code, such as a balance or validation error), `httpStatus` and `requestId`, paired to the input item.

A typical manual workflow: **Preview**, inspect or filter the items (for example on `cost` or `metadata.journal`), then **Unlock** with the preview's `queryId` and the chosen IDs.

## Compatibility

Built and tested with n8n 2.x (`n8n-workflow` 2.41) on Node.js 24 and later.

## Resources

- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)
- [Redpine API documentation](https://docs.redpine.ai)
- [Redpine dashboard](https://app.redpine.ai)
