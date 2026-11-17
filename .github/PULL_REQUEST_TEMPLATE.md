<!-- Canonical source: redpine-ai/redpine-cc-plugin
     plugins/redpine-eng/skills/redpine-pr-standard/assets/PULL_REQUEST_TEMPLATE.md
     Re-sync with: scripts/sync-pr-standard.sh -->

## What changed

<!-- One or two sentences. What does this do, and why now? -->

## How it was verified

<!-- The command you ran and its output, the test that passed, the page you loaded.
     "Should work" is not verification. -->

---

**Before this can merge** (both are enforced, not suggestions):

- [ ] Exactly one `type:` label is applied. The `pr-type-label` check fails without it.
  - `type:feature` — new capability or user-visible behaviour
  - `type:bugfix` — corrects behaviour that was already meant to work
  - `type:hotfix` — urgent production fix, expedited
  - `type:chore` — dependencies, tooling, refactors, config, release plumbing
  - `type:docs` — documentation, runbooks, changelog
  - `type:security` — vulnerability fix, hardening, secret rotation
- [ ] Approved by someone other than the author. Self-merge is blocked for everyone, admins included.

<sub>These two gates are Redpine's SOC2 change-management control. If one is blocking something genuinely urgent, get a second person to approve — do not ask for the control to be disabled.</sub>
