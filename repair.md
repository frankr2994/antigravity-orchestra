# Deferred Repairs and Phase Review Log

## Purpose

This file tracks adjustments discovered while reviewing implementation phases. Findings are recorded when discovered and intentionally deferred until the planned final repair pass.

Implementation and tests should not be changed during a phase review unless a finding prevents the review itself from being completed.

## Status legend

- `Open`: Confirmed adjustment that has not been addressed.
- `Recheck`: A later phase may have addressed the finding; confirm during final repair.
- `Resolved`: The adjustment was implemented and verified.
- `Accepted`: The behavior was deliberately retained with a documented reason.

## Findings index

| ID | Phase | Commit | Severity | Status | Area | Summary |
|---|---:|---|---|---|---|---|
| R-001 | 1 | `2f66be7` | High | Open | Task states | The state-machine test validates a hand-written, incomplete list rather than the real task-state contract or transitions. |
| R-002 | 1 | `2f66be7` | High | Open | SSE events | The SSE contract test validates invented constants and payloads that differ from events emitted by the application. |
| R-003 | 1 | `2f66be7` | High | Open | Workflow coverage | The promised end-to-end local workflow baseline is not exercised. |
| R-004 | 1 | `2f66be7` | Medium | Open | Baseline record | The commit does not record the original lint, build, and test baseline or identify pre-existing failures. |
| R-005 | 1 | `2f66be7` | Medium | Open | Compatibility | Supported compatibility behavior is not explicitly documented. |
| R-006 | 1 | `2f66be7` | Medium | Open | Documentation | The obsolete `jules.txt` plan was committed beside `julesplan.md`, leaving two conflicting plans. |
| R-007 | 1 | `2f66be7` | Low | Open | Test stability | Routing assertions freeze exact model version strings rather than a stable routing-policy contract. |
| R-008 | 2 | `7574a1f` | High | Open | Boundary enforcement | Architecture checks pass vacuously for absent layers and can miss common prohibited-import and persistence patterns. |
| R-009 | 2 | `7574a1f` | High | Open | Secret redaction | The redaction test recognizes sample secret strings but never passes them through production redaction or event/logging code. |
| R-010 | 2 | `7574a1f` | Medium | Open | Circular dependencies | The documentation claims circular dependencies are checked, but the architecture suite contains no cycle detection. |
| R-011 | 2 | `7574a1f` | Medium | Open | State contracts | The documented and tested Orchestra state list is incomplete and disconnected from the production task-state type. |
| R-012 | 2 | `7574a1f` | Medium | Open | Transition architecture | The document presents the target module layout as current and enforced without defining legacy exceptions or a migration ratchet. |

## Phase 1 review

### Review scope

- Reviewed commit: `2f66be77885506a059f98aee0aa809862276b966`
- Commit subject: `test(baseline): establish phase 1 behavioral baseline & characterization tests`
- Primary implementation artifact reviewed: `orchestra-dashboard/tests/characterization-baseline.test.mjs`
- Review date: 2026-08-22
- Review policy: Findings recorded only; implementation repairs deferred.

### Verification performed

- `npm test`: passed after running outside the restricted sandbox required by Node's test-worker process spawning.
- `npm run check`: passed on descendant commit `7574a1f` with 73 tests, zero failures.
- The only changes between `2f66be7` and `7574a1f` are the Phase 2 architecture document and architecture test file; the Phase 1 test and application implementation are unchanged.
- The initial sandboxed test attempt failed with `spawn EPERM`; this was an execution-environment restriction, not a repository failure.

### R-001 — State-machine test does not test the real state machine

Severity: **High**
Status: **Open**

Evidence:

- `characterization-baseline.test.mjs:16-44` creates a local `validStates` array and only checks that each entry is a string.
- The list omits current task states including `preflight`, `routing`, `summarizing`, `committing`, and `pushing`.
- The test does not prove that the entries belong to `TaskState` or that transitions between them are valid.
- The fixture test changes task states directly through `Store.updateTask`, which bypasses workflow transition behavior.

Risk:

- State names or transitions can regress while the characterization suite continues to pass.
- Later modularization could preserve the test while accidentally changing observable workflow behavior.

Deferred adjustment:

- Centralize runtime task-state and transition definitions.
- Derive tests from the production contract instead of duplicating strings.
- Test allowed and rejected transitions through the workflow boundary.
- Include every current state and intentional terminal-state rule.

### R-002 — SSE contract test is disconnected from actual events

Severity: **High**
Status: **Open**

Evidence:

- `characterization-baseline.test.mjs:46-117` defines a private event registry that is never imported by the server or UI.
- It lists `stream`, while the task manager emits `agent.output`.
- It lists `review.started`, `review.completed`, and `review.verdict`, but the current review workflow reports review work through `agent.started` and `agent.completed` payloads.
- It omits emitted or consumed events such as `task.error`, `task.recovery-required`, `task.review-disputed`, `task.repair-progress`, `task.implementation-retry`, `task.continuation`, `provider.telemetry`, `verification.result`, and `agent.output`.
- Its payload checks validate standalone sample objects rather than payloads produced by application code.

Risk:

- Server and UI event contracts can drift without a failing test.
- Future Jules event translation could target a false baseline.

Deferred adjustment:

- Introduce a shared production event contract with typed payloads.
- Make server emission and UI consumption depend on that contract.
- Capture real emitted events in characterization tests and validate ordering and payload shape.
- Add a compatibility test that fails when an emitted event is unknown to the UI.

### R-003 — Complete local workflow behavior is not characterized

Severity: **High**  
Status: **Open**

Evidence:

- The Phase 1 plan requires coverage for task creation, routing, execution, review, verification, recovery, commit, and push behavior.
- The new suite tests persistence helpers, classification helpers, review-packet parsing, evidence collection, and one recovery helper.
- Successful and failed tasks are manufactured by writing terminal states directly to SQLite.
- No test submits a task through the application workflow and observes the worker, review, verification, Git finalization, and resulting SSE sequence.
- Commit and push behavior are not exercised by the new Phase 1 suite.

Risk:

- The modular refactor can break orchestration between individually tested helpers while all baseline tests remain green.

Deferred adjustment:

- Add a deterministic TaskManager/API integration harness with fake provider and Git adapters.
- Cover at least successful, provider-failed, interrupted, verification-failed/repaired, disputed, committed, and unpushed outcomes.
- Assert persisted state, messages, event ordering, verification input, and Git actions for each scenario.

### R-004 — Original verification baseline was not recorded

Severity: **Medium**
Status: **Open**

Evidence:

- Phase 1 requires running and recording the existing build, lint, and tests before structural changes.
- Commit `2f66be7` adds plans and tests but no dated baseline report or recorded results.
- A green check was established during this review, after Phase 2 had already been committed.

Risk:

- Later failures cannot be reliably classified as pre-existing versus introduced after Phase 1.

Deferred adjustment:

- Add a concise baseline record with commit SHA, date, environment, commands, results, known warnings, and known failures.
- Clearly distinguish the historical Phase 1 baseline from later review results.

### R-005 — Compatibility behavior is implicit

Severity: **Medium**
Status: **Open**

Evidence:

- Phase 1 requires identifying supported compatibility behavior that must not change.
- No explicit compatibility inventory was added for API responses, task states, SSE contracts, persistence, restart behavior, Git outcomes, or UI expectations.

Risk:

- Later phases will have no agreed boundary between intentional improvements and regressions.

Deferred adjustment:

- Document the public and persisted behaviors that must survive modularization.
- Label accidental implementation details as non-contractual so tests do not freeze them unnecessarily.

### R-006 — Two conflicting Jules plans are present

Severity: **Medium**
Status: **Open**

Evidence:

- Commit `2f66be7` adds both `jules.txt` and `julesplan.md`.
- `jules.txt` contains the earlier ten-phase design and API assumptions already superseded by the corrected 29-phase modular plan.

Risk:

- Contributors may implement obsolete states, streaming/webhook assumptions, branch metadata, credential storage, or locking behavior from the wrong document.

Deferred adjustment:

- Designate `julesplan.md` as the sole implementation plan.
- Remove or clearly archive `jules.txt` with an explicit superseded notice.
- Update references to point only to the authoritative plan.

### R-007 — Model-version assertions are unnecessarily brittle

Severity: **Low**  
Status: **Open**

Evidence:

- `characterization-baseline.test.mjs:189-202` asserts exact model IDs such as `gemini-3.7-flash-high` and `gpt-5.6-sol`.
- Model versions and availability can change without altering the intended routing behavior.

Risk:

- A legitimate model-policy update can break a behavioral baseline test unrelated to the Jules modularization.

Deferred adjustment:

- Test stable routing properties, provider roles, and effort/risk tiers.
- Keep exact model-ID assertions only where the version itself is an intentional compatibility contract.

## Phase 2 review

### Review scope

- Reviewed commit: `7574a1f7849313585064f4344dffb9d9e3b58574`
- Commit subject: `docs(arch): establish phase 2 modularity rules & automated architecture boundary tests`
- Primary artifacts reviewed: `docs/ARCHITECTURE.md` and `orchestra-dashboard/tests/architecture-rules.test.mjs`
- Review date: 2026-08-22
- Review policy: Findings recorded only; implementation repairs deferred.

### Verification performed

- `npm run check` passed on commit `7574a1f` during the immediately preceding phase review.
- Result at that commit: lint passed, production build passed, and 73 tests passed with zero failures.
- The architecture suite's three tests passed, but the findings below concern what those passing tests do not verify.
- Review of Phase 2 remained anchored to commit `7574a1f` after the workspace advanced concurrently to the Phase 3 commit.

### R-008 — Boundary checks are incomplete and partly vacuous

Severity: **High**  
Status: **Open**

Evidence:

- At commit `7574a1f`, the target `server/domain`, `server/application`, `server/providers`, `server/infrastructure`, and `server/api/routes` trees did not yet exist.
- `architecture-rules.test.mjs:43-45` detects only the literal single-quoted prefixes `from '../infrastructure` and `from '../providers`.
- That check misses nested paths such as `../../infrastructure`, double-quoted imports, aliases, dynamic imports, `require`, imports from `application` or `api`, and other prohibited dependency directions documented for the domain.
- `architecture-rules.test.mjs:50-53` scans only future route directories and detects only `.prepare(`, uppercase `SELECT`, and uppercase `INSERT INTO`.
- It does not detect lower-case SQL, `UPDATE`, `DELETE`, `CREATE`, `db.exec`, indirect singleton access, or business logic unrelated to raw SQL.
- No check enforces the documented provider prohibition on database writes, generic-task isolation from raw provider responses, frontend type ownership, or modular feature placement.

Risk:

- The suite can remain green while prohibited dependencies and new monolithic code are introduced.
- A passing architecture check may provide false confidence during the modularization phases.

Deferred adjustment:

- Parse actual module imports with a dependency-graph tool or TypeScript-aware parser rather than substring matching.
- Express allowed layer-to-layer edges and fail on every disallowed edge.
- Add intentionally invalid fixture modules to prove each rule can fail.
- Cover server and frontend boundaries, provider persistence access, route responsibilities, and raw provider-type leakage.
- Use a ratcheting rule so legacy files can be migrated without permitting new violations.

### R-009 — Secret-redaction test does not test redaction

Severity: **High**  
Status: **Open**

Evidence:

- `architecture-rules.test.mjs:102-113` constructs raw secret strings and asserts that each raw string matches a regular expression.
- It does not call the production secret-redaction function.
- It does not assert that output is sanitized or that the original value is absent.
- It does not exercise logging, error serialization, persisted task events, or SSE output despite the test name referring to loggers and event streams.
- The plaintext-storage scan at lines 56-59 recognizes only one exact SQL statement and can be bypassed through the existing settings API or any alternate SQL shape.

Risk:

- API keys and authenticated URLs could leak while the architecture test continues to pass.

Deferred adjustment:

- Pass every secret fixture through the production redactor and assert both masking and absence of the original value.
- Test redaction at logging, error, task-event, and SSE boundaries.
- Prevent secret persistence through a typed settings/credentials boundary rather than searching for one SQL string.

### R-010 — Circular dependencies are not checked

Severity: **Medium**  
Status: **Open**

Evidence:

- Phase 2 acceptance criteria require circular dependencies to be rejected by linting, tests, or architecture checks.
- `docs/ARCHITECTURE.md` states that `architecture-rules.test.mjs` verifies circular dependencies.
- The test only scans source text for three groups of string patterns and never builds or traverses an import graph.

Risk:

- Circular dependencies can be introduced during module extraction even though the advertised architecture gate passes.

Deferred adjustment:

- Generate an import graph for server and frontend source roots.
- Fail with the complete cycle path when a cycle is detected.
- Include a deliberately cyclic fixture to verify that the gate works.

### R-011 — Architecture state hierarchy is incomplete and self-validating

Severity: **Medium**  
Status: **Open**

Evidence:

- `docs/ARCHITECTURE.md` omits existing Orchestra states `preflight`, `routing`, `summarizing`, `committing`, and `pushing`.
- `architecture-rules.test.mjs:67-100` repeats the same incomplete Orchestra state list in a private array.
- The test merely verifies that uppercase Jules strings do not equal lowercase Orchestra strings.
- It imports neither the production task-state contract nor a real Jules mapping function.

Risk:

- The architecture document and tests can drift from production while remaining green.
- The test does not prove provider-state isolation or correct mapping behavior.

Deferred adjustment:

- Make the architecture document reference the canonical domain contract instead of duplicating it.
- Derive state tests from production exports.
- Verify every Jules state mapping, unknown-state behavior, and provider/domain separation through real adapter boundaries.
- Coordinate this repair with Phase 1 finding R-001.

### R-012 — Target architecture is described as already enforced

Severity: **Medium**  
Status: **Open**

Evidence:

- `docs/ARCHITECTURE.md` says Orchestra “follows” the proposed architecture and “enforces” the state hierarchy even though most target directories did not exist at Phase 2.
- It says all changes are automatically validated against the boundaries, while the checks do not cover several documented rules.
- No transitional architecture section identifies legacy monoliths, temporary exceptions, ownership, or the phase in which each exception must disappear.

Risk:

- Contributors cannot tell which rules are current invariants and which are desired end-state rules.
- Existing violations may be normalized, while new violations cannot be distinguished from migration work.

Deferred adjustment:

- Label the diagram and module trees explicitly as the target architecture.
- Add a current-state inventory and bounded legacy exception list.
- Assign each exception a removal phase and prevent the exception count from increasing.
- Update enforcement claims to match what automated checks actually validate.

## Future phase review template

Copy the following block for each reviewed phase:

```markdown
## Phase N review

### Review scope

- Reviewed commit:
- Commit subject:
- Review date:
- Verification performed:

### R-XXX — Finding title

Severity: **High | Medium | Low**  
Status: **Open**

Evidence:

- Concrete file, line, command, or observed behavior.

Risk:

- Why the finding matters.

Deferred adjustment:

- The change to consider during the final repair pass.
```

## Final repair pass checklist

- Revalidate every `Open` and `Recheck` item against the final implementation.
- Combine overlapping repairs so fixes respect the final module boundaries.
- Add or update regression tests before changing behavior.
- Run lint, build, unit tests, integration tests, and relevant end-to-end tests.
- Update each finding to `Resolved` or `Accepted` with evidence and a commit SHA.
- Confirm the authoritative implementation plan and documentation no longer conflict.
