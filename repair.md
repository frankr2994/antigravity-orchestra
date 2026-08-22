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
| R-013 | 3 | `ff6f8b2` | High | Open | Provider isolation | Jules-specific API types, mapping logic, and session fields are publicly exported from the provider-neutral domain. |
| R-014 | 3 | `ff6f8b2` | High | Open | Event contracts | `TaskEvent` still uses an unrestricted string type and unknown payload, so canonical event names and payloads are not enforced. |
| R-015 | 3 | `ff6f8b2` | High | Open | State persistence | Raw or invalid task states remain accepted at runtime because persistence casts database strings into the domain type without validation. |
| R-016 | 3 | `ff6f8b2` | Medium | Open | State mapping | Provider completion and unknown-state behavior have ambiguous terminal and user-attention semantics. |
| R-017 | 3 | `ff6f8b2` | Medium | Open | Provider roles | The execution-provider contract permits `auto` providers and treats Codex and Gemma as implementation workers. |
| R-018 | 3 | `ff6f8b2` | Medium | Open | Contract tests | JavaScript sample-object tests do not compile against or negatively test the TypeScript interfaces they claim to verify. |
| R-019 | 3 | `ff6f8b2` | Medium | Open | Review invariants | Review verdict and verification interfaces permit internally contradictory combinations. |
| R-020 | 4 | `e3d9bfc` | High | Open | Migration atomicity | Schema changes and migration-version inserts run outside a transaction and can leave a partially applied unversioned schema. |
| R-021 | 4 | `e3d9bfc` | Medium | Open | Migration compatibility | The migration engine does not reject newer schemas, verify migration identity, or provide rollback/backup guidance. |
| R-022 | 4 | `e3d9bfc` | High | Open | Credential storage | The generic settings repository accepts arbitrary plaintext keys and values, including future provider secrets. |
| R-023 | 4 | `e3d9bfc` | High | Open | Persistence validation | Repository mappers cast unrestricted database strings into task, target, worker, agent, and execution-state unions. |
| R-024 | 4 | `e3d9bfc` | Medium | Open | Cloud identity | Cloud sessions are not linked to execution attempts, remote session IDs are not unique, and provider identity is hard-coded on reads. |
| R-025 | 4 | `e3d9bfc` | Medium | Open | Repository transactions | Multi-statement session and message operations are not atomic. |
| R-026 | 4 | `e3d9bfc` | Medium | Open | Migration tests | Tests do not inject migration failure, compare legacy/fresh schema parity, or exercise downgrade and partial-migration behavior. |
| R-027 | 4 | `e3d9bfc` | Medium | Open | Compatibility tests | The test labeled 100% Store compatibility covers only a small subset of the facade. |
| R-028 | 4 | `e3d9bfc` | Medium | Open | Persistence boundary | The compatibility facade publicly exposes the raw database connection, allowing future workflows to bypass repositories. |
| R-029 | 5 | `31c9284` | High | Open | Route boundaries | Business workflows were moved into route files instead of application services and controllers. |
| R-030 | 5 | `31c9284` | High | Open | API tests | The route test constructs an Express app but never sends an HTTP request or verifies a mounted endpoint. |
| R-031 | 5 | `31c9284` | High | Open | SSE delivery | Event backfill occurs before subscription, creating a race that can omit live task events from an open stream. |
| R-032 | 5 | `31c9284` | High | Open | Server lifecycle | Bootstrap resolves before listen success and shutdown does not comprehensively own listeners, streams, collectors, or active tasks. |
| R-033 | 5 | `31c9284` | Medium | Open | Error handling | The global handler exposes raw error messages and maps nearly every failure to HTTP 400. |
| R-034 | 5 | `31c9284` | High | Open | Request validation | Validation remains ad hoc, and unvalidated Git revision parameters can be interpreted as command options. |
| R-035 | 5 | `31c9284` | Low | Open | Route manifest | An accidental `/api` prefix inside the mounted API router creates a redundant `/api/api/...` endpoint. |

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

## Phase 3 review

### Review scope

- Reviewed commit: `ff6f8b2c6aa3ed4602b5f80c3d8c3e89cf383efa`
- Commit subject: `feat(domain): extract shared domain contracts and jules state mapper (phase 3)`
- Primary artifacts reviewed: `server/domain/**`, `server/types.ts`, and `tests/domain-contracts.test.mjs`
- Review date: 2026-08-22
- Review policy: Findings recorded only; implementation repairs deferred.

### Verification performed

- `npm run build:server`: passed.
- `node --test tests/domain-contracts.test.mjs`: four tests passed with zero failures.
- Phase 3 domain source and its focused test were unchanged between `ff6f8b2` and the then-current Phase 4 head, so the focused verification exercised the reviewed implementation.

### R-013 — Jules-specific contracts leak into the provider-neutral domain

Severity: **High**
Status: **Open**

Evidence:

- `server/domain/tasks/states.ts:45-57` defines the alpha `JulesSessionState` inside the domain despite saying it is isolated to the provider adapter layer.
- `server/domain/tasks/states.ts:68-154` places `mapJulesToOrchestraState` and Jules-specific reason text in the domain.
- `server/domain/execution/attempt.ts:27-45` defines a `CloudSessionReference` fixed to `providerId: 'jules'` with Jules resource names and dispatch metadata.
- `server/domain/index.ts` publicly re-exports all of these vendor-specific types and functions.
- `ModelSelection` also adds a Jules model field even though Jules model selection is not part of the provider-neutral task contract.

Risk:

- Jules alpha API changes will force modifications to the supposedly stable domain layer and every consumer of its public exports.
- Adding another cloud provider will encourage duplicate vendor-specific domain records instead of adapter isolation.

Deferred adjustment:

- Move `JulesSessionState`, Jules response normalization, and Jules-to-provider mapping into `server/providers/jules`.
- Keep the domain limited to provider-neutral execution state and task-transition decisions.
- Replace `CloudSessionReference` with a provider-neutral reference containing an opaque provider ID, external session ID, and provider-neutral metadata; persist Jules-specific fields in its adapter/infrastructure record where necessary.
- Export vendor contracts only from the Jules adapter package.

### R-014 — Task and timeline events are not canonical contracts

Severity: **High**
Status: **Open**

Evidence:

- `server/domain/tasks/events.ts:7-14` declares `TaskEvent.type` as any string and `payload` as `unknown`.
- The persistence layer accepts `agent` and `type` as strings and casts them into `TaskEvent` when reading.
- The frontend continues to define its own independent `TaskEvent` shape and event-name registry.
- No discriminated union connects an event name to its required payload.

Risk:

- Misspelled names, invalid payloads, unknown agents, and server/UI event drift all remain compile-time valid.
- Jules activity translation could emit events that silently fail in the existing UI.

Deferred adjustment:

- Define a canonical event-payload map and derive a discriminated `TaskEvent` union from it.
- Use the same contract in emitters, persistence repositories, SSE serialization, and the typed frontend client.
- Add runtime validation at external and persisted-data boundaries.
- Coordinate this repair with Phase 1 finding R-002.

### R-015 — Task-state separation is not enforced at runtime

Severity: **High**
Status: **Open**

Evidence:

- `TaskRecord.state` is narrowed to `OrchestraTaskState` only at the TypeScript level.
- At commit `ff6f8b2`, `mapTask` reads any SQLite text and casts it directly to `TaskState` without validation.
- The SQLite task-state column has no check constraint, and state updates do not validate transition membership at runtime.
- `CloudSessionReference.state` is an unrestricted string rather than a provider-specific or provider-neutral state type.
- The tests never attempt to persist a raw Jules state in the Orchestra task-state field.

Risk:

- Raw provider states, misspellings, or corrupted historical values can enter the task model while appearing type-safe to downstream code.
- The Phase 3 acceptance criterion that raw provider state cannot be stored as Orchestra task state is not fully met.

Deferred adjustment:

- Add runtime parsers for Orchestra and provider states at repository and API boundaries.
- Reject or explicitly quarantine unknown persisted task states instead of casting them.
- Add database constraints or migration-time validation where compatible with recovery requirements.
- Store raw provider state in a separate provider-owned field.
- Add negative persistence tests using raw Jules and malformed state values.

### R-016 — Terminal and unknown-state semantics are ambiguous

Severity: **Medium**
Status: **Open**

Evidence:

- `COMPLETED` maps to `executionState: 'COMPLETED'` but returns `isTerminal: false` because the Orchestra task proceeds to review.
- The `isTerminal` property does not state whether it describes the provider execution or the Orchestra task.
- Unknown and empty provider states are reported as `WORKING`, with no required user action; `STATE_UNSPECIFIED` produces no reason.

Risk:

- A poller may continue polling a completed Jules session or stop the wider task at the wrong point, depending on how it interprets `isTerminal`.
- A new terminal or attention-required Jules state may be hidden as ordinary work and remain stuck indefinitely.

Deferred adjustment:

- Separate `providerTerminal` from `taskTerminal`, or rename the existing flag to state its exact scope.
- Add an explicit provider-neutral `UNKNOWN` or attention state rather than treating unknown values as confirmed work.
- Ensure unknown states remain pollable while also surfacing diagnostics and bounded escalation.
- Test poller decisions for completed, failed, unspecified, and future states.

### R-017 — Execution-provider roles and targets are over-broad

Severity: **Medium**
Status: **Open**

Evidence:

- `WorkerIdentity` includes Antigravity, Jules, Codex, and Gemma.
- `ExecutionProvider.id` accepts that full union and requires implementation-oriented `preflight`, `start`, and `inspect` methods.
- `ExecutionProvider.target` accepts `ExecutionTarget`, including `auto`, even though Auto is a routing decision rather than an executable provider location.
- Phase 7 explicitly requires Codex and Gemma to remain specialist services instead of being forced into an implementation-worker abstraction.

Risk:

- Later phases may implement fake execution methods for specialists or accidentally route work to an `auto` provider.
- Worker execution and specialist analysis responsibilities become difficult to enforce.

Deferred adjustment:

- Introduce a narrower `ImplementationWorkerIdentity` for Antigravity and Jules.
- Restrict provider targets to `local` or `cloud`.
- Keep `auto` in routing requests only.
- Define separate specialist contracts for classification, analysis, review, and distillation.

### R-018 — Interface contract tests do not exercise TypeScript contracts

Severity: **Medium**
Status: **Open**

Evidence:

- `tests/domain-contracts.test.mjs:98-143` creates untyped JavaScript objects for execution attempts, review verdicts, and verification results.
- The assertions only confirm values that were assigned in the same test.
- Those objects are never checked against `ExecutionAttempt`, `ReviewVerdict`, or `VerificationResult` by TypeScript or a runtime validator.
- No negative test proves raw provider state is rejected from `TaskRecord.state`.

Risk:

- Breaking or weakening an interface can leave every named “contract” test green.

Deferred adjustment:

- Add TypeScript contract fixtures compiled as part of the test suite using `satisfies` and intentional `@ts-expect-error` cases.
- Add runtime-schema tests for data that crosses API, provider, database, or SSE boundaries.
- Retain JavaScript runtime tests only for executable behavior such as state mapping.

### R-019 — Review and verification invariants allow contradictions

Severity: **Medium**
Status: **Open**

Evidence:

- `ReviewVerdict` independently stores `verdict` and `blocked`, allowing combinations such as `PASS` with `blocked: true` or `BLOCK` with `blocked: false`.
- `ReviewVerdictType` contains both `PASS` and `APPROVED` without defining their distinct semantics.
- `VerificationResult.status` can be `passed` while individual checks are failed, or `not_configured` while populated checks claim execution.

Risk:

- Workflow gates may choose different outcomes depending on which contradictory field they read.

Deferred adjustment:

- Use discriminated unions or constructors that derive `blocked` from the verdict.
- Define one canonical vocabulary for automated review versus user approval.
- Derive aggregate verification status from checks, or validate consistency at construction and persistence boundaries.

## Phase 4 review

### Review scope

- Reviewed commit: `e3d9bfc28f7e99b62559d964ed85d9d3f22135d8`
- Commit subject: `feat(persistence): modularize database repositories and versioned migrations engine (phase 4)`
- Primary artifacts reviewed: `server/infrastructure/database/**`, `server/db.ts`, and `tests/persistence-migrations.test.mjs`
- Review date: 2026-08-22
- Review policy: Findings recorded only; implementation repairs deferred.

### Verification performed

- `npm run build:server`: passed.
- `node --test tests/persistence-migrations.test.mjs`: four tests passed with zero failures.
- Phase 4 persistence source and focused tests were unchanged between `e3d9bfc` and the then-current Phase 5 head.
- Search of the exact Phase 4 tree found no application-workflow SQL outside the persistence infrastructure; the only non-infrastructure `.exec` match was a regular-expression call in `mcp.ts`.

### R-020 — Migrations are versioned but not transactional

Severity: **High**
Status: **Open**

Evidence:

- `migrations.ts:181-186` calls `m.up(db)` and inserts the migration-version row as separate autocommit operations.
- Neither each migration nor the full pending migration batch is wrapped in `BEGIN`, `COMMIT`, and `ROLLBACK`.
- Migration 2 performs multiple `ALTER TABLE`, `CREATE TABLE`, and `CREATE INDEX` operations before its version is recorded.
- The schema-migrations table itself is created outside a migration transaction.

Risk:

- A crash, disk error, duplicate migration runner, or failing statement can leave part of a migration applied without a corresponding version record.
- A retry may appear idempotent while preserving an unintended partial schema or data transformation.
- This directly misses Phase 4's transactional-migration requirement where SQLite supports transactional DDL.

Deferred adjustment:

- Acquire a migration lock with `BEGIN IMMEDIATE`.
- Run each migration and its version-row insert in the same transaction.
- Roll back on every exception and close the database if initialization fails.
- Add a failure-injection migration that changes schema and then throws; assert both the schema change and version row are absent afterward.
- Define whether the entire pending batch or each individual migration is the recovery boundary.

### R-021 — Migration compatibility and recovery policy are incomplete

Severity: **Medium**
Status: **Open**

Evidence:

- `runMigrations` returns the last version in the local `MIGRATIONS` array even if the database contains a newer schema version.
- It does not reject an older application opening a database migrated by a newer release.
- Applied migration names are stored but never compared with the current migration definition, and no checksum or immutable identity is verified.
- Migration ordering and duplicate versions are not validated.
- No rollback procedure, pre-migration backup, or user-facing recovery guidance was added despite the explicit Phase 4 requirement.

Risk:

- A downgraded application can operate against an unsupported schema and potentially corrupt data.
- Edited, reordered, or duplicated migrations can be silently treated as valid.
- Users have no documented recovery path after an unsuccessful production migration.

Deferred adjustment:

- Refuse startup when the database version is newer than the application supports.
- Validate strictly increasing unique migration versions and immutable migration identity.
- Document and implement the chosen backup or rollback strategy before applying pending migrations.
- Report the failed version and recovery location without exposing sensitive database contents.

### R-022 — Settings repository permits plaintext provider secrets

Severity: **High**
Status: **Open**

Evidence:

- `SettingsRepository.set(key, value)` accepts every key and persists every value as plaintext SQLite text.
- The compatibility `Store.setSetting` method exposes this unrestricted operation to application code.
- Nothing rejects keys such as `jules_api_key`, GitHub tokens, or authenticated remote URLs.
- The Phase 2 architecture scan checks only one literal SQL statement, so calls through this repository bypass that protection.

Risk:

- A later settings or Jules phase can accidentally persist credentials in the database while architecture and persistence tests remain green.

Deferred adjustment:

- Restrict persisted settings to an allowlisted non-secret schema.
- Reject secret-like keys at the repository and compatibility-facade boundaries.
- Route provider credentials exclusively through the environment or OS-protected credential service.
- Add negative tests proving known secret keys and values cannot be persisted.
- Coordinate this repair with R-009.

### R-023 — Persistence mappers trust invalid enum and event values

Severity: **High**
Status: **Open**

Evidence:

- `TaskRepository` casts arbitrary `state` and `target` text into domain unions.
- `ExecutionAttemptRepository` casts arbitrary target, worker, and provider-execution state values.
- `TaskEventRepository` casts arbitrary agent names while retaining unrestricted event names and payloads.
- Cloud session state remains an unrestricted string.
- The schema adds no check constraints for these fields, and update methods perform no runtime validation.

Risk:

- Corrupt, malformed, or raw provider values become trusted domain objects after a type assertion.
- Invalid values can bypass workflow exhaustiveness and recovery behavior.

Deferred adjustment:

- Parse and validate every enum-like database value at the repository boundary.
- Quarantine or fail clearly on historical invalid values rather than silently casting.
- Add compatible database constraints for newly created tables and validated migrations for existing tables.
- Add negative CRUD and migration tests.
- Coordinate this repair with R-015.

### R-024 — Cloud sessions cannot be correlated reliably with attempts

Severity: **Medium**
Status: **Open**

Evidence:

- `execution_attempts` and `cloud_sessions` share only `task_id`; `cloud_sessions` has no `attempt_id` foreign key.
- Multiple attempts and sessions can therefore belong to one task without an unambiguous relationship.
- `remote_session_id` has a normal non-unique index, while `getByRemoteSessionId` returns one unspecified match.
- `getByTaskId` chooses the latest timestamp even though timestamps are text and can collide.
- `mapCloudSession` ignores the stored `provider_id` and always returns `jules`.
- `ExecutionAttemptRepository.update` cannot populate or correct `providerSessionId` after an asynchronous provider start.

Risk:

- Retry, timeout reconciliation, polling, and restart recovery can update or resume the wrong provider session.
- Duplicate remote sessions cannot be detected reliably.

Deferred adjustment:

- Link each cloud session to its execution attempt with a foreign key.
- Add the appropriate uniqueness constraint for provider ID plus external session ID.
- Query by stable IDs rather than timestamp ordering.
- Preserve and validate the stored provider identity.
- Permit controlled post-dispatch persistence of the provider session ID with an idempotent compare-and-set operation.

### R-025 — Multi-statement repository operations are not atomic

Severity: **Medium**
Status: **Open**

Evidence:

- `SessionRepository.create` inserts the session and updates the project's active session in separate operations.
- `SessionRepository.activate` updates the project and session separately.
- `SessionRepository.addMessage` inserts the message and updates the session timestamp separately.
- No transaction boundary protects these related writes.

Risk:

- A failure between statements can leave orphaned sessions, stale active-session pointers, or messages whose parent session metadata was not updated.

Deferred adjustment:

- Add a reusable transaction helper owned by the database infrastructure.
- Wrap each multi-statement invariant in one transaction.
- Add failure-injection tests that prove the earlier statement rolls back when the later statement fails.

### R-026 — Migration tests do not verify failure safety or schema parity

Severity: **Medium**
Status: **Open**

Evidence:

- The idempotency test only reruns successful migrations.
- No test interrupts or fails a migration after a schema change.
- The legacy fixture omits several production constraints and foreign keys; `CREATE TABLE IF NOT EXISTS` leaves those existing weak tables unchanged.
- The test checks a few retained rows but does not compare indexes, foreign keys, defaults, nullability, or table structure against a fresh database.
- No test covers an unknown newer schema version, a migration gap, duplicate versions, or a partially recorded migration.

Risk:

- A database can be reported as successfully migrated while its structure differs materially from a fresh installation.
- The most damaging migration failure modes remain untested.

Deferred adjustment:

- Build legacy fixtures from real released schemas.
- Compare normalized schema metadata between migrated and fresh databases.
- Add failure, partial-state, concurrent-runner, future-version, and malformed-history tests.
- Verify preservation of messages, task events, Git operations, settings, sessions, tasks, and their relationships.

### R-027 — Store compatibility test is not comprehensive

Severity: **Medium**
Status: **Open**

Evidence:

- The test named `Store facade retains 100% backwards-compatibility` exercises only project/session/task creation, one event, and one task update.
- It does not cover project listing and deletion, onboarding, session activation/summary/title/deletion, messages, interrupted-task recovery, Git operations, settings, filtering, ordering, or error behavior.

Risk:

- A facade regression can break existing application workflows while the claimed compatibility test remains green.

Deferred adjustment:

- Inventory every pre-refactor public Store method and its observable behavior.
- Add contract tests for each method, including ordering, limits, cascades, timestamps, null handling, and failures.
- Rename tests so their names match their actual coverage until the complete compatibility matrix exists.

### R-028 — Raw database access remains publicly exposed

Severity: **Medium**
Status: **Open**

Evidence:

- `Store.db` publicly returns `DatabaseManager.db`.
- `DatabaseManager.db` is also public.
- Application code can therefore bypass repositories, domain validation, migration assumptions, and future credential restrictions.
- The exact Phase 4 application workflows do not currently use the escape hatch, but the architecture does not prevent future use.

Risk:

- New workflow code can reintroduce raw SQL without an obvious architectural violation at compile time.

Deferred adjustment:

- Keep the connection private to persistence infrastructure.
- Expose narrowly scoped transaction and diagnostic interfaces where required.
- If temporary compatibility access is unavoidable, document it as a ratcheted legacy exception and add a test preventing new consumers.

## Phase 5 review

### Review scope

- Reviewed commit: `31c9284312df3d1a6333883ffacdd054ab5a93a6`
- Commit subject: `feat(server): decompose server bootstrap and modularize API routes (phase 5)`
- Primary artifacts reviewed: `server/api/**`, `server/bootstrap/**`, `server/index.ts`, and `tests/api-routes.test.mjs`
- Review date: 2026-08-22
- Review policy: Findings recorded only; implementation repairs deferred.

### Verification performed

- `npm run build:server`: passed.
- `node --test tests/api-routes.test.mjs`: two tests passed with zero failures.
- Phase 5 API/bootstrap source and its focused test were unchanged between `31c9284` and the then-current Phase 6 head.
- A route-manifest comparison found every pre-refactor API endpoint represented in the new router tree, plus one unintended duplicate-prefix route.

### R-029 — Route files still implement application workflows

Severity: **High**
Status: **Open**

Evidence:

- `sessions.ts` performs active-task locking, prompt validation, continuation recovery, title mutation, direct-agent classification, model selection, task creation, message/event persistence, and enqueueing inside one route handler.
- `tasks.ts` performs monitoring context assembly, Git push finalization, task-state updates, review-event discovery, and steering generation directly in handlers.
- `projects.ts` launches a GUI process, performs onboarding, Git inspection, checkpoint creation, and checkpoint rollback directly from routes.
- Route modules depend on the concrete Store and TaskManager plus agents, Git, process, telemetry, MCP, and configuration modules rather than narrow application-service interfaces.
- No controller or application-service layer was introduced even though the target architecture and Phase 5 plan call for it.

Risk:

- The original server monolith becomes several endpoint monoliths with business rules coupled to Express.
- Workflows cannot be reused by Jules, recovery workers, CLI entry points, or tests without fabricating HTTP requests.
- Adding features still requires editing large route modules and can disrupt unrelated API behavior.

Deferred adjustment:

- Move each use case into an application service with typed input and result contracts.
- Keep route handlers responsible only for authentication context, schema parsing, service invocation, and response mapping.
- Inject narrow repository and service ports instead of concrete Store/TaskManager objects.
- Add a ratchet preventing route modules from importing agents, Git, process, or persistence implementations directly.

### R-030 — API tests do not exercise the API

Severity: **High**
Status: **Open**

Evidence:

- The test named `createApp mounts modular routers and handles requests` only calls `createApp` and asserts the returned object is truthy.
- It then calls Store methods directly; no HTTP request is sent through Express.
- It does not verify route paths, status codes, response bodies, JSON parsing, host validation, dashboard-token checks, origin validation, error middleware, static fallback, or SSE behavior.
- It therefore cannot prove the Phase 5 acceptance criterion that API behavior remained unchanged.

Risk:

- Missing, duplicated, remounted, unauthenticated, or behaviorally changed routes can ship with a green focused test.

Deferred adjustment:

- Add HTTP-level tests using a temporary listener or an Express request-testing library.
- Maintain a method/path compatibility manifest for every pre-refactor endpoint.
- Test representative success, validation, not-found, internal-error, authentication, origin, host, and streaming cases.
- Assert that unknown `/api` routes return JSON 404 rather than the frontend application shell.

### R-031 — SSE backfill and subscription have a lost-event race

Severity: **High**
Status: **Open**

Evidence:

- `tasks.ts:108-111` reads and writes historical events before registering the live subscription at line 112.
- An event persisted and emitted between those operations is neither included in the completed backfill nor observed by the not-yet-registered listener.
- The stream stays open, so the client may not reconnect and request the omitted ID.
- `Last-Event-ID` and `after` are converted with `Number` but are not checked for finite, non-negative integer values.
- SSE connections are not registered with the server lifecycle for graceful shutdown.

Risk:

- The dashboard can permanently miss a state transition or completion event while displaying an apparently healthy live connection.
- Malformed cursors can turn into persistence errors or inconsistent replay behavior.

Deferred adjustment:

- Subscribe before backfill, then replay through a cursor with deduplication, or provide an atomic event-log subscription abstraction.
- Validate and bound cursor values.
- Track the last delivered ID per connection and test concurrent emission during connection setup.
- Register SSE connections for graceful close and reconnection signaling during shutdown.

### R-032 — Bootstrap and shutdown do not provide a reliable lifecycle boundary

Severity: **High**
Status: **Open**

Evidence:

- `bootstrapServer` resolves immediately after calling `app.listen`, before the listening callback confirms success.
- A listen error such as `EADDRINUSE` only logs and sets `process.exitCode`; it does not reject bootstrap, close the Store, or undo initialized resources.
- Every bootstrap call adds process signal listeners, while the returned `close` function does not remove them.
- Signal shutdown closes Codex, the HTTP server, and Store but does not explicitly stop active TaskManager work, the Antigravity telemetry collector, or tracked SSE clients.
- The signal handler calls `process.exit` from the reusable bootstrap module and is not guarded against repeated signals.
- The programmatic `close` path differs from signal shutdown and has no bounded fallback for long-lived connections.

Risk:

- Tests, embedded use, restart, or port conflicts can leak listeners, database handles, workers, or background collectors.
- Callers can receive a server instance that never successfully started.

Deferred adjustment:

- Resolve bootstrap only after the server emits `listening`; reject and clean up on `error`.
- Centralize all resource ownership in an idempotent lifecycle object with reverse-order cleanup.
- Stop task workers, collectors, Codex, SSE clients, HTTP connections, signal listeners, and Store consistently.
- Keep direct process termination in the executable entry point rather than the reusable bootstrap service.
- Add repeated-start, port-conflict, active-SSE, active-task, double-close, and signal-listener tests.

### R-033 — Error middleware leaks details and misclassifies failures

Severity: **Medium**
Status: **Open**

Evidence:

- `errorHandlerMiddleware` returns the raw exception message to the client and writes it directly to the console.
- Any message containing “not found” becomes 404; every other error becomes 400, including unexpected infrastructure and programming failures.
- There are no typed application errors, stable error codes, secret/path redaction, request correlation IDs, or production-safe internal error responses.

Risk:

- Filesystem paths, command output, remote URLs, or future provider secrets can leak to the browser and logs.
- Internal outages appear as client mistakes, making monitoring and retries unreliable.

Deferred adjustment:

- Introduce typed validation, authentication, not-found, conflict, provider, and internal errors.
- Map them deterministically to status codes and stable public codes.
- Redact logs and return a generic message for unexpected failures while retaining correlated diagnostics.
- Coordinate secret handling with R-009 and R-022.

### R-034 — Request validation is incomplete at dangerous boundaries

Severity: **High**
Status: **Open**

Evidence:

- No centralized request-schema middleware was added; handlers rely on `String`, `Boolean`, and hand-written conditional coercion.
- Checkpoint `:sha` parameters are passed into Git operations without verifying a full object ID or otherwise separating revisions from options.
- `git show` receives the supplied value after command options, so a revision beginning with `-` can be interpreted as another Git option rather than an object name.
- The baseline route confirms that both a project and task exist but does not verify that the task belongs to the project in the URL.
- Settings quota policy, MCP names, model identifiers, query parameters, and several task-control bodies lack structural validation.

Risk:

- Malformed requests can cause cross-project actions, invalid persisted settings, unexpected command behavior, or misleading 400 responses.
- A Git option accepted through the SHA parameter may alter command behavior or write output unexpectedly.

Deferred adjustment:

- Define reusable schemas for every parameter, query, and body.
- Accept checkpoint identifiers only in a strict supported hash format and use `--` or verified object resolution where Git permits it.
- Validate resource ownership relationships before invoking application services.
- Return field-specific validation errors without echoing sensitive values.
- Add negative HTTP tests for every mutating endpoint and command-adjacent parameter.

### R-035 — Mounted router contains a duplicate API prefix

Severity: **Low**
Status: **Open**

Evidence:

- The router is mounted at `/api` by `createApp`.
- `tasks.ts:45` additionally declares `/api/tasks/:id/monitor/explain`, producing `/api/api/tasks/:id/monitor/explain`.
- The correct `/tasks/:id/monitor/explain` route is declared again immediately afterward.

Risk:

- The unintended endpoint increases route ambiguity and demonstrates that route mounting is not contract-tested.

Deferred adjustment:

- Remove the duplicate-prefix route.
- Add a route-manifest test that rejects unintended paths and duplicates.

## Phase 6 review

### Review scope

- Reviewed commit: `a47a23379ca0505b960f43e2915b0956c15194f4`
- Commit subject: `feat(jules): build isolated google jules api client and contract tests (phase 6)`
- Primary artifacts reviewed: `server/providers/jules/**`, `tests/jules-client.test.mjs`, the Phase 6 and Phase 9 requirements in `julesplan.md`, and the official Jules REST API reference as available on 2026-08-22.
- Review date: 2026-08-22
- Review policy: Findings recorded only; implementation repairs deferred.

### Verification performed

- Confirmed that the client, error, wire-type, and focused-test blobs are unchanged between `a47a233` and the test checkout.
- `npm run build:server`: passed.
- `node --test tests/jules-client.test.mjs`: five tests passed with zero failures after rerunning outside the process sandbox; the first sandboxed run was blocked by `spawn EPERM` before loading the tests.
- A direct retry probe returned `503` once and then success; `createSession` issued two POST requests.
- Compared the implementation with the official Jules Sessions, Activities, Sources, Types, and API Overview documentation.
- Confirmed that `server/tasks.ts` was unchanged from Phase 5 and remained 891 lines in this commit.

### R-036 — The commit does not implement the planned Phase 6

Severity: **High**
Status: **Open**

Evidence:

- `julesplan.md` defines Phase 6 as decomposing the local `TaskManager` workflow into focused submission, routing, execution, failover, review, repair, verification, Git finalization, monitoring, recovery, and steering services.
- Commit `a47a233` changes only Jules client files, its focused test, and the repair tracker; `server/tasks.ts` is unchanged from Phase 5 and remains 891 lines.
- The work in this commit corresponds to the plan's Phase 9, while the Phase 6 acceptance criteria for independently testable review/repair policy and reusable cloud workflow contracts are not exercised.

Risk:

- Phase tracking can report the monolith as decomposed when the central workflow remains untouched.
- Later cloud integration may be built around the existing monolith, increasing coupling and making the deferred modularization riskier.

Deferred adjustment:

- Reconcile the implementation ledger with `julesplan.md`; do not mark the planned Phase 6 complete based on this commit.
- Perform the missing workflow decomposition behind characterization tests before connecting Jules orchestration to `TaskManager` internals.
- Give each extracted service a narrow port and independent tests so future providers can reuse policy without copying local execution code.

### R-037 — The client calls unsupported operations and omits required ones

Severity: **High**
Status: **Open**

Evidence:

- `client.ts:208-210` calls `POST sessions/{id}:sendFeedback` with `{ message }`; the official API specifies `POST sessions/{id}:sendMessage` with a required `{ prompt }` body.
- `client.ts:214-222` exposes `:pause` and `:resume`, neither of which is documented as a Jules REST session endpoint.
- The official API and Phase 9 plan require deleting sessions, but the client has no `deleteSession` method and its request method type permits only `GET` and `POST`.
- The Phase 9 plan requires retrieving sources, and the official API provides `GET /sources/{sourceId}`, but the client only lists sources.
- The focused test asserts the incorrect `:sendFeedback` URL, so it passes while preserving the incompatibility.

Risk:

- User feedback will fail against the real service, while callers are offered pause/resume capabilities that the API does not provide.
- Session cleanup and direct source retrieval cannot be implemented through this client without bypassing or expanding it ad hoc.

Deferred adjustment:

- Replace `sendFeedback`'s wire operation with the documented `:sendMessage` endpoint and `{ prompt }` body while retaining a provider-neutral application-level name if desired.
- Add `DELETE` support, `deleteSession`, and `getSource` with exact resource-name handling.
- Remove unsupported pause/resume methods unless a dated official contract or capability probe establishes them.
- Build endpoint tests from sanitized official-response fixtures rather than implementation-authored expectations.

### R-038 — Wire types contradict the documented Jules schemas

Severity: **High**
Status: **Open**

Evidence:

- `types.ts:48` models `Session.outputs` as one object; the API returns an array of `SessionOutput` values.
- `JulesPullRequestOutput` invents `headBranch`, `baseBranch`, and `headCommitSha`, omits the documented `description`, and conflicts with the plan's explicit warning not to assume PR branch names or commit SHAs.
- `JulesActivity` uses generic `type` and `plan` properties, but the documented activity shape uses `originator` and event-specific fields such as `planGenerated`, `agentMessaged`, `progressUpdated`, `sessionCompleted`, and `sessionFailed`.
- The generic artifact `{ type, uri, metadata }` does not represent the documented `changeSet`, `bashOutput`, and `media` variants.
- `githubRepo.defaultBranch` is typed as a string even though the API returns a branch object, and session fields such as `url` and `automationMode` are absent.

Risk:

- Valid API responses appear type-safe but are read through the wrong shape, causing completed outputs, plans, messages, branches, and artifacts to be lost or misinterpreted.
- Invented fields encourage downstream code to depend on data the service does not promise.

Deferred adjustment:

- Rebuild provider-local DTOs from the current official alpha schema, including arrays and event/artifact variants.
- Remove undocumented output fields and derive any Git metadata through a separate verified GitHub integration.
- Keep wire DTOs isolated from provider-neutral domain models and explicitly map only validated values.

### R-039 — Typed response validation and fixture-based contract tests are absent

Severity: **High**
Status: **Open**

Evidence:

- `client.ts:126` casts `await response.json()` to generic `T` without performing any runtime validation.
- List methods use fallbacks such as `res.sources || []`, allowing malformed payloads to masquerade as valid empty pages.
- `JulesSession.state` is declared as `JulesSessionState | string`, which simplifies to an unrestricted string and provides no wire-state constraint.
- `tests/jules-client.test.mjs` uses hand-authored mock objects and contains no recorded, sanitized fixtures, despite the plan requiring typed validation and recorded contract fixtures.
- The mocks omit or encode the same shapes that are wrong in production, so all five tests pass despite R-037 and R-038.

Risk:

- Alpha API drift, error envelopes returned with an unexpected status, and malformed successful payloads can enter orchestration as trusted data.
- Contract regressions remain green because the tests validate the implementation against itself.

Deferred adjustment:

- Validate every successful response at the provider boundary and raise a typed, redacted contract error containing endpoint and correlation context.
- Preserve unknown enum values as explicit unknown variants rather than accepting arbitrary strings silently.
- Add sanitized fixtures for sources, every session state, outputs, activities/artifacts, pagination, empty responses, and Google RPC errors.
- Add negative tests proving malformed payloads are rejected.

### R-040 — Pagination tokens are discarded for sources and activities

Severity: **High**
Status: **Open**

Evidence:

- `listSources` and `listActivities` accept a `pageToken`, but return only their item arrays and discard the response's `nextPageToken`.
- A caller therefore cannot discover the token needed to request the next page through the public client API.
- `listSessions` returns its response envelope, creating an inconsistent pagination contract across list methods.
- No helper follows pages, bounds collection, or tests multi-page behavior even though pagination is a Phase 9 requirement.

Risk:

- Repositories and activity history beyond the first page are silently invisible.
- Monitoring can miss user-action requests, failures, completion events, or output artifacts and leave orchestration in the wrong state.

Deferred adjustment:

- Use one consistent page result such as `{ items, nextPageToken }` for every list operation.
- Optionally add a bounded async iterator or explicit collect-all helper above the single-page methods.
- Test token propagation, empty intermediate pages, multiple pages, caller aborts, and maximum-page safeguards.

### R-041 — Retry and abort behavior can duplicate mutations or ignore cancellation

Severity: **High**
Status: **Open**

Evidence:

- The generic request loop retries every transient status and network failure regardless of method, including `createSession`, messaging, and plan approval POSTs.
- A direct probe with one `503` followed by success caused `createSession` to issue two POST requests; no idempotency key or reconciliation step is present.
- `429` is retried using local jitter only; a server `Retry-After` value is not read.
- A signal already aborted before the call is not checked, and the caller's abort listener is removed before transient-response backoff. The sleep is not abortable, so an abort during backoff can still be followed by another request.

Risk:

- A lost response or transient failure can create duplicate Jules sessions or repeat user-visible mutations.
- Shutdown and user cancellation can be delayed or ignored, while rate-limit recovery may retry earlier than the service requests.

Deferred adjustment:

- Default automatic retries to safe reads; define and test an explicit idempotency/reconciliation policy before retrying mutations.
- Honor valid bounded `Retry-After` guidance for `429` and applicable service errors.
- Check `signal.throwIfAborted()` before every attempt and make backoff abortable.
- Inject delay and jitter functions so retry, timeout, and cancellation behavior can be tested deterministically.

### R-042 — Secret exposure remains possible despite message redaction

Severity: **Medium**
Status: **Open**

Evidence:

- `JulesApiClient.apiKey` is a public enumerable property, and the constructor test explicitly reads it back.
- `JulesApiError.details` retains the raw Google RPC detail objects without recursive redaction.
- The redaction tests cover selected URL, Google-key, GitHub-token, and bearer-token patterns, but do not test structured error details or serialization of the client/error objects.

Risk:

- Generic object serialization, diagnostics, or structured error logging can disclose a Jules credential or a sensitive value echoed in error details.

Deferred adjustment:

- Keep credentials in a private, non-serializable field and expose no getter for the raw value.
- Sanitize or omit structured upstream error details before attaching them to throwable/loggable objects.
- Add serialization and nested-detail leakage tests, coordinated with R-009, R-022, and R-033.

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
