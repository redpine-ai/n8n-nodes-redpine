# Changelog

## 0.1.1

- Search and Unlock buys only when the API confirms retry protection (`Idempotency-Status: created` or `replayed` on the preview); otherwise it fails without buying.
- The idempotency key on the regular node is execution, node, item and run index, so an expression re-evaluated on retry keeps the key; the AI tool path uses a canonical fingerprint of the search.
- Results already unlocked under the search are all charged to Max Cost before anything is bought; an unknown prior price buys nothing.
- Include Figures now returns figures when a retry finds every selected result already unlocked.

## 0.1.0

- Initial release: Search resource with Preview, Unlock, Search and Unlock, and Get Results operations; Redpine API credential.
