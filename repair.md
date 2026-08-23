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

## Phase 7 review

### Review scope

- Reviewed commit: `d28b30f4f21c65c4b5baa7cece97845c355ebc1c`
- Commit subject: `feat(security): implement secure encrypted credential vault and jules key management (phase 7)`
- Primary artifacts reviewed: `server/infrastructure/security/vault.ts`, `server/providers/jules/credentials.ts`, `server/api/routes/jules.ts`, route registration, focused tests, the Phase 7 and Phase 10 requirements in `julesplan.md`, and authoritative key-storage guidance.
- Review date: 2026-08-22
- Review policy: Findings recorded only; implementation repairs deferred.

### Verification performed

- Confirmed that the vault, credential helper, and focused-test blobs were unchanged between `d28b30f` and the test checkout. The Jules route had subsequent Phase 8 changes, so its Phase 7 version was reviewed directly from the commit.
- `npm run build:server`: passed.
- `node --test tests/jules-credentials.test.mjs`: four tests passed with zero failures.
- A self-cleaning probe independently decrypted a vault value using only the hostname, username, profile path, fixed salt, and algorithm present in source.
- A malformed successful Jules response was accepted as a valid credential.
- A mocked authentication error that echoed a nonstandard submitted key was returned with that key still present.
- Compared the design with Microsoft DPAPI, Node.js filesystem/crypto documentation, and OWASP cryptographic-storage and secrets-management guidance.

### R-043 — The planned Phase 7 provider decomposition was not implemented

Severity: **High**
Status: **Open**

Evidence:

- `julesplan.md` defines Phase 7 as moving Antigravity behind `ExecutionProvider`, declaring capabilities, preserving Codex and Gemma specialist roles, and returning typed capability errors.
- Commit `d28b30f` changes credential, vault, and Jules route files; it does not change `TaskManager`, agent execution, domain interfaces, or provider adapters.
- At this commit, `ExecutionProvider` and `ProviderCapability` are only declarations in `server/domain/providers/provider.ts`; no server implementation or workflow consumer references them.
- The commit instead implements part of the plan's Phase 10 secure Jules configuration scope.

Risk:

- Phase tracking can mark the provider abstraction complete while Antigravity remains coupled to the monolithic execution path.
- Jules integration can accumulate direct workflow dependencies before the common provider seam and capability-error behavior exist.

Deferred adjustment:

- Keep the implementation ledger aligned with `julesplan.md` and leave the planned Phase 7 open.
- Adapt Antigravity through the provider interface before cloud dispatch uses it.
- Add typed unsupported-capability behavior and tests without forcing Codex or Gemma into an unsuitable implementation-provider role.

### R-044 — The vault encryption key is reproducible and is not OS-protected

Severity: **High**
Status: **Open**

Evidence:

- `vault.ts:33-34` derives the AES key from hostname, username, and profile path using a fixed source-code salt.
- Those values bind the ciphertext to an environment but do not supply a secret; anyone who obtains or can infer the identifiers can run the same derivation.
- A review probe independently derived the key and decrypted a test vault without using `CredentialVault.getSecret`.
- The implementation does not call Windows DPAPI, Credential Manager, macOS Keychain, Linux Secret Service, or another OS-protected credential store.
- AES-256-GCM, a random 12-byte IV, and an authentication tag are appropriate primitives, but they cannot compensate for a reproducible encryption key.

Risk:

- Theft or backup exposure of `vault.enc.json` can disclose every stored secret, so the file provides obfuscation rather than the Phase 10 requirement's OS-backed protection.
- An attacker does not need the user's Windows logon credential to decrypt the vault.

Deferred adjustment:

- Replace metadata-derived keying with an OS-protected secret-storage adapter; on Windows, use current-user DPAPI or an appropriate Credential Manager integration.
- Define platform adapters and an explicit unsupported-platform policy rather than silently weakening protection.
- Version and migrate existing vault data only after authenticating the old format, then remove the legacy derivation path.

### R-045 — Vault writes are neither atomic nor reliably access-restricted

Severity: **High**
Status: **Open**

Evidence:

- `vault.ts:82` overwrites the live vault directly with `writeFileSync`; there is no same-directory temporary file, flush, atomic rename, backup, or interprocess lock.
- The supplied `mode: 0o600` only applies when Node creates a file and does not repair permissions on an existing vault.
- Node documents that Windows file modes cannot express the POSIX owner/group/other distinction, so `0o600` does not establish an owner-only Windows ACL.
- The parent directory is created with default permissions, and no post-write permission or ownership verification is performed.

Risk:

- A crash, disk-full condition, or competing process can truncate or lose the only credential copy.
- On the primary Windows platform, local accounts or inherited ACL principals may be able to read the ciphertext; combined with R-044, that exposes the key.

Deferred adjustment:

- Use an OS credential store so file ACLs are not the primary secret boundary.
- If an encrypted-file fallback remains, write and flush a restrictive temporary file, atomically replace the destination, preserve a recoverable backup, and serialize writers.
- Explicitly create and verify platform-appropriate directory/file ACLs and fail closed when they cannot be enforced.

### R-046 — Corruption and migration failures are silently treated as an empty vault

Severity: **High**
Status: **Open**

Evidence:

- `vault.ts:45-46` returns `{}` for an unsupported version or incomplete envelope.
- `vault.ts:58-60` catches every read, parse, authentication, decryption, and plaintext-schema error, logs a generic reset warning, and also returns `{}`.
- Callers cannot distinguish a missing vault from corruption, tampering, permission denial, environment drift, or an unsupported future version.
- A subsequent `setSecret` loads that empty object and overwrites the original vault, destroying other recoverable secrets.

Risk:

- Authentication failures or interrupted writes can become silent credential loss, followed by destructive replacement.
- Tampering and version incompatibility are hidden from operators instead of failing securely and preserving evidence.

Deferred adjustment:

- Return typed `missing`, `locked`, `corrupt`, `unsupported-version`, and `unavailable` outcomes.
- Never overwrite a vault that failed authenticated loading; quarantine or retain it and require an explicit recovery/reset operation.
- Add envelope schema validation, versioned migrations, backup recovery, and diagnostics that contain no secrets.

### R-047 — Credential validation can accept invalid responses and leak submitted keys

Severity: **High**
Status: **Open**

Evidence:

- `validateJulesApiKey` treats any successful `listSources` call as valid; because the Phase 6 client does not validate response schemas, a review probe showed that HTTP 200 with `{ unexpected: true }` returns `valid: true`.
- `credentials.ts:78-82` collapses authentication failures, authorization failures, rate limits, service outages, timeouts, and contract errors into `{ valid: false, error: message }`.
- `jules.ts:48-51` returns that upstream error text to the caller as a 400 response.
- A review probe used an upstream message that echoed the submitted nonstandard key; the returned error still contained the complete key because pattern-based redaction did not recognize it.
- The Phase 10 acceptance criteria require secrets to stay out of error payloads and revoked or invalid keys to produce actionable errors.

Risk:

- Malformed or intercepted responses can mark unusable credentials as valid and persist them.
- Credentials can be reflected into browser-visible error payloads, console output through the global error path, telemetry, or support captures.
- Operators cannot distinguish a bad key from a transient Jules outage and may replace credentials unnecessarily.

Deferred adjustment:

- Resolve R-039 by validating the exact source-list response before declaring connectivity successful.
- Return a closed status enum such as `valid`, `invalid`, `forbidden`, `rate_limited`, `unavailable`, and `contract_error`, with safe fixed client messages.
- Never include upstream text or submitted secret material in an HTTP response; retain only redacted, correlated diagnostics.
- Test arbitrary secret formats and upstream reflection, not only known token prefixes.

### R-048 — The secure Jules configuration phase is only partially implemented

Severity: **High**
Status: **Open**

Evidence:

- Although this commit corresponds to Phase 10 work, it configures only credential resolution.
- No Jules endpoint, polling interval, request timeout, retry limit, maximum concurrent-session limit, plan-approval default, or feature flag is added to application configuration.
- `routes/index.ts:21` mounts the Jules credential router unconditionally, so there is no rollout switch that disables Jules surfaces while preserving local execution.
- Environment credentials always take precedence, while `save-key` writes only the vault and `clear-key` removes only the vault; under an environment override, a successful save is inactive and a successful clear leaves Jules configured.

Risk:

- Operational values remain scattered as client literals and cannot be validated, tuned, or disabled centrally.
- Credential-management responses can mislead users about which key an operation changed, and staged rollback cannot disable the feature cleanly.

Deferred adjustment:

- Add one validated, typed Jules configuration object with safe bounds and explicit defaults for every Phase 10 setting.
- Gate routes, discovery, dispatch, and background activity behind the same server-side feature flag.
- Make environment-managed credentials read-only in the API and return an explicit source/active-state result for save and clear operations.

### R-049 — Security-critical behavior is not exercised through the HTTP boundary

Severity: **High**
Status: **Open**

Evidence:

- The four focused tests call helpers directly; none sends a request through the Jules router or the global host, origin, dashboard-token, JSON, and error middleware.
- The encryption test proves only that a chosen plaintext substring is absent from the file; it does not attempt independent key derivation or exercise tampering, corruption, version mismatch, permission failure, interrupted writes, or recovery.
- There are no tests for save validation, validation bypass, environment precedence during save/clear, secret reflection, concurrent operations, or response cache policy.
- `createJulesRouter` depends on the concrete `CredentialVault` and calls the real validation function directly, while `createApiRouter` constructs it internally. This prevents narrow dependency injection at the HTTP boundary and repeats the modularity problem in R-029/R-030.

Risk:

- The suite stays green while the vault is decryptable from metadata and route responses can expose submitted credentials.
- Later credential providers or connectivity policies will require editing route code and may disrupt unrelated API behavior.

Deferred adjustment:

- Introduce narrow credential-store and Jules-connectivity ports and inject them into the router factory.
- Add HTTP-level tests for authentication, authorization, schema validation, status codes, safe error bodies, cache headers, save/clear semantics, and injected infrastructure failures.
- Add adversarial vault tests for independent decryption, tampering, corrupt envelopes, permissions, atomic-write failure, migration, and recovery.

## Phase 8 review

### Review scope

- Reviewed commit: `7ee25d6e862cec3a5e8b6870f49dfd91ffd753cd`
- Commit subject: `feat(jules): add source repository discovery, diagnostic mapping and API route (phase 8)`
- Primary artifacts reviewed: `server/providers/jules/source-discovery.ts`, the Jules API route changes, `tests/jules-source-discovery.test.mjs`, existing GitHub remote validation, the Phase 8 and Phase 11 requirements in `julesplan.md`, and the official Jules Sources and GitHub remote documentation.
- Review date: 2026-08-22
- Review policy: Findings recorded only; implementation repairs deferred.

### Verification performed

- Confirmed that the source-discovery implementation and focused-test blobs were unchanged between `7ee25d6` and the test checkout.
- `node --test tests/jules-source-discovery.test.mjs`: four tests passed with zero failures after rerunning outside the process sandbox.
- The current checkout's `npm run build:server` was blocked by TypeScript errors in the subsequent Phase 9 `session-manager.ts`; those later errors are not attributed to commit `7ee25d6`.
- Confirmed that `src/App.tsx` was unchanged from Phase 7 and remained 1,791 lines.
- Adversarial probes showed that HTTP, FTP, credential-bearing HTTPS, custom-port, and extra-path URLs were accepted as GitHub repository identities.
- A contradictory-source probe returned `connected` when the opaque source name matched locally but `githubRepo.owner/repo` identified a different repository.
- Compared pagination, source identity, branch metadata, and session source-context behavior with the current official Jules Sources and Types references.

### R-050 — The planned Phase 8 frontend modularization was not implemented

Severity: **High**
Status: **Open**

Evidence:

- `julesplan.md` defines Phase 8 as decomposing the frontend application shell, task submission, target selection, monitor, cloud details, projects, checkpoints, MCP, settings, API hooks, shared components, and CSS.
- Commit `7ee25d6` changes only server-side Jules route/provider files, its focused test, and the repair tracker.
- `src/App.tsx` has no diff from Phase 7 and remains 1,791 lines.
- The implemented work belongs primarily to the plan's Phase 11 source-discovery scope.

Risk:

- Phase tracking can report the frontend monolith as resolved while it remains unchanged.
- Adding Jules UI later will enlarge or disrupt the existing root component instead of landing behind an isolated feature boundary.

Deferred adjustment:

- Keep the planned Phase 8 open in the implementation ledger.
- Complete the frontend feature and shared-component decomposition behind behavioral and visual characterization tests before adding cloud-session UI.
- Give Jules UI a dedicated feature module and typed API client so unrelated local-workflow views do not need modification.

### R-051 — Remote parsing accepts malformed URLs and can expose embedded credentials

Severity: **High**
Status: **Open**

Evidence:

- `source-discovery.ts:61-78` accepts any URL whose hostname is `github.com` and whose path has at least two segments; it does not restrict protocol, username/password, port, query, fragment, or exact path length.
- Review probes accepted `http://`, `ftp://`, credential-bearing HTTPS, a custom port, and an extra path segment as GitHub repository identities.
- The raw input is retained as `GitRemoteInfo.url` and returned as `remoteUrl` in connected and error results. A credential-bearing remote therefore returns its username/token unchanged through the API.
- `server/git.ts` already contains stricter HTTPS GitHub validation, but source discovery introduces a second, inconsistent parser instead of sharing one canonical repository-identity abstraction.
- The focused parser test covers only ordinary HTTPS/SSH, one GitLab URL, and one unparseable string; it does not test the Phase 11 requirement to reject lookalike and malformed identities.

Risk:

- A malformed remote can be mapped to the wrong repository identity.
- Personal access tokens or usernames embedded in legacy remote URLs can leak into HTTP responses, logs, diagnostics, or support captures.
- Different features can disagree about whether the same remote is safe or valid.

Deferred adjustment:

- Create one canonical GitHub repository-identity parser shared by Git connection, preflight, and source discovery.
- Accept only explicitly supported GitHub HTTPS and SSH clone forms; reject or deliberately normalize userinfo, unsupported schemes/hosts/ports, query/fragment data, encoded separators, and extra path segments.
- Return a sanitized canonical identity and remote kind, never the raw credential-bearing URL.
- Add table-driven adversarial tests for lookalikes, Unicode/encoding, credentials, ports, extra segments, SCP syntax, and supported SSH variants.

### R-052 — Source matching can falsely accept one repository or falsely reject another

Severity: **High**
Status: **Open**

Evidence:

- `source-discovery.ts:184-194` first infers owner/repository from the opaque `source.name` and returns a match before checking structured `source.githubRepo` identity.
- The Jules type contract defines `name` as a resource identifier in the form `sources/{source}`; examples already use differing opaque ID layouts, so its internal text is not a stable repository-identity contract.
- A review probe supplied a locally matching name with conflicting structured owner/repository data and received `status: connected` for the wrong structured repository.
- Discovery calls `client.listSources()` once. Because that Phase 6 method returns only the first page and discards `nextPageToken` (R-040), a valid source on a later page is reported as `source_not_installed`.
- The returned remediation then incorrectly tells the user to install the Jules GitHub App.

Risk:

- A false positive can dispatch work using a Jules source for a different repository.
- A false negative can block valid cloud execution and prompt unnecessary or confusing GitHub App changes.

Deferred adjustment:

- Runtime-validate each Source and match only the structured, normalized `githubRepo.owner/repo` fields.
- Treat `source.name` as an opaque stable identifier after identity has been established.
- Resolve R-040 by traversing all bounded pages or using the documented filter/get operations where a validated resource ID is known.
- Reject conflicting or duplicate structured identities explicitly and test both false-positive and later-page cases.

### R-053 — Branch verification, source persistence, and authorized-source presentation are missing

Severity: **High**
Status: **Open**

Evidence:

- `discoverJulesSource` accepts no selected starting branch and never examines `githubRepo.defaultBranch` or `githubRepo.branches`.
- The official Jules source shape exposes branch objects, and the Sources reference directs clients to retrieve available branches before creating a session with `githubRepoContext.startingBranch`.
- No persistence file or repository changes in this commit; the matched stable `sourceName` is returned only in an HTTP response.
- `availableSources` is returned only on `source_not_installed`; there is no dedicated, authenticated UI/API contract showing all repositories Jules can access, and the planned frontend work is still absent.

Risk:

- Dispatch can proceed with a branch Jules cannot see, failing only after remote work is requested.
- Restart recovery and later dispatch must rediscover a potentially changed mapping instead of using an audited stable source association.
- Users cannot reliably review the authorization scope before selecting cloud execution.

Deferred adjustment:

- Require the intended starting branch as discovery/preflight input and compare it case-sensitively with validated source branch metadata.
- Persist the stable source resource name, normalized repository identity, selected branch, and last verification time through a dedicated repository.
- Revalidate persisted mappings before dispatch and provide a separate safe authorized-source view through the Jules frontend feature.

### R-054 — Discovery statuses misclassify infrastructure failures and expose upstream errors

Severity: **High**
Status: **Open**

Evidence:

- Every exception from listing Jules sources becomes `credentials_missing`, including timeouts, rate limits, forbidden access, malformed responses, and Jules service failures.
- The raw exception message is interpolated into the public `diagnostic`; R-047 already demonstrated that upstream text can reflect arbitrary submitted key material.
- A non-Git repository, a repository without remotes, a failed `git remote -v`, and unparseable remote output all collapse to `remote_missing`.
- `source_not_installed` can also mean first-page truncation or invalid source data rather than a missing GitHub App.

Risk:

- Users receive the wrong remediation and may replace credentials or reinstall integrations during a provider outage or local Git failure.
- Provider or credential details can leak into the API response and global error/logging paths.
- Callers cannot make safe retry, disablement, or user-action decisions from the result status.

Deferred adjustment:

- Model typed results for `not_git`, `remote_missing`, `remote_invalid`, `credentials_missing`, `credentials_invalid`, `forbidden`, `rate_limited`, `provider_unavailable`, `contract_error`, `source_missing`, `branch_missing`, and `connected`.
- Map typed Git and Jules errors without embedding raw upstream text or remote credentials in public diagnostics.
- Keep remediation and presentation text outside the provider adapter so UI wording can evolve independently.

### R-055 — Focused tests are environment-dependent and omit the acceptance boundaries

Severity: **High**
Status: **Open**

Evidence:

- Three discovery tests run real Git commands against `process.cwd()` and assume this checkout's origin is `frankr2994/antigravity-orchestra`.
- The tests can fail in a fork, source archive, worktree without that origin, or CI environment with a rewritten remote.
- Mock source data repeats the incorrect Phase 6 type by representing `defaultBranch` as a string and uses hand-authored resource-name layouts rather than sanitized official fixtures.
- There are no tests for non-Git directories, missing/multiple/fetch-push remotes, Git command errors, malformed or credential-bearing URLs, pagination, conflicting identities, branch visibility, persistence, safe errors, or the HTTP route.
- All four tests passed while R-051 through R-054 remained observable.

Risk:

- The suite is simultaneously flaky across environments and unable to detect the security and correctness failures that matter for dispatch.

Deferred adjustment:

- Use isolated temporary Git repositories or inject a `GitRemoteReader` fake; never depend on the Orchestra checkout's live origin.
- Build table-driven parser and pure matcher tests plus sanitized Jules fixtures.
- Add negative, pagination, branch, persistence, provider-error, and HTTP contract cases before changing discovery behavior.

### R-056 — Source discovery combines infrastructure, provider, application, and presentation concerns

Severity: **High**
Status: **Open**

Evidence:

- The 220-line provider module imports concrete Git commands, `CredentialVault`, credential resolution, and `JulesApiClient` while also parsing remotes, choosing a primary remote, matching identities, classifying failures, and writing user-facing remediation text.
- `createJulesRouter` accepts optional concrete `Store` and `CredentialVault` dependencies and invokes discovery directly; mounting without Store remains possible and becomes a runtime 500.
- GitHub normalization is duplicated rather than extracted from the existing Git infrastructure.
- Direct imports make Git failure paths difficult to isolate, which is why focused tests use the real repository.

Risk:

- Adding another cloud provider, changing credential storage, or revising Git parsing requires edits inside the Jules adapter and route.
- The new module becomes another cross-layer workflow unit instead of reducing monolithic coupling.

Deferred adjustment:

- Separate a pure canonical repository parser/matcher from `GitRemoteReader`, credential, and `JulesSourceGateway` ports.
- Put orchestration and typed outcomes in an application service and map them to HTTP/UI responses in a presenter.
- Require dependencies at composition time and prevent routes/provider adapters from importing concrete Store, vault, or Git command modules directly.

### R-057 — A tokenless GET performs credentialed provider work

Severity: **Medium**
Status: **Open**

Evidence:

- `/projects/:id/jules-source` is a GET that reads the configured Jules key and performs Git and remote Jules API calls on every request.
- `apiAuthMiddleware` exempts GET, HEAD, and OPTIONS requests from origin and `x-orchestra-token` checks.
- The endpoint can return the raw remote URL and, on a miss, the account's available Jules sources.
- No per-project cache, request coalescing, rate limit, or abort propagation is present.

Risk:

- An untrusted local client or cross-site request that can target a known project ID can consume Jules quota and trigger repeated credentialed network traffic without the dashboard token.
- Same-origin compromise or future CORS changes would expose repository authorization metadata and any raw-URL secret described in R-051.

Deferred adjustment:

- Require dashboard authentication and origin checks for provider-backed and configuration-sensitive reads, not only mutations.
- Add bounded caching/coalescing and pass request abort signals through Git/provider operations.
- Return only sanitized repository/source summaries and test unauthorized, cross-origin, repeated, and disconnected-client requests.

## Phase 9 review

### Review scope

- Reviewed commit: `86fc10c2b8a1c2cb17d8bda119a4f91603fa1cb7`
- Commit subject: `feat(jules): implement git branch safety and preflight for cloud dispatch (phase 9)`
- Primary artifacts reviewed: `server/providers/jules/preflight.ts`, focused tests, shared Git status behavior, source discovery dependencies, the Phase 9 and Phase 13 requirements in `julesplan.md`, and official Git reference/push/remote documentation.
- Review date: 2026-08-22
- Review policy: Findings recorded only; implementation repairs deferred.

### Verification performed

- Confirmed that the preflight implementation and focused-test blobs were unchanged between `86fc10c` and the test checkout.
- `node --test tests/jules-preflight.test.mjs`: four tests passed with zero failures after rerunning outside the process sandbox.
- Confirmed that no runtime server code referenced `runJulesPreflight` at this commit; only its definition and focused test did.
- A branch-name probe produced the same dispatch branch for distinct task IDs and distinct full SHAs sharing the same seven-character prefix.
- Inspected the shared Git status implementation and confirmed that it obtains HEAD through `git rev-parse --short HEAD`.
- Compared abbreviated object IDs, ref validation, refspec update semantics, remote-ref inspection, and force-with-lease behavior with the official Git documentation.

### R-058 — The planned Phase 9 API-client work was not implemented or repaired

Severity: **High**
Status: **Open**

Evidence:

- `julesplan.md` defines Phase 9 as the complete Jules REST client with supported source/session/activity operations, validation, pagination, bounded retry, `429` handling, redaction, and sanitized recorded fixtures.
- Commit `86fc10c` changes no client, wire-type, error, or client-test files; R-037 through R-042 therefore remain open.
- The new code belongs to the plan's Phase 13 deterministic cloud-dispatch preflight.
- At this commit, `runJulesPreflight` has no runtime caller, so even the out-of-sequence preflight does not protect a production dispatch path yet.

Risk:

- Phase tracking can mark the API client complete despite known incompatible endpoints, schemas, pagination, retry, validation, and secret-handling behavior.
- A safety component can appear operational before it is integrated into the provider workflow it is intended to guard.

Deferred adjustment:

- Keep the planned Phase 9 open until R-037 through R-042 are resolved and the official alpha contract is revalidated.
- Track the preflight work as partial Phase 13 implementation.
- Integrate preflight through the provider/application boundary only after its safety guarantees and durable evidence are complete.

### R-059 — Preflight records an abbreviated base and generates collision-prone branch names

Severity: **High**
Status: **Open**

Evidence:

- Shared `getGitStatus` obtains HEAD using `git rev-parse --short HEAD`, not the full object ID.
- `runJulesPreflight` returns that abbreviated value as `baseSha` and passes it as the source expression to `git push`.
- `generateDispatchBranchName` keeps only the first eight alphanumeric task-ID characters and the first seven SHA characters.
- A review probe produced identical branch names for two distinct task IDs and two distinct full SHAs that shared those prefixes.
- The generated ref is not checked with `git check-ref-format`, and the full commit is not canonicalized with `rev-parse --verify HEAD^{commit}`.

Risk:

- The recorded base is not the exact immutable commit required for dispatch, persistence, review, and audit correlation.
- Collisions can reuse or move another task's dispatch branch, and future object growth can make a formerly accepted short ID ambiguous.

Deferred adjustment:

- Resolve and persist the repository's full native object ID for `HEAD^{commit}` and compare full IDs end to end.
- Generate a collision-resistant branch suffix from the stable full task identifier plus enough full-SHA-derived entropy.
- Validate the complete ref with `git check-ref-format --branch` and retain a durable task-to-ref mapping.

### R-060 — The pushed branch is not proven immutable or even read back from the remote

Severity: **High**
Status: **Open**

Evidence:

- `createAndPushDispatchBranch` treats a zero-exit `git push` as success and never queries the resulting remote ref.
- The Phase 13 plan explicitly requires confirming that the remote branch resolves to the expected SHA and failing safely on mismatch.
- The push uses an ordinary branch refspec. If a colliding branch already points to an ancestor, Git may fast-forward that existing branch rather than reject reuse.
- There is no create-only lease, expected-old-value check, branch protection, or second comparison immediately before Jules session creation.
- A Git branch remains mutable after a successful push, so calling it “immutable” is an unverified convention rather than an enforced invariant.

Risk:

- Jules can start from a different commit if the branch is reused, advanced, or changed between push and session creation.
- Orchestra can persist a successful preflight result without evidence of what the remote actually advertised.

Deferred adjustment:

- Create the ref with an explicit expected-absence lease or, if it already exists, accept it only after its full remote ID exactly equals the expected base.
- Query `git ls-remote --refs --exit-code origin refs/heads/<dispatch>` after push and compare the full object ID.
- Recheck immediately before dispatch and persist the verified remote ID and verification time transactionally with the attempt.
- Treat any later ref movement as an integrity failure rather than silently continuing.

### R-061 — Upstream and remote-base checks can fail open or inspect the wrong state

Severity: **High**
Status: **Open**

Evidence:

- `checkUnpushedCommits` returns `{ unpushedCount: 0, hasUpstream: true }` when `git rev-list` fails and also converts an unparseable count to zero.
- The comparison uses the local tracking ref `@{upstream}` without fetching or querying the remote, so stale tracking data can be accepted.
- It checks only commits in `@{upstream}..HEAD`; it does not detect a branch that is behind or diverged from its upstream.
- It does not require the configured upstream remote to be `origin`, even though the later push and source discovery target `origin`.
- No command proves that the full local base object was already reachable from the intended remote before the dispatch ref operation.

Risk:

- Git errors are interpreted as “nothing unpushed,” allowing preflight to continue after a failed safety check.
- A stale, divergent, or different-remote upstream can validate one repository state while the dispatch branch is pushed to another.

Deferred adjustment:

- Fail closed on every Git command or parse failure with a typed diagnostic.
- Identify the exact intended remote explicitly and query/fetch its advertised target ref under a repository lock.
- Compute ahead, behind, and divergence from full IDs and apply an explicit policy to each state.
- Record the remote/base evidence used by preflight rather than returning only a count.

### R-062 — Several mandatory Phase 13 preflight checks are absent

Severity: **High**
Status: **Open**

Evidence:

- Source discovery proves only a repository match; neither preflight nor discovery verifies that the selected starting/dispatch branch is visible to Jules (R-053).
- A focused success fixture contains no branch metadata and still passes.
- Listing sources exercises a credential but does not check session quota, Orchestra's Jules concurrency policy, or whether dispatch is currently permitted.
- No repository-level Git-operation lock is acquired around status inspection, branch creation, push, or remote verification.
- Origin validation and Source matching inherit the malformed-remote and false-match problems in R-051 and R-052.
- The preflight result contains no structured per-check evidence, so later code cannot tell which safety facts were established.

Risk:

- A green preflight can still dispatch to an unavailable branch, exceed policy/quota, race another Git operation, or use the wrong repository Source.

Deferred adjustment:

- Implement every Phase 13 check as an explicit typed step with recorded evidence and a fail-closed outcome.
- Verify Jules branch visibility after the dispatch ref is remotely confirmed, with bounded propagation handling.
- Check credential validity, provider availability, quota/concurrency policy, and feature enablement without creating a session.
- Hold a repository-scoped lock across mutable Git preflight operations and release it through a tested lifecycle.

### R-063 — A production-shaped `skipPush` flag bypasses the central guarantee and no branch lifecycle exists

Severity: **Medium**
Status: **Open**

Evidence:

- `JulesPreflightContext` publicly exposes `skipPush`; when true, preflight returns `ok: true` and describes the generated branch as ready without creating it remotely.
- The flag is intended for tests but is part of the same exported runtime API and result shape.
- No retention period, cleanup queue, deletion method, ownership metadata, or recovery policy exists for branches that are actually pushed.
- The Phase 13 acceptance criteria explicitly require documented temporary-branch retention and cleanup rules.

Risk:

- Accidental or propagated dry-run configuration can bypass remote preparation while producing a normal success result.
- Real dispatch branches accumulate indefinitely or are deleted manually without Orchestra knowing, undermining recovery and auditability.

Deferred adjustment:

- Separate pure preflight planning from an execution method that cannot report remote readiness until verification succeeds.
- Inject a fake Git-remote port in tests instead of carrying a production bypass flag.
- Persist branch ownership/lifecycle state and implement idempotent cleanup with retention, active-session protection, retry, and audit rules.

### R-064 — Preflight exposes raw Git/provider errors and lacks stable failure codes

Severity: **Medium**
Status: **Open**

Evidence:

- Push failures interpolate raw `stderr` or `stdout` into the returned error and then into the public preflight reason.
- Git output can contain remote URLs, usernames, filesystem paths, credential-helper details, or host diagnostics.
- Source-discovery diagnostics are also inserted directly and retain the upstream-leak risk from R-047/R-054.
- `JulesPreflightResult` uses optional free-text `reason`, `diagnostic`, and `resolution` rather than stable check/error codes and sanitized structured context.

Risk:

- Secrets or local environment details can flow into API responses, task records, events, or logs.
- Callers must parse prose to decide whether to retry, request user action, or disable cloud dispatch.

Deferred adjustment:

- Return typed check IDs, failure codes, safe metadata, and retry/user-action classification.
- Redact remote URLs and provider/Git output before correlated diagnostic logging; never return raw command output to clients.
- Render user-facing explanations outside the Git/provider adapter.

### R-065 — Focused tests bypass the remote branch safety behavior

Severity: **High**
Status: **Open**

Evidence:

- The success test fabricates `refs/remotes/origin/main` locally, points origin at a real GitHub URL, and calls preflight with `skipPush: true`.
- It therefore performs no push, remote ref creation, remote read-back, exact-SHA comparison, collision handling, or cleanup.
- `createAndPushDispatchBranch` has no direct test.
- The branch-name tests cover two happy examples but no empty/colliding task IDs, short/invalid/full object IDs, ref-format validation, or repository hash-format variation.
- The upstream test calls the live Orchestra checkout and asserts only JavaScript types, not correct ahead/behind/error behavior.
- There are no tests for command failure, stale/wrong upstream, behind/diverged history, existing mismatched refs, concurrent movement, Jules branch propagation, quota, locking, redaction, or cleanup.

Risk:

- All four tests pass without exercising the properties described as immutable branch safety.
- Environment dependence and bypass flags conceal regressions in the most consequential paths.

Deferred adjustment:

- Use isolated local bare remotes to exercise create-only push, existing-equal, existing-conflicting, fast-forward collision, read-back, mismatch, and cleanup behavior.
- Inject deterministic Git/source/quota/lock ports for error and race tests.
- Assert full object IDs and structured evidence at every successful check.

### R-066 — Preflight is another cross-layer provider module rather than an application workflow port

Severity: **High**
Status: **Open**

Evidence:

- `preflight.ts` imports concrete Git commands, project path policy, vault/client types, and source discovery while also generating names, mutating a remote, orchestrating checks, and composing user-facing text.
- It does not implement the `ExecutionProvider.preflight` interface introduced in Phase 3 and is not consumed by a provider adapter at this commit.
- Concrete imports and the `skipPush` workaround make the central remote behavior difficult to test without process and network side effects.
- This repeats the coupling already tracked in R-029 and R-056 instead of advancing the modular provider architecture.

Risk:

- Git policy, provider capability, credential storage, and UI messaging will evolve inside one module and require broad edits for every additional cloud provider.
- The safety logic cannot be reused or enforced consistently at other dispatch entry points.

Deferred adjustment:

- Move dispatch preflight orchestration into an application service over narrow Git snapshot, remote-ref, repository-lock, source, credential/quota, and persistence ports.
- Implement the provider-neutral preflight contract through a Jules adapter and keep Git ref preparation as an independently testable infrastructure service.
- Keep presentation mapping at the API/UI boundary and add architecture checks for these dependency directions.

## Phase 10 review

### Review scope

- Reviewed commit: `928b10212ccc6216b80681ff36dd25d29fa5bf1d`
- Commit subject: `feat(jules): implement core jules cloud dispatch and session lifecycle manager (phase 10)`
- Primary artifacts reviewed: `server/providers/jules/session-manager.ts`, Jules wire types and client behavior, domain state mapping, focused tests, the Phase 10 and later lifecycle requirements in `julesplan.md`, and the official Jules session, type, and activity references.
- Review date: 2026-08-22
- Review policy: Findings recorded only; implementation repairs deferred.

### Verification performed

- Confirmed that `session-manager.ts` was unchanged between `928b102` and the review checkout by comparing its Git blob ID (`66bfedc7bdf37098b38c75a68853dcc6b85b9796`).
- `npm run build:server`: passed with zero TypeScript errors.
- `node --test tests/jules-session-manager.test.mjs`: one test passed with zero failures after rerunning outside the process sandbox.
- Confirmed with `git grep` that `JulesSessionManager` had no production caller at this commit; only its definition and focused test referenced it.
- Compared session creation, outputs, lifecycle methods, activities, pagination, and payload shapes with the official Jules API documentation.

### R-067 — The planned Phase 10 secure configuration was not implemented

Severity: **High**
Status: **Open**

Evidence:

- `julesplan.md` defines Phase 10 as secure configuration for endpoint, API-key reference, polling interval, request timeout, retry limits, maximum concurrency, plan-approval default, and the Jules feature flag.
- Commit `928b102` instead adds explicit dispatch plus fragments of polling and cancellation, work assigned to later plan phases.
- The manager hard-codes a 15-second timeout and a false plan-approval default; it adds no configuration schema, endpoint setting, polling interval, retry limit, maximum-session policy, feature flag, or connectivity check.
- The OS-protected credential and safe-error deficiencies already recorded in R-044 through R-049 remain unresolved.
- At this commit the new manager is not called by production code, so it cannot constitute an operational Phase 10 configuration path.

Risk:

- Phase tracking can mark secure configuration complete while cloud execution has no enforceable feature gate, concurrency limit, centrally validated settings, or compliant secret store.
- Hard-coded behavior will spread across later lifecycle components and be more disruptive to repair.

Deferred adjustment:

- Keep planned Phase 10 open until every listed setting has one typed, validated source and secrets are stored through an OS-protected facility.
- Add a provider connectivity check with stable, actionable, redacted errors and tests at both service and HTTP boundaries.
- Inject one immutable Jules configuration object into provider components rather than reading or hard-coding settings throughout the lifecycle.

### R-068 — Session creation and output handling use incompatible Jules wire shapes

Severity: **High**
Status: **Open**

Evidence:

- `dispatchSession` sends `autoPr: boolean`, but the documented session create request uses `automationMode: "AUTO_CREATE_PR"`.
- The local types model `outputs` as an object containing `pullRequest`; the documented Session uses a list of `SessionOutput` values.
- The manager reads `outputs.pullRequest.headCommitSha`, but the documented pull-request output exposes URL, title, and description, not a head commit SHA.
- The focused mock reproduces these invented shapes and never asserts the actual create-request body, allowing the compatibility error to pass.
- Remote `name`, `id`, state, outputs, and activity values are accepted through compile-time casts with no runtime schema validation; `name.split('/').pop()!` can create an invalid local identifier.

Risk:

- Automatic PR creation may not be enabled, and a real completed session's PR output will not be captured.
- Invalid or changed alpha responses can corrupt lifecycle state or create records that cannot be polled or reconciled.

Deferred adjustment:

- Regenerate or hand-maintain wire DTOs from the current official contract, send `automationMode`, and parse the output union/list explicitly.
- Obtain commit identity from a verified GitHub/ref workflow rather than an undocumented provider field.
- Validate every provider response at runtime and return typed protocol errors when required names, IDs, states, or payload variants are invalid.

### R-069 — Dispatch is neither atomic nor idempotent

Severity: **High**
Status: **Open**

Evidence:

- The remote session is created before any durable dispatch intent, execution attempt, or cloud-session reference is recorded.
- Attempt creation, cloud-session creation, event insertion, callback delivery, and task update are independent operations with no transaction or compensating reconciliation.
- A failure after remote creation is not caught, so the method can throw while leaving remote work orphaned or local records only partially written.
- The Jules client retries transient requests, including session-creation POSTs, without an idempotency key or a lookup/reconciliation step for an ambiguous timeout.
- No uniqueness rule or pre-dispatch check prevents multiple cloud sessions for the same task/attempt.

Risk:

- Process, network, or database failures can produce duplicate billable work, orphaned remote sessions, or contradictory local state.
- Recovery cannot determine whether it is safe to retry creation because the decision and provider correlation were never durably recorded.

Deferred adjustment:

- Persist a uniquely keyed dispatch intent before network work, then claim it through a transactional outbox/state-machine transition.
- On ambiguous create outcomes, reconcile by durable correlation before any retry; never blindly repeat a non-idempotent create.
- Transactionally persist the provider identity, attempt transition, cloud-session reference, task event, and task state, with explicit recovery for every boundary failure.

### R-070 — Completion bypasses mandatory review and produces contradictory states

Severity: **High**
Status: **Open**

Evidence:

- `mapJulesToOrchestraState('COMPLETED')` returns task state `reviewing` and `isTerminal: false`, reflecting the plan's independent-review boundary.
- The new `isJulesTerminalState('COMPLETED')` returns true, so a single state has two conflicting terminal classifications in the same domain module.
- `pollSession` returns `orchestraState: 'reviewing'` and `isTerminal: true` while separately writing the task itself as `completed` and emitting `cloud.completed`.
- No PR identity verification, independent Codex review, baseline comparison, or merge-readiness check occurs before that completed task transition.
- Every subsequent completed poll emits another completion event because no previous-state transition guard exists.

Risk:

- Untrusted cloud-generated code is presented as completed before review or verification, violating a central safety invariant.
- Consumers observing the method result, task row, mapper, and event stream can make incompatible scheduling and UI decisions.

Deferred adjustment:

- Define completion once in the provider-neutral state machine: provider completion must transition to review intake, not task completion.
- Use the mapper's full result as the sole lifecycle decision and remove duplicate terminal helpers.
- Enforce legal compare-and-set transitions and emit transition events exactly once after durable state changes.

### R-071 — Polling can lose, duplicate, or silently suppress provider activity

Severity: **High**
Status: **Open**

Evidence:

- `listActivities` returns only the first page and discards `nextPageToken`, while the official endpoint is paginated.
- Activity-fetch failures are converted to an empty list even when the session request succeeds, so missing audit data is indistinguishable from no activity.
- Deduplication primarily compares timestamps; distinct activities with equal, missing, invalid, or out-of-order creation times can be skipped or replayed.
- The cursor is set from `activities.at(-1)` without validating ordering and stores an ID that is not actually used for ID-based deduplication once a timestamp exists.
- Events and callbacks occur before the cursor update, so a crash or callback failure can replay work or prevent cursor persistence.
- The implementation is a single poll call, with no persisted next-poll time, lease, bounded backoff, timeout lifecycle, restart scheduler, or terminal-transition guard required by the plan.

Risk:

- Important plans, user-action requests, progress, failures, and artifacts can be permanently missed or multiply emitted.
- Multiple processes or restarts can poll and process the same session concurrently without an ownership mechanism.

Deferred adjustment:

- Implement a paginated activity adapter and persist a stable `(createTime, activity identity)` cursor only in the same transaction as normalized events.
- Treat activity-fetch failure as an observable partial poll failure and retry it under bounded backoff.
- Add a durable scheduler/lease with configured intervals, jitter, deadline, restart recovery, and state-transition idempotency.

### R-072 — Cancellation reports success without confirming that remote work stopped

Severity: **High**
Status: **Open**

Evidence:

- Repair checkpoint (2026-08-23): cancellation is now fail-closed at both the HTTP and session-manager boundaries. It returns `JULES_CANCELLATION_UNSUPPORTED`, performs no provider deletion, and does not mutate task, cloud-session, or event state. Focused no-side-effect tests and the complete 127-test offline suite pass. The finding remains open until the later durable lifecycle-control model is complete.

- `cancelSession` calls an undocumented `:pause` endpoint rather than a documented cancellation operation.
- Every remote error is swallowed, after which the cloud session is unconditionally set to `CANCELLED`, the task is set to `failed`, and `{ ok: true }` is returned.
- Pausing and cancelling have different semantics; even a successful pause would not prove terminal cancellation.
- No current-state check prevents cancellation after provider completion. The focused test explicitly cancels its completed fixture and asserts that `COMPLETED` is overwritten with `CANCELLED`.
- The documented session API exposes delete, but no product policy decides whether deletion is an acceptable substitute or how it affects recovery and audit history.

Risk:

- The UI can claim cancellation while Jules continues changing code or opening a PR.
- Completed evidence can be destroyed locally, and a legitimate cancelled task is misclassified as a failure.

Deferred adjustment:

- Do not expose cancellation until a supported remote semantic is selected and verified; model pause, delete, cancellation request, confirmed cancellation, and cancellation failure separately.
- Permit the action only from legal states and use compare-and-set transitions that cannot overwrite completion.
- Preserve and surface the sanitized remote result, and reconcile uncertain outcomes through polling rather than declaring success.

### R-073 — Raw provider payloads cross the trust boundary into durable events

Severity: **High**
Status: **Open**

Evidence:

- Every qualifying Jules activity is persisted wholesale as a task-event payload and passed unchanged to the callback.
- The official activity schema can include patches, shell output, and media artifacts; the implementation applies no allow-list, size bound, encoding check, redaction, or content classification.
- Provider error messages and preflight reasons are returned as plain strings, inheriting the upstream-detail exposure tracked in R-047, R-054, and R-064.
- PR URLs and provider resource names are accepted without repository, host, or ownership validation before persistence and event emission.

Risk:

- Secrets, large patches, command output, binary material, hostile strings, or unrelated repository links can enter SQLite, SSE/event consumers, logs, and the UI.
- Storage exhaustion and stored-content injection become possible at a provider-controlled boundary.

Deferred adjustment:

- Validate and normalize provider activities into a small provider-neutral event vocabulary; store large artifacts in a bounded, access-controlled artifact channel.
- Apply explicit byte/count limits, safe encodings, redaction, and hostile-content tests before persistence or publication.
- Validate PR/repository identity against the dispatch source and expose only structured safe diagnostics to callers.

### R-074 — Attempts, cloud sessions, tasks, and failures do not share one lifecycle

Severity: **High**
Status: **Open**

Evidence:

- Dispatch creates an execution attempt in `WORKING`, but polling and cancellation never update that attempt to completed, failed, cancelled, or review-pending.
- The cloud-session record is looked up only by remote ID and is not linked to the attempt, retaining the correlation gap in R-024.
- Poll failures are returned transiently but are not recorded against the attempt/session with retry count, next-poll time, or terminal reason.
- State updates across the cloud session, task, attempt, and events are not transactional and enforce no transition version or owner.

Risk:

- Recovery and audit views can report a permanently working attempt beside a completed, failed, or cancelled task.
- Later retries and reviews cannot reliably identify which provider execution produced a PR or failure.

Deferred adjustment:

- Make the attempt the aggregate root for dispatch and lifecycle state, with unique provider correlation and an explicit linked cloud-session projection.
- Update attempt, task projection, session metadata, cursor, and outbox events through versioned transactions.
- Persist retry/error/next-action metadata so recovery can resume deterministically after restart.

### R-075 — The focused test encodes invalid behavior and omits failure boundaries

Severity: **High**
Status: **Open**

Evidence:

- The sole test uses `skipPush: true`, never inspects the create-request body, and returns the same incorrect object-shaped outputs and invented `headCommitSha` expected by production code.
- It accepts the contradictory completed result (`reviewing` plus terminal), does not assert the persisted task state, and then treats cancellation of that completed session as successful behavior.
- It contains no cases for invalid responses, missing IDs, POST ambiguity, duplicate dispatch, partial database failure, activity pagination/error/ordering/deduplication, repeated terminal polls, restart recovery, concurrency, or payload limits.
- The test passes and the server type-check succeeds, demonstrating internal consistency only—not compatibility, durability, or lifecycle safety.

Risk:

- Regression tests will preserve the wrong wire contract and false-success semantics while critical crash and retry paths remain unexercised.

Deferred adjustment:

- Build sanitized fixtures from documented response shapes and assert exact outbound method, path, query, headers, and body.
- Add deterministic fault injection at each network/database/event boundary and restart the service between lifecycle steps.
- Test pagination, equal/out-of-order timestamps, duplicate IDs, repeated terminal polls, legal transitions, uncertain cancellation, and bounded/redacted payloads.

### R-076 — The session manager extends the monolith instead of implementing provider ports

Severity: **High**
Status: **Open**

Evidence:

- The 303-line class combines credential resolution, preflight orchestration, API construction, request mapping, dispatch policy, four persistence concerns, event publication, polling, deduplication, output extraction, task transitions, and cancellation.
- It depends directly on concrete `Store`, `CredentialVault`, `JulesApiClient`, and `runJulesPreflight` implementations rather than the provider-neutral interfaces established earlier in the plan.
- It does not implement or compose through `ExecutionProvider`; at this commit no production application workflow calls it.
- Test-only concerns (`julesClient`, vault, callbacks, and `skipPush`) are exposed through the production dispatch options instead of narrow injected ports.

Risk:

- Adding another provider, scheduler, recovery policy, output type, or review transition requires editing one cross-layer module and can disrupt working dispatch behavior.
- Important failure modes remain hard to isolate, test, or reuse, directly opposing the plan's modularity objective.

Deferred adjustment:

- Split provider wire transport/mapping, dispatch application service, durable lifecycle repository, activity ingestion, scheduler/lease, transition policy, and event outbox behind narrow interfaces.
- Compose those modules at bootstrap through `ExecutionProvider`; keep Jules-specific DTOs inside the adapter and provider-neutral state/policies in the application/domain layers.
- Add dependency-direction and module-size checks so later phases extend ports or add modules instead of growing a new lifecycle monolith.

## Phase 11 review

### Review scope

- Reviewed commit: `c4ab60f158d0b1aa49af25906d8590d0730a14b2`
- Commit subject: `feat(jules): build worktree-isolated pull request review engine (phase 11)`
- Primary artifacts reviewed: `server/providers/jules/worktree-review.ts`, shared Git/process/verification helpers, focused tests, planned Phases 11 and 19–25 in `julesplan.md`, and official Git/GitHub ref, diff, fetch, and worktree documentation.
- Review date: 2026-08-22
- Review policy: Findings recorded only; implementation repairs deferred.

### Verification performed

- Confirmed that `worktree-review.ts` was unchanged between `c4ab60f` and the review checkout by comparing its Git blob ID (`81ef4cff14e45851532885f632ae7e9d39b180fe`).
- `npm run build:server`: passed with zero TypeScript errors.
- `node --test tests/jules-worktree-review.test.mjs`: three tests passed with zero failures.
- Confirmed with `git grep` that the worktree-review functions had no production caller at this commit; only their definitions and focused tests referenced them.
- An invalid-base probe returned `ok: true`, `verified: true`, an empty diff, and no changed files after Git rejected the nonexistent base.
- A missing-head probe silently reviewed the primary repository's current `HEAD` and returned success.
- A local-remote probe fetched one PR head but reviewed a different caller-supplied SHA and still returned success.
- Path probes showed that a fully stripped task ID resolves to the shared worktree parent and distinct long task IDs can resolve to the same truncated path.
- A project with no recognized checks returned `verified: true` with zero verification results.
- Compared three-dot diff semantics, forced fetch refspecs, PR refs, and shared worktree metadata with official Git and GitHub documentation.

### R-077 — The planned Phase 11 source-discovery work remains incomplete

Severity: **High**
Status: **Open**

Evidence:

- `julesplan.md` defines Phase 11 as source listing, canonical GitHub repository matching, starting-branch visibility, missing-App remediation, stable source persistence, and authorized-repository presentation.
- Commit `c4ab60f` changes no source-discovery implementation, route, persistence, or frontend file; R-051 through R-057 therefore remain open.
- The new code instead attempts portions of planned Phase 19 PR import, Phase 20 isolated verification, Phase 24 repository concurrency, and Phase 25 cleanup.
- The worktree-review module has no production caller at this commit, so the out-of-sequence code does not protect a completed cloud session.

Risk:

- Phase tracking can report repository authorization and source matching complete despite known false matches, malformed-remotes, missing branch checks, absent persistence, and unsafe API exposure.
- Later phases may build on an unverified source identity while an unrelated review prototype is mistaken for the Phase 11 deliverable.

Deferred adjustment:

- Keep planned Phase 11 open until R-051 through R-057 are resolved and its acceptance criteria are exercised end to end.
- Track this commit only as partial work toward Phases 19, 20, 24, and 25.
- Integrate PR review only after source identity, cloud persistence, polling, and exact PR resolution establish a trustworthy input.

### R-078 — Review can target a different or entirely local commit instead of the PR head

Severity: **High**
Status: **Open**

Evidence:

- `WorktreeReviewOptions` independently accepts `prNumber`, `headBranch`, and `headSha` without defining precedence or requiring agreement.
- When `headSha` and `prNumber` are both supplied, the manager fetches `refs/pull/<number>/head` but retains the supplied SHA instead of resolving and comparing the fetched ref.
- A review probe fetched PR head `4cfb1143672cc0b872d7aa6dac46e342719cf20c`, reviewed supplied SHA `e393cbeb553f4f7190813483830dfe8b6fa07ed0`, and returned `ok: true`.
- If fetched-ref resolution fails, or if `skipFetch` is true without a head SHA, the code silently resolves the primary repository's current `HEAD` and reviews it.
- A missing-head probe confirmed that local fallback and returned `ok: true` and `verified: true`.
- No PR URL/repository validation, GitHub PR metadata lookup, fork handling policy, persisted head identity, or pre-verdict re-fetch exists. A provider-supplied branch can be treated as authoritative contrary to Phase 19.

Risk:

- Orchestra can approve, verify, or later merge code different from the PR the user saw.
- A force-push or ambiguous input does not invalidate prior evidence, defeating the exact-SHA review invariant.

Deferred adjustment:

- Resolve a validated repository-owned PR number/URL through GitHub metadata, fetch its head into a task-owned ref, and derive the one authoritative full SHA from that ref.
- Reject missing, contradictory, stale, or changed identities; never fall back to local `HEAD` or a provider branch name.
- Persist the resolved SHA and compare it again before every verification, verdict, repair cycle, approval, and integration action.

### R-079 — Git failures and ambiguous diff semantics can produce a clean success

Severity: **High**
Status: **Open**

Evidence:

- The exit codes from both `git diff` commands are ignored; only stdout is consumed.
- A probe using a nonexistent base object caused Git to reject the comparison, yet returned `ok: true`, `verified: true`, an empty diff, and an empty changed-file list.
- Fallback `rev-parse HEAD` also assigns stdout without checking its exit code or validating a full commit object.
- The implementation describes its result as an exact base-to-head diff but executes `baseSha...HEAD`. Git defines three-dot comparison against the merge base, which can hide divergence between the recorded base and that merge base.
- Neither full ID is canonicalized with `rev-parse --verify <id>^{commit}`, and no ancestry or expected-base relationship is checked.
- Changed files are parsed by newline and trimmed rather than using a NUL-delimited format, corrupting legal filenames containing newlines or leading/trailing whitespace.

Risk:

- Invalid, divergent, or missing history can be represented as a verified no-change PR.
- Review packets and later merge decisions can omit changed files or compare against a base different from the recorded dispatch invariant.

Deferred adjustment:

- Validate exact full commit IDs and the required ancestry/repository relationship before creating a worktree.
- Check every Git exit code and return typed failure evidence; an empty stdout is never proof of an empty diff.
- Deliberately choose endpoint-tree or merge-base comparison according to policy, label it accurately, and use `--name-only -z` or `--name-status -z` for filenames.

### R-080 — Fetch mutates shared refs without ownership or repository locking

Severity: **High**
Status: **Open**

Evidence:

- PR fetches force-update `refs/remotes/origin/pr/<number>` and branch fetches force-update `refs/remotes/origin/<headBranch>` through a leading `+` refspec.
- The branch form can overwrite an ordinary shared tracking ref such as `refs/remotes/origin/main`.
- Ref names are shared by every task and review cycle rather than namespaced to a durable attempt/review owner.
- No repository Git-operation lock covers fetch, ref resolution, worktree addition, removal, or pruning as required by Phase 24.
- Fetched refs are never deleted, and no expected-old-value or post-fetch ownership check detects concurrent movement.

Risk:

- Concurrent completions can overwrite each other's evidence, review a ref after another process moved it, or perturb the repository state observed by users and other Orchestra workflows.

Deferred adjustment:

- Fetch into a unique validated namespace such as `refs/orchestra/reviews/<attempt-id>/head` while holding a repository lock.
- Resolve and persist the resulting object ID before releasing the lock, then use the immutable ID for the worktree.
- Remove only owner-recorded temporary refs through idempotent locked cleanup; never force-update normal remote-tracking refs for review.

### R-081 — Worktree path collisions can trigger destructive cross-task cleanup

Severity: **High**
Status: **Open**

Evidence:

- `getWorktreePath` strips characters from the task ID and truncates it to 32 characters without rejecting an empty result or adding collision-resistant identity.
- A probe mapped `../../` to the shared `.orchestra/worktrees` parent itself and mapped two distinct long IDs to the same child path.
- If that path already exists, `createIsolatedWorktree` ignores `git worktree remove` failure and recursively deletes the path without checking an ownership record.
- Cleanup similarly suppresses removal/prune/filesystem failures, does not verify a canonical path beneath a configured managed root, and globally runs `git worktree prune` without a lock.
- The path is placed inside each project rather than the plan's Orchestra-managed data directory.
- If `git worktree add` partially creates metadata or files but exits nonzero, `runWorktreeReview` has not yet assigned `worktreePath`, so its `finally` block does not attempt cleanup.

Risk:

- One malformed or colliding task can delete the shared worktree directory or another active review's checkout.
- Silent cleanup failures leave executable untrusted files and shared Git metadata behind with no recovery record.

Deferred adjustment:

- Allocate unpredictable unique directories beneath one canonical managed root and persist an owner token before creation.
- Resolve and verify containment and ownership before every remove; reject empty, truncated, colliding, reparse-point, or unexpected paths.
- Perform add/remove/prune under the Git lock, record partial creation before invoking Git, and persist cleanup failures for bounded retry.

### R-082 — Verification executes untrusted PR code on the Orchestra host and can pass without checks

Severity: **High**
Status: **Open**

Evidence:

- `verifyProject` executes npm scripts or pytest selected from cloud-generated repository files with the host process's privileges and working environment.
- `runProcess` explicitly merges the full `process.env`; no secret-reduced environment, filesystem sandbox, network policy, dependency/install-script policy, CPU/memory limit, or aggregate output limit is applied.
- Process output is accumulated without a bound before only the final stored string is truncated.
- The reviewer does not install dependencies deterministically from lockfiles, so missing packages can produce misleading failures and existing host/worktree state can influence results.
- `verified` is computed with `verificationResults.every(...)`; an empty result set, including no supported project or malformed package metadata, therefore passes.
- A probe confirmed `verified: true` with zero configured verification results. `skipVerification: true` also explicitly returns verified rather than skipped.
- Verification results are returned in memory but not durably tied to the exact SHA.

Risk:

- A malicious PR can read credentials, modify accessible files, access the network, spawn processes, or exhaust memory during what is presented as review.
- Users can receive a green verification result when no check ran or when the reviewed environment was not reproducible.

Deferred adjustment:

- Execute untrusted checks in a constrained worker/container with a minimal environment, read-only inputs where possible, explicit network policy, resource/output limits, and reliable process-tree termination.
- Install dependencies deterministically under an explicit install-script policy and record toolchain/lockfile identity.
- Model `not_configured`, `skipped`, `passed`, `failed`, `timed_out`, and `infrastructure_error` separately; only `passed` may satisfy the merge gate.
- Persist structured results with the exact head SHA and invalidate them whenever that SHA changes.

### R-083 — Review evidence is neither durable nor connected to the cloud lifecycle

Severity: **High**
Status: **Open**

Evidence:

- `runWorktreeReview` accepts loose caller values and returns a transient object; it reads or writes no cloud session, execution attempt, review cycle, event, or verification record.
- No transaction connects the resolved head, diff, changed files, checks, verdict state, and task transition.
- The module has no production caller at this commit and therefore cannot resume after a crash or prevent stale review reuse.
- Diff and command outputs are returned as potentially large in-memory strings with no durable artifact identity, content hash, or explicit size policy.
- Cleanup occurs before any caller can independently inspect the worktree, while cleanup failures are suppressed and absent from the result.

Risk:

- Restart recovery cannot prove which commit and evidence were reviewed, and later code can accidentally attach results to a changed PR.
- Audit data can be lost while stale or incomplete results still influence task state.

Deferred adjustment:

- Introduce a durable review aggregate linked to cloud session, attempt, cycle, base SHA, and exact head SHA.
- Persist bounded/hash-addressed artifacts and structured verification results before emitting a review-ready transition.
- Drive review through an idempotent application workflow with explicit states for resolving, fetching, verifying, reviewing, cleanup-pending, and failed/recoverable.

### R-084 — Focused tests bypass every remote and verification safety boundary

Severity: **High**
Status: **Open**

Evidence:

- The end-to-end helper test supplies local commits while setting both `skipFetch: true` and `skipVerification: true`.
- No test calls `fetchPullRequestRef`, uses a bare remote or fork PR, checks fetched-versus-supplied identity, simulates a force-push, or asserts temporary-ref cleanup.
- No test covers invalid/missing base or head objects, Git nonzero exits, divergent history, three-dot behavior, unusual filenames, ref collisions, concurrent reviews, locks, partial worktree creation, ownership, cleanup failure, or restart.
- Verification tests cover neither real commands nor no-check/malformed manifests, failure, timeout, cancellation, environment isolation, output limits, child processes, or deterministic dependency setup.
- All three focused tests passed while the false-success and path-collision probes remained reproducible.

Risk:

- The suite demonstrates basic happy-path Git mechanics but cannot protect the exact-commit, isolation, cleanup, and untrusted-execution guarantees implied by the feature name.

Deferred adjustment:

- Use isolated local bare remotes to test exact PR refs, forks, force-push changes, contradictory identity inputs, and task-owned ref cleanup.
- Inject Git, worktree storage, verification runner, clock, lock, and persistence ports for deterministic boundary-failure and concurrency tests.
- Add adversarial path, filename, no-check, malicious-script, resource-limit, crash/restart, and cleanup-retry cases before enabling the workflow.

### R-085 — Worktree review is another monolithic cross-layer provider module

Severity: **High**
Status: **Open**

Evidence:

- The 230-line Jules provider file combines task-path policy, filesystem deletion, Git remote strategy, ref mutation, worktree lifecycle, diff construction, verification orchestration, error presentation, and result composition.
- It imports concrete Git and verification implementations instead of provider-neutral PR-resolution, Git-repository, managed-worktree, and verification-runner ports.
- Generic GitHub/Git/worktree behavior is placed under the Jules adapter even though it should be reusable for other providers and local review workflows.
- Public production options include `skipFetch` and `skipVerification`, allowing central safety steps to be bypassed instead of injecting controlled test doubles.
- No production composition root connects the module to `ExecutionProvider` or an application workflow.

Risk:

- Adding another provider, Git host, verification environment, storage policy, or recovery state requires editing one destructive cross-layer unit and risks disrupting working review behavior.
- The bypass flags and concrete dependencies make critical failure paths difficult to test without real filesystem and process side effects.

Deferred adjustment:

- Separate PR identity resolution, task-owned ref fetching, managed worktree allocation, diff/artifact generation, verification execution, persistence, transition policy, and cleanup into narrow modules.
- Keep Jules-specific output mapping in its adapter and place reusable GitHub/Git review services behind provider-neutral application ports.
- Remove production bypass flags, compose fakes at dependency injection boundaries, and add architecture checks that enforce dependency direction and module responsibility.

## Phase 12 review

### Review scope

- Reviewed commit: `1dc1d322f99e3407480e9d47e169a33097a58346`
- Commit subject: `feat(jules): implement independent codex review for jules cloud PRs (phase 12)`
- Primary artifacts reviewed: `server/providers/jules/codex-review.ts`, shared Codex app-server/agent behavior, domain review contracts, focused tests, planned Phases 12 and 21 in `julesplan.md`, and official OpenAI Codex non-interactive automation documentation.
- Review date: 2026-08-22
- Review policy: Findings recorded only; implementation repairs deferred.

### Verification performed

- Resolved the unspecified Phase 12 commit from Git history as `1dc1d322f99e3407480e9d47e169a33097a58346`.
- Confirmed that `codex-review.ts` was unchanged between `1dc1d32` and the review checkout by comparing its Git blob ID (`ff9b0784ff07f2f6c8eb0d86d13fe74b549c75fc`).
- `npm run build:server`: passed with zero TypeScript errors.
- `node --test tests/jules-codex-review.test.mjs`: four tests passed with zero failures.
- Confirmed with `git grep` that the Jules Codex-review functions had no production caller at this commit; only their definitions and focused tests referenced them.
- A contradictory-output probe returned `PASS` and `blocked: false` while also returning a parsed `blocking` finding.
- A packet-boundary probe reached 100,000 characters and silently omitted the entire diff and final reviewer instructions.
- The same packet probe retained an `sk-proj-...` credential that the redactor did not recognize.
- Compared the invocation with official OpenAI guidance for read-only Codex automation, JSONL event output, schema-constrained final output, and automation credential isolation.

### R-086 — The planned Phase 12 cloud persistence model was not implemented

Severity: **High**
Status: **Open**

Evidence:

- `julesplan.md` defines Phase 12 as durable cloud execution persistence containing provider/session/source identity, branches, exact base/head SHAs, provider state, activity cursor, polling lease, PR, review/repair cycles, failure data, and lifecycle timestamps.
- Commit `1dc1d32` adds no schema, migration, cloud-session repository, attempt linkage, polling lease, or recovery behavior.
- The incomplete persistence and correlation findings already recorded in R-018 through R-024 and R-074 remain unresolved.
- The new code instead attempts part of planned Phase 21 independent Codex review and has no production caller at this commit.

Risk:

- Phase tracking can mark crash-recoverable cloud persistence complete while review, polling, retry, and PR identity remain dependent on loose in-memory values.
- Later review and repair code cannot establish one durable execution history or safely resume after restart.

Deferred adjustment:

- Keep planned Phase 12 open until the full cloud-attempt/session/review persistence model and migrations meet every listed acceptance criterion.
- Make the execution attempt the aggregate root and add versioned linked records for provider session, poll lease/cursor, exact PR identity, review cycle, repair cycle, and failure/recovery state.
- Integrate Phase 21 only after a transactionally persisted exact head SHA and verification record are available.

### R-087 — A verdict is not bound to the exact PR commit or its worktree

Severity: **High**
Status: **Open**

Evidence:

- `runCodexReviewForJules` accepts caller-provided `baseSha`, `headSha`, `diff`, `changedFiles`, verification results, and `projectRoot` without validation or cross-checking.
- The focused success test passes `base123` and `head456`, which are not Git object IDs, and receives a passing review.
- The real runner is rooted at `projectRoot`, not explicitly at a detached worktree whose `HEAD` has been verified against `headSha`.
- Phase 11's worktree helper deletes its isolated checkout before returning, so these two modules cannot currently compose into an exact-head inspection workflow.
- The review result does not contain `reviewedSha`; the persisted event contains neither base nor head SHA.
- No pre-review or post-review ref refresh detects a force-push, and no stored version prevents a verdict from being reused after the PR changes.

Risk:

- Codex can inspect surrounding files from the primary workspace while judging a bounded diff from a different commit.
- Orchestra can approve or repair against stale, fabricated, or mismatched evidence and later apply that verdict to another PR head.

Deferred adjustment:

- Accept only a durable review-record ID, load its validated full base/head IDs, and open the task-owned detached worktree at that exact head.
- Verify worktree `HEAD`, diff/artifact hashes, and linked verification SHA immediately before invoking Codex.
- Persist `reviewedSha` on every verdict and invalidate the record atomically when a refreshed PR head differs.

### R-088 — The review packet can omit required evidence and leak secrets

Severity: **High**
Status: **Open**

Evidence:

- The Phase 21 plan requires the Jules plan and relevant repository instructions, but neither is accepted or included by `buildJulesReviewPacket`.
- Changed files are capped at 100 and the diff at its first 70,000 characters without a completeness flag, omitted-file list, hash, or artifact retrieval path.
- Verification results have no count bound; long changed-file entries, commands, and other sections are assembled before a final `.slice(0, 100_000)`.
- A probe filled early sections and produced a 100,000-character packet containing neither the diff nor `## Instructions for Independent Reviewer`.
- `redactSecrets` recognizes only query-string keys, Google API keys, `ghp_` tokens, and Bearer values. A probe retained an `sk-proj-...` credential.
- Changed filenames, verification command labels, base/head strings, Markdown fences, and headings are not redacted, normalized, or escaped despite being untrusted inputs.
- Verification output keeps only the last 3,000 characters, which can omit the actual failure origin without saying that content was removed.

Risk:

- Codex can pass a change without receiving the changed code, governing repository instructions, or complete failing-check evidence.
- Credentials and hostile packet structure can be transmitted to the review service or distort section boundaries and reviewer focus.

Deferred adjustment:

- Allocate an independent byte/token budget to every validated section and include explicit truncation counts, content hashes, and read-only artifact paths.
- Include the Jules plan and the exact repository instructions applicable to the reviewed worktree.
- Normalize/escape filenames and Markdown boundaries, validate full SHAs, and use a general centralized secret scanner with tests for OpenAI, GitHub, cloud, private-key, assignment, URL, and high-entropy formats.
- Fail closed when required evidence does not fit rather than silently deleting later sections.

### R-089 — Markdown parsing can produce internally contradictory or incomplete verdicts

Severity: **High**
Status: **Open**

Evidence:

- The reviewer is asked for prose plus a verdict line, then `parseCodexReviewFindings` treats every Markdown bullet as an independent finding.
- A probe with `VERDICT: PASS` and `- [BLOCKING] ...` returned `verdict: PASS`, `blocked: false`, and a blocking finding; no semantic consistency check forced BLOCK.
- The parser captures only severity, one simple ASCII-like file token, optional line number, and the remainder of one line as explanation.
- Required evidence, recommendation, and per-finding blocking status are never parsed even though the domain type and Phase 21 require them.
- Multiline findings, paths with spaces or many legal characters, line ranges, contextual unchanged files, nested lists, and alternate valid formatting are lost or misclassified.
- A BLOCK with no parsed findings is not distinguished from missing/invalid structure or an infrastructure failure.
- The computed finding fingerprint is unused outside its unit test and is not attached to a review cycle or SHA.
- Official OpenAI automation guidance provides schema-constrained output for stable downstream fields, but no schema or runtime object validation is used here.

Risk:

- A malformed or slightly reformatted model response can open the merge gate despite an explicit blocking defect or discard the evidence needed for repair.
- Arbitrary prose bullets can become findings while real structured findings disappear, making audit and deduplication unreliable.

Deferred adjustment:

- Request a strict versioned JSON schema containing verdict, summary, reviewed SHA, and complete structured findings; runtime-validate it with bounds and an allow-list.
- Enforce invariants: any blocking finding forces BLOCK, PASS requires a matching exact SHA and no blocking findings, and invalid/incomplete output becomes a typed non-passing parser failure.
- Retain the raw response separately, and derive stable fingerprints from canonical structured fields plus review/head identity.

### R-090 — Review evidence is not durably retained for audit or recovery

Severity: **High**
Status: **Open**

Evidence:

- Persistence is optional: callers may omit `Store` and receive a verdict with no audit record.
- When Store is present, the event includes only verdict, blocked, requested model, finding count, and a 500-character prefix of the raw summary.
- The event omits base/head SHA, review cycle, repair attempt, packet/artifact hashes, verification identity, findings, fingerprints, raw review text, reviewer execution/thread ID, timing, and failure metadata.
- The plan explicitly requires review output to be retained verbatim; `rawReviewText` is returned in memory but never stored.
- Repeated calls insert indistinguishable events with no uniqueness/idempotency key and no transaction linking the review to a cloud-session/task-state transition.
- Runner, parser, or event-write failures are thrown without a durable review-attempt/failure record.

Risk:

- After a restart, Orchestra cannot prove what Codex saw, which commit it reviewed, why it passed/blocked, or whether a review was interrupted.
- Duplicate or stale verdicts can be consumed as current because there is no canonical versioned review record.

Deferred adjustment:

- Require a durable review attempt before invocation and transactionally persist state changes, exact identities, bounded/hash-addressed packet and raw output, structured findings, and an outbox event.
- Add idempotency by task/attempt/review-cycle/head-SHA and preserve every superseded verdict for audit.
- Persist typed timeout, cancellation, parser, model, and storage failures so recovery can retry deterministically.

### R-091 — Cancellation and actual model/execution metadata are not propagated

Severity: **High**
Status: **Open**

Evidence:

- `runCodexReviewForJules` creates a new `AbortController` internally and exposes no caller signal, so task cancellation cannot interrupt the real review.
- The shared runner has a 15-minute timeout, but this wrapper records neither timeout/cancellation state nor start/completion timing.
- `runCodexReview` can fall back to another model on capacity errors, and the app server can report provider rerouting, but the wrapper supplies no telemetry callback and always returns/persists the originally requested `model`.
- No Codex thread/turn identity or token/usage telemetry is captured for correlation, budgeting, or diagnosis.
- Model and effort are arbitrary caller strings at the workflow boundary rather than a recorded policy decision tied to a review attempt.

Risk:

- Cancelled tasks can continue consuming review capacity and later return results into an obsolete workflow.
- Audit records can name a model that did not produce the verdict, undermining reproducibility and operational diagnosis.

Deferred adjustment:

- Accept and propagate the task/review abort signal through every runner and persist requested, effective, fallback/reroute, effort, thread, turn, timing, and usage metadata.
- Convert timeout, cancellation, capacity, authentication, and provider failures into typed non-passing review states.
- Resolve model/effort from durable review policy and record the decision before invocation.

### R-092 — Focused tests bypass the real Codex and exact-SHA boundaries

Severity: **High**
Status: **Open**

Evidence:

- The workflow test injects a mock runner that returns a fixed PASS; it never starts the read-only app-server path, checks its root/sandbox, exercises timeout/cancellation, or observes fallback/reroute metadata.
- That same test uses invalid `base123` and `head456` values, supplies a fabricated diff/filename, and asserts no SHA binding or event payload beyond agent/type.
- Parser tests cover one ideal BLOCK response only; they omit PASS-with-blocking, conflicting/multiple verdicts, missing structure, multiline findings, hostile bullets, unusual paths, oversized output, and required-field validation.
- Packet tests cover one Google-style key only and omit OpenAI/GitHub variants, private keys, credentials in filenames/commands, Markdown injection, per-section truncation, missing Jules plan/instructions, and complete-diff evidence.
- No persistence tests cover raw output/findings, idempotency, event failure, restart, review-cycle versioning, new-head invalidation, or actual model identity.
- All four tests passed while the contradictory PASS, packet truncation, and secret-leak probes remained reproducible.

Risk:

- The suite protects hand-authored Markdown formatting but not the safety properties required for an automated merge gate.

Deferred adjustment:

- Add schema/parser property tests and adversarial fixtures for every verdict/finding invariant and packet trust boundary.
- Use an isolated exact-head Git fixture and a fake structured Codex transport that records sandbox/root/signal/model metadata without bypassing application policy.
- Add durable lifecycle tests for interruption, retry, duplicate calls, model reroute, raw audit retention, force-push invalidation, and restart recovery.

### R-093 — Codex review combines provider, prompt, parsing, execution, policy, and persistence concerns

Severity: **High**
Status: **Open**

Evidence:

- The 218-line Jules provider module defines packet formatting, secret handling, truncation policy, verdict/finding parsing, fingerprint policy, model defaults, Codex execution, Store events, and result composition.
- It imports concrete Store and shared agent runner implementations rather than implementing a provider-neutral review application port.
- Generic Codex review and Git-review evidence behavior is nested under the Jules adapter even though local and other cloud providers need the same independent-review service.
- Optional Store and runner callbacks create multiple behavioral modes inside one function rather than isolating persistence and transport behind required interfaces.
- No production composition root connects it to the exact-worktree, cloud-session, verification, or task-state services.

Risk:

- Changes to models, output schemas, persistence, secret policy, another provider, or repair cycles require editing one cross-layer module and can disrupt an otherwise working review gate.
- Tests are encouraged to bypass real policy through the callback instead of validating stable module boundaries.

Deferred adjustment:

- Split evidence assembly/artifact storage, secret scanning, structured reviewer transport, schema validation, verdict policy, review repository, and lifecycle orchestration into narrow provider-neutral modules.
- Keep Jules-specific mapping at the cloud adapter and compose the generic review service through required ports at bootstrap.
- Add dependency-direction and contract tests so future phases extend review-cycle modules rather than growing another workflow monolith.

## Phase 13 review

### Review scope

- Reviewed commit: `66d65d89928e92ab0c96b9b60c422b4e2f162bf7`
- Commit subject: `feat(jules): implement dual-engine local/cloud repair loop (phase 13)`
- Primary artifacts reviewed: `server/providers/jules/repair-coordinator.ts`, the execution-attempt repository alias, Jules client messaging, focused tests, planned Phases 13 and 22 in `julesplan.md`, and official Jules Sessions, Activities, and Types references.
- Review date: 2026-08-22
- Review policy: Findings recorded only; implementation repairs deferred.

### Verification performed

- Confirmed that `repair-coordinator.ts` was unchanged between `66d65d8` and the review checkout by comparing its Git blob ID (`74e5f65df1469f0d3e109a2c0b9e64e81b1cd7ba`).
- `npm run build:server`: passed with zero TypeScript errors.
- `node --test tests/jules-repair-coordinator.test.mjs`: three tests passed with zero failures.
- Confirmed with `git grep` that the repair-coordinator functions had no production caller at this commit; only their definitions and focused tests referenced them.
- Compared the client call with the official `:sendMessage` endpoint, required `prompt` body, session-state descriptions, and activity event contract.
- A cross-task probe used Task A with Task B's completed cloud session, sent feedback twice for cycle 1, created two Task A attempts, and overwrote Task B's session state to `IN_PROGRESS`.
- The same probe confirmed that repeating an explicit cycle is not idempotent.
- A cycle-accounting probe with one original dispatch attempt selected cycle 2 for the first automatic cloud repair and cycle 3/local takeover on the next call.

### R-094 — The planned Phase 13 deterministic preflight was not implemented or repaired

Severity: **High**
Status: **Open**

Evidence:

- `julesplan.md` defines Phase 13 as deterministic dispatch preflight covering Git repository/origin/upstream identity, exact remote base, dirty/unpushed inputs, Jules source/branch visibility, credentials/quota, repository locking, immutable dispatch ref creation/read-back, and cleanup policy.
- Commit `66d65d8` changes no preflight, Git remote, source discovery, locking, or dispatch-branch file.
- R-058 through R-066 therefore remain unresolved, including abbreviated/colliding identities, fail-open upstream checks, unverified mutable branches, missing checks, bypassed tests, unsafe errors, and cross-layer design.
- The new work instead attempts part of planned Phase 22's repair loop and has no production caller at this commit.

Risk:

- Phase tracking can mark the dispatch safety gate complete while Jules can still start from an unproven or wrong repository state.
- An unintegrated repair path can appear to compensate for cloud failures that deterministic preflight should have prevented.

Deferred adjustment:

- Keep planned Phase 13 open until R-058 through R-066 and every preflight acceptance criterion are resolved end to end.
- Track this commit only as partial Phase 22 work.
- Do not enable repair orchestration until dispatch, cloud persistence, exact PR import, verification, and review establish trustworthy durable inputs.

### R-095 — Cloud repair calls an undocumented Jules endpoint and misclassifies session eligibility

Severity: **High**
Status: **Open**

Evidence:

- The official API documents `POST /v1alpha/sessions/{sessionId}:sendMessage` with `{ "prompt": "..." }`.
- `JulesApiClient.sendFeedback` instead posts to `:sendFeedback` with `{ "message": "..." }`, retaining the incompatible contract in R-038.
- The focused test recognizes URLs containing `sendFeedback` and never asserts the documented path or body, so it preserves the wrong adapter.
- `isCloudSessionActive` considers every state other than local-only `CANCELLED` and `FAILED` eligible, including `COMPLETED`, `PAUSED`, `AWAITING_PLAN_APPROVAL`, and `AWAITING_USER_FEEDBACK`.
- The official message endpoint is described for an active session; the coordinator neither queries current remote state nor models state-specific message capability.
- After any mocked success, it writes local session state `IN_PROGRESS` without observing a Jules response or activity proving that work resumed.

Risk:

- Real cloud repair requests will fail against the published endpoint, or be sent in a state where Jules cannot apply them.
- Local state can claim active repair while the remote session remains completed, paused, or waiting for a different action.

Deferred adjustment:

- Replace the adapter with a runtime-validated `sendMessage` operation using the documented `prompt` body and sanitized typed errors.
- Refresh the remote session and enforce an explicit capability table before messaging; route plan approval and requested feedback through their correct state-specific actions.
- Confirm message acknowledgement and resumed progress through Activities/session polling before changing the local provider state.

### R-096 — Independent task and session inputs permit cross-task repair corruption

Severity: **High**
Status: **Open**

Evidence:

- `executeDualEngineRepair` independently accepts `taskId`, `remoteSessionId`, `baseSha`, and `headSha` from its caller.
- It fetches the cloud session by remote ID but never checks `cloudSession.taskId === taskId`, stored base/head identity, provider, attempt, review cycle, or repository/project ownership.
- A probe invoked Task A with Task B's completed remote session; the function sent a message to Task B's provider session, created the attempt under Task A, and changed Task B's cloud-session row to `IN_PROGRESS`.
- No task-state guard prevents repair of cancelled, completed, unrelated, or already-disputed tasks.
- If no cloud session exists, the coordinator silently chooses local takeover instead of rejecting the invalid correlation.

Risk:

- A routing bug or hostile caller can send instructions to the wrong repository/session and corrupt two tasks' audit histories and state projections.
- Arbitrary SHA strings can be attached to an unrelated repair without any Git evidence.

Deferred adjustment:

- Accept one durable repair-cycle ID and load its task, attempt, cloud session, review, repository, base, and exact input-head associations transactionally.
- Reject every ownership, provider, state, version, or SHA mismatch with a typed non-mutating error.
- Enforce database foreign keys/unique constraints and legal compare-and-set transitions that make cross-task correlation unrepresentable.

### R-097 — Repair cycle counting and retry limits are neither correct nor idempotent

Severity: **High**
Status: **Open**

Evidence:

- When `cycle` is omitted, the coordinator uses `listByTaskId(taskId).length + 1`, counting initial dispatch, ordinary retries, cloud feedback, and local takeover attempts as though all were repair cycles.
- A probe with one original dispatch attempt selected cycle 2 for the first automatic repair; after its new attempt, the next call selected cycle 3 and local takeover despite a configured two-cloud-repair budget.
- Supplying `cycle` bypasses that derivation entirely. Repeating explicit cycle 1 sent two provider messages and created two `WORKING` attempts with no rejection.
- There is no unique task/review/input-SHA/cycle key, claimed-cycle state, message fingerprint, or compare-and-set transition.
- Zero, negative, non-integer, and inconsistent `cycle`, `maxCycles`, and `maxCloudAttempts` values are not validated.
- Strategy ignores finding severity/content and `verificationResults`, although both are accepted as policy inputs.

Risk:

- Repair budgets can be consumed early, bypassed, or repeated indefinitely, producing duplicate remote work and inconsistent escalation.
- Concurrent callers and restarts can execute the same cycle more than once.

Deferred adjustment:

- Persist a dedicated monotonically versioned repair cycle independent of execution-attempt count.
- Enforce unique `(task, review cycle, input head SHA, repair cycle)` ownership and atomically claim pending work before side effects.
- Validate positive bounded policy values and count actual cloud/local repair attempts separately.
- Base strategy on typed blocking evidence, verification state, provider capability, prior identical outcomes, and user policy.

### R-098 — Remote feedback is sent before durable intent and ambiguous failures start a racing local repair

Severity: **High**
Status: **Open**

Evidence:

- The coordinator calls Jules before creating an attempt, event, repair-cycle record, or idempotency marker.
- Any thrown error is discarded and recursively forces local takeover; timeout-after-acceptance, rate limit, authentication, invalid state, contract error, and definite rejection are treated identically.
- No event records the failed/ambiguous cloud request, error classification, message hash, provider acknowledgement, or reason for fallback.
- If Jules accepted a request before a connection failure, local takeover can begin while cloud repair continues.
- After a successful message, attempt creation, cloud-session update, task update, event insertion, and callback are separate nontransactional operations.
- A database or callback failure after remote acceptance leaves an unrecorded or partially recorded repair that a retry can resend.

Risk:

- Cloud and local engines can modify the same change concurrently, while retries create duplicate messages and attempts.
- Recovery cannot distinguish safe retry from reconcile-first ambiguity.

Deferred adjustment:

- Persist and claim a repair-message intent with a stable correlation/message hash before the network call.
- Classify failures and reconcile ambiguous outcomes through immutable user-message activities before retrying or changing strategy.
- Transactionally record acknowledgement, attempt/state transitions, and an outbox event; make callback publication post-commit and idempotent.
- Require explicit fencing/confirmation before local takeover when remote work might still be active.

### R-099 — “Local takeover” reports success without starting or preparing local repair

Severity: **High**
Status: **Open**

Evidence:

- The local path only creates a `WORKING` attempt, sets the task target/state, inserts an event, and returns `ok: true`.
- `projectRoot` is never used; no exact PR head is fetched/imported, no task-owned worktree is created, and no Antigravity process or application workflow is started.
- `headSha` appears only in the event and is not stored on the new attempt; the attempt records the original base SHA.
- Review findings and verification failures are reduced to a count and are not persisted or passed to a local worker.
- Existing cloud/local attempts are not completed, superseded, cancelled, or fenced, and the cloud session is left able to continue.

Risk:

- The dashboard can display a running local repair that has no worker and cannot produce a result.
- A later worker can start from the wrong code while stale `WORKING` attempts and an active Jules session create concurrent-writer ambiguity.

Deferred adjustment:

- Model takeover as a requested state, then atomically fence/reconcile cloud work and schedule a real local execution through the provider-neutral task runner.
- Import and verify the exact input PR head into an owned worktree, persist it on the attempt, and pass bounded structured repair instructions to Antigravity.
- Report success only after durable scheduling/claim; track superseded attempts and cleanup through explicit states.

### R-100 — The required wait-for-new-head repair loop is absent

Severity: **High**
Status: **Open**

Evidence:

- The Phase 22 plan requires Gemma distillation, Jules `sendMessage`, resumed polling, waiting for a new PR head, rerunning verification and Codex review, bounded attempts, repeated-failure escalation, and a user stop control.
- The coordinator ends immediately after sending a message or changing the task target; it implements none of the wait, refresh, verify, review, or cycle-completion states.
- It never compares an output head with the input `headSha`, so unchanged code can be followed by another manually invoked cycle without detection.
- No cycle record retains input SHA, output SHA, findings, verification results, message, timestamps, or completion/failure outcome.
- Finding fingerprints from Phase 12 are unused, so repeated identical failures cannot be detected.
- There is no pause/stop flag or command preserving prior audit history.
- No production code invokes the coordinator at this commit.

Risk:

- A “successful” repair request can be mistaken for a completed repair even though no new code was produced or reviewed.
- Crashes and restarts cannot resume the loop or determine whether to poll, resend, verify, escalate, or wait for the user.

Deferred adjustment:

- Implement a durable repair-cycle state machine from requested through acknowledged, waiting-for-head, verifying, reviewing, completed/blocked, stopped, and disputed.
- Require a different validated output SHA before verification and review; keep unchanged SHA in a waiting/escalation path.
- Persist canonical finding fingerprints and detect repeated outcomes under bounded policy.
- Add an idempotent user stop operation that fences scheduling but preserves all cycle evidence.

### R-101 — Repair instructions are unbounded, incomplete, and cross a prompt-injection/secret boundary

Severity: **High**
Status: **Open**

Evidence:

- Phase 22 requires Gemma to distill findings, but raw parsed Codex findings are formatted directly into a Jules instruction message.
- Only severity, optional file/line, and explanation are included; structured evidence and recommended corrections are dropped.
- Warning and info findings are labeled as “Required Fixes” with no blocking-policy filter, while empty findings and passing verification can still produce a repair request.
- Finding file/explanation and verification command strings are not redacted, escaped, normalized, or treated as untrusted content.
- The provider-specific redactor is applied only to verification output and misses common credentials already demonstrated in R-088.
- Markdown fences/newlines in findings, filenames, commands, or output can alter the message structure and inject new instructions.
- There is no message byte/token limit, truncation manifest, exact input-head identity, review-cycle ID, or content hash.

Risk:

- Secrets or malicious text from code, test output, filenames, or model-generated findings can be sent to Jules and influence cloud execution.
- Jules receives incomplete or misleading repair guidance with no auditable link to the reviewed commit.

Deferred adjustment:

- Validate structured review findings, select only policy-blocking items, and have a constrained distiller produce a schema-validated repair instruction set.
- Apply centralized secret scanning, normalize/escape every field, and enforce per-section and total message limits with hashes and omission metadata.
- Include the repair-cycle ID, exact input SHA, bounded evidence, and actionable recommendation while clearly marking all repository/model content as untrusted evidence.

### R-102 — Focused tests encode the wrong provider contract and omit lifecycle failures

Severity: **High**
Status: **Open**

Evidence:

- The provider mock sets success only when the URL contains `sendFeedback`, preserving the undocumented endpoint instead of asserting `:sendMessage` with a `prompt` body.
- The main test supplies explicit cycle values, hiding the incorrect attempt-count-derived cycle behavior.
- It creates no original dispatch attempt, so the fixture is not representative of a real repairable cloud task.
- It treats local takeover as successful without asserting that a worker, worktree, exact head, or repair instructions exist.
- There are no cases for cross-task IDs, terminal/waiting/paused states, missing session, invalid SHAs/policy values, duplicate/concurrent cycle calls, message timeout-after-acceptance, database/event/callback failure, or restart.
- Tests do not cover waiting for a changed/unchanged PR head, rerun verification/review, repeated finding fingerprints, stop control, cloud fencing, or actual attempt-state closure.
- All three tests passed while the cross-task corruption, duplicate cycle, and premature cycle-2 probes remained reproducible.

Risk:

- The suite validates state-row insertion while concealing the provider incompatibility and core safety failures of the repair loop.

Deferred adjustment:

- Assert the exact documented provider method/path/body and activity acknowledgement using sanitized fixtures.
- Add database-backed concurrency/idempotency, cross-ownership, ambiguous-network, partial-write, and crash/restart tests around every cycle transition.
- Exercise exact-head change, unchanged-head rejection, repeated findings, real local scheduling/fencing, stop/dispute, and bounded policy end to end.

### R-103 — The repair coordinator adds another provider-specific workflow monolith

Severity: **High**
Status: **Open**

Evidence:

- The 272-line Jules provider module combines strategy policy, cycle calculation, cloud-session eligibility, credential/client construction, prompt formatting/redaction, network side effects, failure fallback, attempt persistence, task/session transitions, event publication, and local-worker routing.
- It depends directly on concrete Store, Jules client, credential resolution, provider-specific errors, and legacy verification shapes rather than repair-cycle, reviewer, messenger, scheduler, and execution-provider ports.
- Generic local takeover and dispute policy are placed inside the Jules adapter even though they must work across providers.
- Recursive fallback and optional client/callback paths create multiple execution modes inside one function instead of explicit application states.
- The only repository change outside this provider is a duplicate `listByTaskId` alias, which expands API surface without creating a repair-cycle abstraction.

Risk:

- Changing provider messaging, retry policy, local execution, persistence, review formats, or adding another provider requires editing one cross-layer unit and can disrupt working behavior.
- Durable recovery and failure isolation remain difficult because policy and side effects cannot be tested independently.

Deferred adjustment:

- Split repair decision policy, durable cycle repository, structured instruction builder, Jules messenger/acknowledgement adapter, exact-head watcher, verification/review scheduler, local takeover service, and event outbox behind narrow interfaces.
- Keep Jules state/message mapping in its adapter and place provider-neutral repair orchestration in an application service composed at bootstrap.
- Remove duplicate repository aliases, require dependency injection, and add architecture tests enforcing module ownership and dependency direction.

## Phase 14 review

### Review scope

- Reviewed commit: `c37d24a10ca05151ecc367a09c72c56d1c578a8e`
- Commit subject: `feat(jules): implement background cloud supervisor and polling loop (phase 14)`
- Primary artifacts reviewed: `server/providers/jules/supervisor.ts`, the cloud-session repository lease changes, `tests/jules-supervisor.test.mjs`, the existing session manager/client/types, planned Phases 14, 16, 17, and 24 in `julesplan.md`, and the official Jules Sessions, Activities, and API overview references.
- Review date: 2026-08-22
- Review policy: Findings recorded only; implementation repairs deferred.

### Verification performed

- Confirmed that the reviewed supervisor and cloud-session repository in the working tree exactly matched commit `c37d24a` by comparing their Git blob IDs (`e7c1897ae9c5f27f0955f35e7169c339457e7095` and `abf98ac3230db004adeb7aac8b3453ffa3108cbf`).
- `npm run build:server`: passed with zero TypeScript errors.
- `node --test tests/jules-supervisor.test.mjs`: two tests passed with zero failures.
- `npm test`: the concurrent run passed 54 of 55 file-level subtests, with only `tests/core.test.mjs` reported failed; rerunning that file alone passed all 61 of its tests, so no Phase 14 regression was reproducible from that result.
- Confirmed with `git grep` that no production code constructed or started `JulesSupervisor` at this commit; only its definition and focused test referenced it.
- Compared the implementation with the official Jules session-output, activity-pagination, and API error/rate-limit contracts.
- A returned-failure probe made `pollSession` return `{ ok: false, error: "429 rate limited" }`; the supervisor reported `{ polled: 1, active: 1, errors: 0 }`.
- A terminal-handoff probe persisted `COMPLETED` and threw from `onTerminal`; the first tick reported one error and the next tick found zero active sessions, proving that the handoff was not retried.
- A lease-race probe let a 1 ms lease expire, acquired a new 60-second lease, released through the old owner-independent API, and immediately acquired a third lease, proving that a stale worker can erase a current lease.
- A loop-failure probe made `listNonTerminal` throw; every subsequent tick returned zero work because `isTickInProgress` remained set.

### R-104 — The planned Phase 14 explicit-dispatch work was not implemented

Severity: **High**
Status: **Open**

Evidence:

- `julesplan.md` defines Phase 14 as transactional task/attempt creation, explicit session dispatch, immutable source/branch selection, plan/PR policy, persistence before monitoring, provider-neutral events, idempotency, ambiguous-timeout reconciliation, and duplicate-session detection.
- Commit `c37d24a` changes no dispatch, preflight, attempt transaction, idempotency, reconciliation, or duplicate-detection code.
- The commit instead introduces part of planned Phase 16's polling lease/loop and Phase 17's recovery surface.
- Previously recorded dispatch findings R-068, R-069, R-073, R-074, and R-075 remain unresolved.

Risk:

- Phase tracking can report dispatch complete even though an accepted-but-unrecorded remote session can still be duplicated or lost after timeout or persistence failure.
- Polling infrastructure cannot repair an unsafe or unidentified dispatch.

Deferred adjustment:

- Keep planned Phase 14 open until dispatch intent, remote acknowledgement, attempt/cloud-session persistence, task transition, and event publication form an idempotent reconcile-first workflow.
- Detect duplicate sessions by durable dispatch identity and surface ambiguous outcomes for reconciliation rather than retrying creation.
- Treat this commit only as an incomplete implementation toward planned Phases 16 and 17.

### R-105 — The supervisor is not integrated and does not provide durable restart recovery

Severity: **High**
Status: **Open**

Evidence:

- At `c37d24a`, `JulesSupervisor` is exported but has no production constructor, bootstrap call, shutdown hook, or dependency composition; only the focused test instantiates it.
- `start()` installs an in-memory `setInterval` and waits one full interval before the first tick.
- There is no durable next-poll time, supervisor heartbeat, recovery checkpoint, startup reconciliation, or diagnostic state showing whether a session has an active poller.
- `listNonTerminal()` reloads rows, but nothing starts the reload/poll process after a dashboard restart.

Risk:

- Deployed cloud sessions are never polled by this commit, and a restart can leave them indefinitely stale.
- Operators cannot distinguish a healthy delayed poll from an absent or dead supervisor.

Deferred adjustment:

- Compose and start a provider-neutral polling application service during bootstrap, run an immediate recovery scan, and await a bounded graceful stop during shutdown.
- Persist per-session due/retry/checkpoint state and expose supervisor/lease diagnostics.
- Add restart integration tests for every nonterminal and terminal-handoff state before enabling cloud execution.

### R-106 — Polling leases have no ownership or fencing and can be cleared by stale workers

Severity: **High**
Status: **Open**

Evidence:

- `cloud_sessions` stores only `polling_lease_expires_at`; acquisition returns a boolean rather than an owner ID, token, or generation.
- There is no lease-renewal operation, and `releasePollingLease(id)` clears the lease solely by session ID without comparing the owner or acquired generation.
- The default lease is 30 seconds while the Jules client can spend multiple timeout/retry/backoff periods in one request, and the terminal callback has no duration bound.
- The adversarial probe demonstrated that after A's lease expired and B acquired a new 60-second lease, A's owner-independent release cleared B's lease and permitted C to acquire immediately.

Risk:

- Multiple dashboard instances can poll and process the same session concurrently.
- A stale worker can overwrite activity/output state or duplicate a terminal handoff after a newer worker has legitimately taken ownership.

Deferred adjustment:

- Persist an opaque owner token and fencing generation plus acquired/renewed/expiry/worker diagnostic fields.
- Require compare-and-set ownership for renewal, every lease-protected state transition, and release; stale tokens must have no effect.
- Bound or renew long operations and test expiry takeover, stale writes/releases, process death, and clock behavior with multiple database connections.

### R-107 — One infrastructure or callback error can permanently wedge polling, and stop does not cancel work

Severity: **High**
Status: **Open**

Evidence:

- `isTickInProgress` is reset only at the normal end of `tick()` rather than in an outer `finally`.
- Errors from `listNonTerminal`, lease acquisition/release, or an `onError` callback can escape the per-session handler and leave the flag true.
- The failure probe made session listing throw once; the next tick returned `{ polled: 0, active: 0, errors: 0 }` and could never resume.
- `start()` creates an `AbortController`, but its signal is not passed to `pollSession`, the Jules client, callbacks, or lease work.
- `stop()` clears the timer without awaiting an active tick, so work can continue while the store and other dependencies are shutting down.
- Poll and lease durations accept zero or negative values without validation.

Risk:

- A transient database/callback failure can silently disable all cloud monitoring until process restart.
- Shutdown can race in-flight database writes or callbacks, and invalid configuration can create a busy loop or already-expired leases.

Deferred adjustment:

- Put tick lifecycle cleanup in an outer `try/finally`, isolate reporting failures, and surface a persistent unhealthy state rather than returning misleading zero work.
- Propagate one cancellation signal through the poll/client/handoff ports and make `stop()` await bounded in-flight completion.
- Validate timing configuration and add database-failure, callback-failure, stop-during-poll, and restart tests.

### R-108 — Returned poll failures are counted as successes and retried without durable backoff

Severity: **High**
Status: **Open**

Evidence:

- `JulesSessionManager.pollSession()` returns `ok: false` for a missing local session, missing credentials, and transient remote/network failures instead of throwing.
- The supervisor never checks `pollResult.ok`; it increments `polled`, leaves `errors` at zero, releases the lease, and makes the same row eligible on the next interval.
- The 429 probe reproduced `{ polled: 1, active: 1, errors: 0 }`.
- There is no persisted retry count, error class, last error, `nextPollAt`, backoff, jitter, server retry hint, rate-limit budget, or paused/inactive cadence.
- Sessions are processed sequentially from the full snapshot, and `active` counts rows leased by other workers or not actually polled.

Risk:

- Credential/configuration failures and provider outages appear healthy while the process repeatedly calls Jules.
- Fixed synchronized polling across instances can amplify rate limits; one slow early session can starve later sessions.

Deferred adjustment:

- Treat `ok: false` as a typed poll failure and record accurate attempted/succeeded/failed/skipped metrics.
- Persist bounded exponential backoff with jitter, retry classification and provider retry hints, plus slower schedules for paused/inactive states.
- Claim only due rows in bounded batches and introduce fair, concurrency-limited execution behind a scheduler port.

### R-109 — Terminal handoff is lossy, non-idempotent, and occurs after premature task completion

Severity: **High**
Status: **Open**

Evidence:

- `pollSession()` persists `COMPLETED`/`FAILED` and updates the Orchestra task before returning to the supervisor.
- Only afterward does the supervisor invoke an optional, non-durable `onTerminal` callback.
- If the callback throws or the process exits in that gap, `listNonTerminal()` excludes the session forever; the probe confirmed one callback error followed by zero active sessions.
- If a lease expires during the callback, concurrent workers can call it more than once because it has no durable idempotency key or claimed handoff state.
- A completed Jules session marks the task `completed` before planned PR URL validation, exact-head resolution/import, verification, Codex review, repair, merge, and cleanup.

Risk:

- A valid Jules PR can be permanently stranded without import/review, while the UI reports the task complete.
- Duplicate callbacks can race Git operations or create duplicate downstream work.

Deferred adjustment:

- Persist a transactional terminal-observed/outbox record keyed by session, terminal version, and exact output identity before publication.
- Drive an idempotent downstream state machine that retries unacknowledged handoffs and uses lease fencing/compare-and-set transitions.
- Reserve task completion for the final verified integration state; provider completion should enter an intermediate import/review state.

### R-110 — The supervisor repeats incompatible Jules output and activity assumptions

Severity: **High**
Status: **Open**

Evidence:

- The official Sessions reference models `outputs` as a list, but the supervisor reads `julesSession.outputs.pullRequest` and the local type models an object.
- The focused fixture supplies that same object-shaped output and an undocumented `headCommitSha`, so it validates the implementation assumption rather than the published contract.
- The published pull-request output provides a URL but not the trusted exact head SHA assumed here; GitHub PR resolution must independently establish the head identity.
- The official Activities method is paginated with `nextPageToken`, but the inherited client returns only one page and the session manager uses timestamp-based filtering while suppressing activity-list errors.
- The supervisor's terminal event therefore commonly lacks a real PR URL/SHA and continuously exercises the loss/duplication paths already recorded in R-068, R-070, R-071, and R-073.

Risk:

- Real Jules responses can lose PR metadata and activity history while the task advances into an incorrect terminal state.
- Downstream review can have no trustworthy commit identity or may operate on stale/local state.

Deferred adjustment:

- Correct the Jules wire DTOs and fixtures to the official list-shaped outputs and fully paginated activity response.
- Translate provider data at the adapter boundary, retain unknown typed metadata safely, and deduplicate/order activities by stable resource identity plus cursor.
- Strictly validate the PR URL and resolve/fetch its exact head SHA through the GitHub/Git boundary before downstream work.

### R-111 — Focused tests omit the failure and lifecycle boundaries that define a supervisor

Severity: **High**
Status: **Open**

Evidence:

- The two tests cover immediate acquire/release and two manually invoked happy-path ticks; `start()` and `stop()` are called back-to-back without observing scheduled behavior.
- The lease test does not exercise expiry despite its title, multiple database connections/processes, renewal, stale release/write, or fencing.
- The polling test uses the incompatible output fixture and does not assert `pollResult.ok`, activity pagination/deduplication, retry/backoff, rate limits, missing credentials, network/database failures, or error metrics.
- There are no cases for callback failure/retry/idempotency, crash between terminal persistence and handoff, stop during an active request, stuck-tick recovery, restart/bootstrap, fairness, invalid intervals, or production wiring.
- Both focused tests passed while every adversarial probe above reproduced a defect.

Risk:

- The suite gives confidence in the least consequential happy path while allowing lost terminal work, duplicate polling, silent supervisor death, and provider hammering.

Deferred adjustment:

- Add fake-clock scheduler tests and multi-connection database tests for lease fencing, renewal, expiry, stale operations, due selection, and backoff.
- Add crash/restart and fault-injection tests at each persistence, network, callback, shutdown, and terminal-handoff boundary.
- Use recorded official Jules response fixtures and include a production-bootstrap integration test that observes durable recovery.

### R-112 — The supervisor extends the cross-layer monolith instead of creating durable polling ports

Severity: **High**
Status: **Open**

Evidence:

- One concrete class owns interval scheduling, global overlap policy, row enumeration, distributed lease acquisition/release, Jules polling, provider output extraction, terminal workflow dispatch, metrics, cancellation state, and error policy.
- It depends directly on concrete `Store`, `JulesSessionManager`, `JulesApiClient`, and `CloudSessionReference` rather than scheduler, due-work repository, lease, provider poller, transition, outbox, clock, and telemetry interfaces.
- Provider-specific PR extraction is mixed into generic scheduling, while generic terminal orchestration is exposed as an optional callback with no durable contract.
- Timing and lifecycle behavior are hidden process state, making recovery and deterministic tests dependent on the whole class.

Risk:

- Changing polling policy, persistence, Jules response mapping, terminal import/review, shutdown, or adding another provider requires editing the same unit and can disrupt working paths.
- Failure isolation and recovery remain difficult because state transitions and side effects cannot be tested or replaced independently.

Deferred adjustment:

- Split a provider-neutral durable scheduler, due-session repository, owner-fenced lease service, Jules poll adapter/translator, transition service, terminal outbox consumer, clock, and telemetry ports.
- Keep provider wire mapping inside the Jules adapter and compose application workflow components at bootstrap.
- Add architecture tests enforcing dependency direction so new providers and workflow stages can be added without expanding a central polling class.

## Phase 15 review

### Review scope

- Reviewed commit: `51b46905fbcdc407133bb5460eda27487529c112`
- Commit subject: `feat(jules): implement dynamic task routing policy engine (phase 15)`
- Primary artifacts reviewed: `server/providers/jules/router.ts`, its provider export, `tests/jules-router.test.mjs`, planned Phases 15 and 26 in `julesplan.md`, the existing Jules preflight/source/client/state contracts, and all production routing references at the reviewed commit.
- Review date: 2026-08-22
- Review policy: Findings recorded only; implementation repairs deferred.

### Verification performed

- Confirmed that `router.ts` and its focused test exactly matched commit `51b4690` by comparing their Git blob IDs (`d5a1bb4413008139f702fde2347c012e56ac9e34` and `ffacd46ecd7c0da0c44a73fca1de534b81824638`).
- `npm run build:server`: passed with zero TypeScript errors.
- `node --test tests/jules-router.test.mjs`: two tests passed with zero failures.
- `npm test`: all 115 tests passed with zero failures.
- Confirmed with `git grep` that no production code called `routeTask` at this commit; only its definition and focused test referenced it.
- Confirmed that the commit changes no plan display, plan approval workflow, user-feedback workflow, timeline action, UI, session-state guard, or cancellation/deletion language.
- A policy probe supplied deep complexity plus `security-sensitive`, `local-only-context`, and `database-migration` risk flags; the router still selected Jules cloud.
- The same probe passed an invalid runtime target, which was silently treated as Auto and also selected cloud.
- A task/project-binding probe routed Task A using an unrelated Project B repository and recorded two identical `task.routed` events when invoked twice.
- The probe also confirmed `preflightOk: true` while the generated immutable dispatch branch existed neither locally nor under `refs/remotes/origin`; the fixture's upstream ref had been manufactured locally without contacting GitHub.
- An availability probe selected local despite `localQuotaExhausted: true` when cloud preflight failed, and selected cloud despite `preflightOk: false` for an explicit cloud request.

### R-113 — The planned Phase 15 plan-review and feedback workflow was not implemented

Severity: **High**
Status: **Open**

Evidence:

- `julesplan.md` defines Phase 15 as displaying generated plans, approving plans, requesting/responding to feedback through `sendMessage`, recording those actions in the timeline, and distinguishing deletion from cancellation.
- Its acceptance criteria require approval only in `AWAITING_PLAN_APPROVAL`, feedback only in supported states, and idempotent or safely rejected repeated clicks.
- Commit `51b4690` changes only a new routing function, one provider export, and focused routing tests; it changes no server/UI plan or feedback path.
- The only existing Jules messaging method remains the incompatible `sendFeedback` endpoint/body recorded in R-095 and R-102.
- Existing provider interface/client method declarations have no application service, state/ownership check, durable intent, timeline acknowledgement, API route, or UI control implementing the planned workflow.

Risk:

- Phase tracking can report plan interaction complete while users cannot see or approve a plan, answer Jules, or safely retry an action.
- Any later direct use of the low-level client can approve/message the wrong state or session without an auditable idempotent transition.

Deferred adjustment:

- Keep planned Phase 15 open and implement provider-neutral plan/feedback application commands bound to task, cloud session, and current provider state.
- Persist action intent and idempotency identity before calling the documented Jules methods, reconcile ambiguous results through activities, and publish timeline events transactionally/outbox-backed.
- Add guarded API/UI controls for plan display, approval, feedback, and accurately distinct cancel/delete operations.

### R-114 — The commit is an unintegrated, prematurely sequenced fragment of planned Phase 26

Severity: **High**
Status: **Open**

Evidence:

- Dynamic Auto routing is planned for Phase 26, which explicitly says to enable Auto only after explicit Local and Cloud modes are stable.
- The prerequisite dispatch, polling, recovery, PR import/review, and repair defects recorded through R-112 remain open.
- `routeTask` is merely exported from the Jules provider barrel; `git grep` found no production caller, task-creation integration, API route, UI selector, or execution dispatcher using its result.
- The function returns a recommendation-like object but neither durably schedules a worker nor updates the task's target/routing state.
- The commit subject and test names label this work Phase 15 even though it attempts only part of Phase 26.

Risk:

- A dead policy module can be mistaken for delivered user-facing routing, while later wiring may activate cloud paths whose prerequisites are still unsafe.
- Phase ordering and acceptance evidence become unreliable.

Deferred adjustment:

- Track this code as incomplete Phase 26 work and keep both planned Phases 15 and 26 open.
- Integrate routing only through the provider-neutral task-creation/scheduling workflow after explicit Local and Cloud paths meet their gates.
- Add a feature/policy gate that prevents Auto selection until prerequisite capabilities and recovery controls are verified.

### R-115 — Routing decisions can select a provider that the same result says is unavailable

Severity: **High**
Status: **Open**

Evidence:

- An explicit cloud request whose preflight fails returns `target: 'cloud'`, `worker: 'jules'`, `preflightOk: false`, and `fallbackAvailable: true` rather than a rejected/blocked outcome or selected fallback.
- The focused test asserts this contradictory result as “strictly respected.”
- In Auto mode, credential or preflight failure always selects local before considering `localQuotaExhausted`.
- The availability probe therefore returned local with `fallbackAvailable: false` despite `localQuotaExhausted: true`.
- `fallbackAvailable` has inconsistent meaning: it is false on some selected local routes, true on a failed cloud route, and true on the default local route, with no fallback target or capability evidence.

Risk:

- A caller that dispatches from `target` can send work to Jules after a failed hard gate.
- When both providers are unavailable, the router can loop into an exhausted local worker instead of producing an actionable blocked state.

Deferred adjustment:

- Separate requested target, recommended target, executable target, and outcome (`ready`, `blocked`, `fallback-proposed`, `rejected`) in the domain result.
- Model provider capabilities and failure reasons explicitly; never return a provider as executable when its hard gates fail.
- Require an explicit user-confirmed fallback for an unavailable requested target and test all two-provider availability combinations.

### R-116 — Auto routing ignores required safety inputs and accepts invalid boundary data

Severity: **High**
Status: **Open**

Evidence:

- Planned Phase 26 requires local-only input, size/duration, interactive clarification, repository availability, both providers' availability/quota, risk, dependency/migration scope, user preference, and project policy.
- The router considers only read-only status, Jules credential/source preflight, one local-quota boolean, and `complexity === 'deep'`.
- `classification.riskFlags`, `classification.target`, `prompt`, project policy, clarification need, dependency/migration scope, Jules quota/capacity, and expected duration are unused.
- The policy probe supplied explicit security/local-only/migration risks and still selected cloud solely because complexity was deep.
- Runtime input is not schema-validated: an invalid `requestedTarget` falls through as Auto and selected cloud in the probe.
- A provided object truthy as `julesClient` is treated as configured credentials without validating its client capability until a later path happens to use it.

Risk:

- Sensitive, migration-heavy, interactive, or otherwise locally constrained work can be auto-routed to cloud despite deterministic safety signals.
- Malformed API input can silently change an explicit request into cloud-capable Auto behavior.

Deferred adjustment:

- Define and validate a versioned provider-neutral routing input schema at the API boundary; reject unknown targets and internally inconsistent classifications.
- Implement deterministic hard constraints for local-only context, risk classes, migrations/dependencies, interaction requirements, policy, and real provider capability/quota before scoring preferences.
- Persist which rules fired, which evidence was unavailable, and whether the user overrode a recommendation.

### R-117 — Routing preflight reports readiness without proving the cloud dispatch ref is visible

Severity: **High**
Status: **Open**

Evidence:

- Both explicit-cloud and Auto branches call `runJulesPreflight(..., skipPush: true)` even though `skipPush` is documented as a dry-run test escape hatch.
- The router can return `preflightOk: true` without creating/pushing the generated immutable dispatch branch and drops the discovered source, base SHA, target branch, and dispatch branch from its decision.
- The probe observed `preflightOk: true` while neither the local dispatch ref nor an origin-tracking dispatch ref existed.
- The focused test manufactures `refs/remotes/origin/main` locally and never contacts the declared GitHub remote, yet treats the repository as cloud-ready.
- The inherited upstream check fails open when `git rev-list` fails and source discovery does not prove branch visibility; R-058 through R-066 remain unresolved.

Risk:

- Auto can recommend Jules based on stale or locally forged remote-tracking state, and a caller cannot bind the later dispatch to the repository/source/SHA that was evaluated.
- A time-of-check/time-of-use change can route or dispatch different code from the user's reviewed context.

Deferred adjustment:

- Split non-mutating route eligibility from locked dispatch preparation and describe them with distinct result states rather than `preflightOk`.
- At dispatch, acquire the repository lock, revalidate the exact full SHA/source/remote, create and push the immutable ref, verify it by remote read-back, and persist the resulting identity transactionally.
- Remove production access to `skipPush`; provide explicit injected test ports/fixtures and fail closed on Git/remote ambiguity.

### R-118 — Decisions and routing events are not bound, idempotent, or durably actionable

Severity: **High**
Status: **Open**

Evidence:

- `taskId`, `projectRoot`, classification, and requested target are independent caller inputs; the router never loads the task/project or proves that the inspected repository belongs to that task.
- The probe routed a task stored under `F:/different-project` using a separate temporary repository and successfully appended routing events to the unrelated task.
- `store` is optional, so the same decision can return with no durable event at all.
- Repeating the identical request appended another indistinguishable `task.routed` event; the probe recorded two events with no decision ID, policy version, input hash, supersession link, or attempt identity.
- The event omits the requested target, classification/rules, error/resolution, project/source/base/dispatch identity, capability snapshot, and override status.
- The router neither compare-and-sets the task's routing state/target nor atomically claims scheduling, so the event can disagree with actual execution.

Risk:

- Audit history can claim a task was routed from evidence belonging to another repository, and retries/concurrent requests can produce contradictory decisions.
- Recovery cannot determine which decision was authoritative or whether a worker was ever scheduled from it.

Deferred adjustment:

- Load task/project/classification/policy from one trusted aggregate and derive the repository root server-side.
- Persist one versioned routing decision keyed by task and input/policy revision, using optimistic concurrency and an outbox event in the same transaction as the scheduling state.
- Make repeated equivalent decisions idempotent and record explicit supersession/user override when inputs change.

### R-119 — Focused tests validate the wrong phase and conceal routing safety failures

Severity: **High**
Status: **Open**

Evidence:

- Both tests exercise routing even though planned Phase 15's acceptance criteria concern plan approval, feedback eligibility, repeated actions, timeline records, and deletion/cancellation language.
- The explicit-cloud test defines “strictly respected” as retaining `target: 'cloud'` after preflight failure instead of asserting a blocked or safely rejected outcome.
- The Auto fixture fabricates a remote-tracking ref locally and uses `skipPush: true`; it does not prove the commit or immutable dispatch ref exists on GitHub/Jules.
- Tests do not cover risk flags, local-only inputs, migration/dependency scope, project policy, interactive clarification, Jules quota, both-provider outage, malformed targets/classifications, task/project mismatch, or policy override.
- Event assertions require only at least four rows and therefore accept duplicate/non-idempotent decisions without checking payload completeness or task state.
- There are no production-integration, scheduling, concurrency, TOCTOU, failure/exception, feature-gate, or restart tests.
- Both tests passed while the adversarial probes reproduced invalid-target cloud selection, ignored risk constraints, cross-project audit events, duplicate events, nonexistent dispatch refs, and contradictory provider availability.

Risk:

- The suite can certify a router that selects unavailable or unsafe providers and provides no Phase 15 user workflow.

Deferred adjustment:

- Add the actual Phase 15 state/ownership/idempotency/API/UI tests independently of later routing work.
- For Phase 26, use server-bound task/project fixtures, real bare remotes or strict Git/provider fakes, a full deterministic constraint matrix, invalid-input tests, capability-outage combinations, and exact-ref verification.
- Add integration tests proving that one durable decision schedules exactly one permitted attempt and that user overrides are explicit and auditable.

### R-120 — Provider-neutral routing policy is embedded in another Jules cross-layer module

Severity: **High**
Status: **Open**

Evidence:

- `server/providers/jules/router.ts` owns provider-neutral Local/Cloud/Auto policy, user-target interpretation, classification rules, quota fallback, credential construction, live Git/Jules preflight, decision formatting, and database event publication.
- It directly depends on concrete `Store`, `CredentialVault`, `JulesApiClient`, credential resolution, and Jules preflight rather than policy input, capability, provider-catalog, task repository, decision repository, and event/outbox ports.
- The function mixes deterministic rules with network/Git/database side effects, so a nominal routing calculation can be slow, throw, or mutate history.
- Adding a provider requires editing a module under the Jules adapter and expanding its target/worker conditionals.
- Optional dependencies create multiple behavior modes and allow policy evaluation without persistence.

Risk:

- Changing routing rules, provider availability, persistence, Git checks, or adding another worker expands one cross-layer function and can disrupt established Local/Jules behavior.
- Pure policy cannot be tested exhaustively without constructing infrastructure, and infrastructure failures cannot be isolated from decision logic.

Deferred adjustment:

- Move provider-neutral routing into a pure, versioned domain policy over validated capability/evidence snapshots.
- Implement Jules eligibility/preparation, local capability, policy loading, decision persistence, and scheduling as narrow adapters/application services composed at bootstrap.
- Make persistence mandatory at the orchestration boundary and add architecture tests preventing provider adapters from owning global routing or importing the Store facade.

## Phase 16 review

### Review scope

- Reviewed commit: `a53934110a37ec7f1fd11d5f157b480ad3425ef8`
- Commit subject: `feat(api): wire cloud execution route controller and dispatch pipeline (phase 16)`
- Primary artifacts reviewed: `server/api/routes/jules.ts`, `tests/jules-routes.test.mjs`, their production mounting and provider/repository dependencies, planned Phases 14–19 in `julesplan.md`, the existing Phase 14 polling research, and the new implementation-integrity, testing, security, coding-principle, delegation, and role-boundary rules.
- Review date: 2026-08-22
- Review policy: Findings recorded only per the user's request; dependency blockers are identified under the new implementation-integrity rule.

### Verification performed

- Confirmed that the reviewed route and focused test exactly matched commit `a539341` by comparing their Git blob IDs (`bbd2ba24d818ef6f905a04f4cf6fe9c922e959c9` and `f4c11b5104be22f424febb4962a71ba26238c1bf`).
- `npm run build:server`: passed with zero TypeScript errors.
- `node --test tests/jules-routes.test.mjs`: two tests passed with zero failures.
- `npm run lint`: passed with zero reported violations.
- `npm test`: all 117 tests passed with zero failures.
- Confirmed that the production API router mounts `createJulesRouter(store)`, so the new endpoints are live production paths rather than unused helpers.
- Confirmed that the commit changes no supervisor, polling scheduler, session poller, Jules activity client, cloud-session schema/repository, lease, event translation, bootstrap, or recovery code.
- An HTTP probe submitted the same dispatch twice; both returned 201, called remote creation twice, created separate tasks/cloud rows for the same remote session ID, and accepted a session owned by a different project.
- The same probe sent JSON strings `"false"` for plan approval and Auto PR policy, which the route's `Boolean(...)` coercion converts to `true`, and used the externally exposed `skipPush: true` safety bypass.
- While the cloud session was `PLANNING`, repeated plan approval and feedback requests both returned 200, each called Jules twice, and each appended duplicate events.
- An activities probe supplied `pageSize=banana`; the route returned 200, omitted the invalid value from the provider request, discarded the provider's `nextPageToken`, returned raw unknown activity data, and persisted no cursor/event.

### Effect of the new Markdown implementation rules

There are limited improvements consistent with the new rules:

- The focused tests make real HTTP requests through an Express-mounted router and use temporary SQLite and Git resources.
- The router accepts injected Jules/session dependencies, which makes boundary testing easier.
- Most task action routes load the cloud session through the task instead of accepting an independent remote-session ID.

The central integrity rules were not followed:

- The assigned Phase 16 scope was replaced with adjacent/future route work instead of stopping on the mismatch.
- Known blocking dispatch, provider-contract, lease, polling, identity, review, and recovery findings were used as dependencies rather than resolved.
- A production `skipPush` bypass was exposed specifically to make the test pass, despite the new rule expressly prohibiting this pattern.
- HTTP/provider/database/Git identities are cast or coerced rather than validated; non-idempotent side effects lack durable intent/reconciliation; and a route module owns cross-layer workflows.
- The 453-line route is larger and more cross-layer than the 118-line Phase 14 supervisor and 186-line Phase 15 router.

Assessment: **slightly better test mechanics and dependency injection, but not materially better or cleaner overall**. The strongest new rules are contradicted by the implementation and tests. R-121 through R-129 are blocking for dependent cloud phases under `implementation-integrity.md`.

### R-121 — Planned Phase 16 durable activity polling was not implemented

Severity: **High**
Status: **Open**
Dependency impact: **Blocks dependent cloud monitoring and recovery phases**

Evidence:

- Planned Phase 16 requires a persisted cursor/timestamp, full pagination, stable-ID deduplication, ordering, bounded backoff, rate-limit handling, slower paused/inactive cadence, terminal stop, per-session lease, and provider-to-Orchestra event translation.
- Commit `a539341` modifies only one HTTP route module and its focused route test.
- It changes none of the polling components or persistence needed by those requirements.
- R-105 through R-112 remain unresolved, including absent supervisor bootstrap, unsafe ownerless leases, permanent tick wedging, false-success poll accounting, lossy terminal handoff, incompatible Jules wire shapes, missing fault tests, and cross-layer supervisor design.
- The new `/activities` endpoint performs one client request only when an HTTP caller asks; it is not a poller and has no durable workflow behavior.
- The new integrity rule requires stopping when work belongs to another phase and when blocking prerequisites remain, but this commit instead builds new routes over those blockers.

Risk:

- Cloud activity still cannot be monitored reliably across normal operation, rate limits, multiple instances, or restart.
- Calling a first-page HTTP listing route can be mistaken for completing a durable background workflow.

Deferred adjustment:

- Keep planned Phase 16 open and do not begin dependent recovery/monitoring phases until the Phase 14 polling blockers are repaired.
- Implement Phase 16 through a provider-neutral durable scheduler and Jules activity adapter with owner-fenced leases, persisted due/cursor/error state, stable event translation, and transactional/outbox publication.
- Map every Phase 16 acceptance criterion to production code plus restart, concurrency, pagination, rate-limit, unknown-type, and fault-injection evidence before completion.

### R-122 — The activities endpoint discards pagination and provides none of the required durable semantics

Severity: **High**
Status: **Open**
Dependency impact: **Blocks Phase 16 acceptance and restart-safe monitoring**

Evidence:

- `GET /tasks/:id/jules/activities` calls `client.listActivities` once and returns `{ activities }` directly.
- `JulesApiClient.listActivities` returns only the activities array, discarding the documented `nextPageToken`, so neither the route nor a caller can complete pagination reliably.
- The probe returned a provider page containing `nextPageToken: "next-page"`; the HTTP response omitted the token.
- `pageSize` is parsed with `Number(...)` but is not checked for finiteness, integer form, or the documented bounds; `pageSize=banana` returned 200 and silently became an omitted parameter.
- No cursor/timestamp is updated, no stable-ID deduplication or ordering occurs, no raw activity is translated/persisted as an Orchestra event, and no lease/backoff/rate-limit/terminal-state policy is involved.
- An unknown activity type was merely returned as raw HTTP data; it was not durably retained as provider metadata.

Risk:

- Activity pages can be lost, repeated, reordered, or duplicated after refresh/restart, while invalid requests appear successful.
- The UI cannot distinguish a complete timeline from one truncated at the first provider page.

Deferred adjustment:

- Make the Jules adapter return a validated page DTO containing activities and `nextPageToken`, then have the durable poll application service consume all pages under a fenced lease.
- Validate page size/token at the HTTP boundary if a diagnostic page endpoint remains, and return stable 4xx codes for malformed input.
- Persist normalized events and cursor advancement atomically, retaining unknown provider activity types as bounded metadata.

### R-123 — The dispatch API exposes a production Git-safety bypass and coerces untrusted input

Severity: **High**
Status: **Open**
Dependency impact: **Blocks safe cloud dispatch**

Evidence:

- The HTTP body controls `skipPush`, which is passed directly into dispatch preflight; an external caller can therefore suppress creation/readiness of the immutable remote dispatch ref.
- The focused test explicitly sends `skipPush: true` “to bypass network push,” exactly the production-bypass pattern prohibited by the new implementation-integrity and testing rules.
- `requirePlanApproval` and `autoPr` use JavaScript `Boolean(...)` coercion; JSON string `"false"` becomes `true` rather than being rejected.
- `prompt` uses `String(...)`, so non-string inputs can become values such as `[object Object]`; no maximum length or structured schema is enforced.
- `sessionId` is checked only as a trimmed string, and errors/resolutions remain free-form provider/Git text rather than validated stable error codes with public redaction.

Risk:

- A malformed or hostile API request can change dispatch policy, bypass the immutable-ref safety gate, or send unintended prompt content to Jules.
- Tests succeed by disabling the property the route claims to provide.

Deferred adjustment:

- Remove `skipPush` from every production DTO and function reachable from HTTP; inject a Git dispatch-ref port/fake in tests.
- Add a strict request schema with exact booleans, bounded prompt/title fields, UUID/session validation, unknown-field policy, and stable sanitized errors.
- Re-run locked preflight and remote ref read-back immediately before the durable dispatch transition.

### R-124 — Dispatch remains cross-project, non-atomic, non-idempotent, and ambiguity-unsafe

Severity: **High**
Status: **Open**
Dependency impact: **Blocks cloud dispatch and every downstream session workflow**

Evidence:

- The route accepts `projectId` in the URL and `sessionId` in the body independently, then creates a task without verifying that the session belongs to that project.
- The probe supplied Project B's session to Project A's dispatch; the resulting task stored Project A with Project B's session successfully.
- Each request creates the task before remote dispatch; task creation, attempt creation, cloud-session creation, task transition, and events are not one transaction/outbox protocol.
- No idempotency key, dispatch intent, unique remote-session constraint, duplicate detection, or ambiguous-timeout reconciliation exists.
- Two identical probe requests both returned 201, made two remote creates, and persisted two cloud rows with the same `remoteSessionId`; the schema has only a non-unique index on that field.
- Dispatch failures return a task ID but do not persist a stable failed/ambiguous dispatch state or error on the task.

Risk:

- Retries or timeouts can create duplicate remote work and contradictory local ownership.
- Cross-project task/session corruption can break history, authorization assumptions, cleanup, and recovery.

Deferred adjustment:

- Derive the session from the loaded project or enforce composite ownership in the repository/database.
- Persist a versioned dispatch intent/idempotency identity before the remote mutation, reconcile ambiguous acceptance, and atomically acknowledge attempt/cloud/task/event state.
- Add unique/canonical provider-session identity and concurrency tests using multiple requests/connections and injected failures at every write boundary.

### R-125 — Plan approval and feedback routes expose the known wrong contract without state or idempotency guards

Severity: **High**
Status: **Open**
Dependency impact: **Blocks safe Phase 15 interaction and cloud-route exposure**

Evidence:

- Approval does not require `AWAITING_PLAN_APPROVAL`; feedback does not check any supported provider state.
- In the focused fixture and adversarial probe the session remained `PLANNING`, yet both actions returned 200.
- Repeating each action made two provider calls and appended two duplicate events; there is no action identity, compare-and-set transition, durable intent, acknowledgement, or safely rejected repeat.
- Feedback still calls the undocumented `:sendFeedback` endpoint with `{ message }` rather than the published `:sendMessage` operation/body recorded in R-095.
- The network mutation happens before the event write, so a database failure or process crash creates an ambiguous accepted action that a retry will resend.
- The full unbounded user message is copied into the timeline event without centralized secret scanning or a content hash/provenance boundary.

Risk:

- Users can approve or message an ineligible session repeatedly, and ambiguous failures can duplicate provider instructions.
- Sensitive feedback can be persisted or sent under an incompatible provider contract.

Deferred adjustment:

- Implement guarded provider-neutral approval/message commands over a task-owned cloud session and current persisted/refreshed state.
- Use the documented Jules message adapter, persist idempotent intent before the call, reconcile acknowledgement through activities, and publish a redacted bounded timeline event transactionally.
- Test wrong states, duplicates/concurrency, timeout after acceptance, event-write failure, restart, and cross-task ownership.

### R-126 — Pause, resume, and cancel routes report actions without durable confirmed state transitions

Severity: **High**
Status: **Open**
Dependency impact: **Blocks reliable lifecycle control and recovery**

Evidence:

- Repair checkpoint (2026-08-23): the Jules router is now absent unless `JULES_ENABLED` is explicitly `true`, and an ordered rollout capability gate prevents enabling the master flag from exposing later operations. Cancellation and deletion routes return typed 501 responses without provider or persistence side effects. The finding remains open until durable local automation and truthful remote deletion workflows are implemented.

- Pause and resume call Jules and append events but do not update the cloud session or task state, persist an intent, or validate whether the transition is legal.
- Cancellation delegates to the existing `cancelSession`, which calls Jules `pause` best-effort, suppresses every remote error, writes local `CANCELLED`, marks the task failed, and returns `ok: true`.
- No remote cancel/delete confirmation, ambiguity state, reconciliation, action idempotency, or compare-and-set version exists.
- Repeated or concurrent lifecycle requests are not rejected or serialized.
- The focused test treats a successful pause call as proof that the remote session was cancelled.

Risk:

- Orchestra can claim pause/resume/cancellation that did not occur, while remote work continues and recovery acts on false state.
- Concurrent lifecycle requests can reorder provider and local state irreconcilably.

Deferred adjustment:

- Model requested, acknowledged, ambiguous, and reconciled lifecycle transitions explicitly with legal-state guards and idempotency keys.
- Map only documented provider operations to accurate UI/API language; do not label pause as cancellation.
- Persist intent before the call and reconcile actual state through polling before finalizing local state.

### R-127 — The import route trusts caller-supplied Git identities and can return success after review failure

Severity: **High**
Status: **Open**
Dependency impact: **Blocks PR import, verification, review, and any integration phase**

Evidence:

- `/tasks/:id/jules/import-pr` accepts `prHeadSha` and `baseSha` directly from the HTTP body and lets them override durable cloud-session values.
- A cloud session is not required when both body strings are supplied, and neither value is validated as an exact full SHA or bound to a validated PR URL/repository/task.
- The underlying review helper accepts arbitrary Git refs, can fall back to local `HEAD`, and has the exact-identity/fetch/error defects recorded in R-078 through R-085.
- The route calls Codex even when `runWorktreeReview` returns `ok: false`, then returns top-level `{ ok: true }` without checking the worktree or Codex result.
- It exposes Git fetch/worktree mutation, repository-code verification, Codex execution, and cleanup directly from an HTTP controller with no durable workflow state, repository lock, idempotency, cancellation propagation, or result checkpoint.
- This is future Phase 19–21 behavior activated before the prerequisite polling/recovery and exact PR resolution phases.

Risk:

- A request can review local/arbitrary code rather than the Jules PR head and still receive an apparent success.
- Concurrent requests can execute untrusted code and mutate shared Git/worktree state on the Orchestra host without recovery or fencing.

Deferred adjustment:

- Remove caller authority over commit identity; start from the task-owned validated GitHub PR URL, fetch its PR ref, resolve the exact full remote head SHA, and compare it with durable session/cycle state.
- Schedule import/verification/review through a durable application workflow under repository locking and sandboxed execution, checking every stage result before transition.
- Return stable asynchronous workflow status rather than running Git/model work inside the request lifetime.

### R-128 — The Phase 16 controller is a larger cross-layer monolith despite the new boundary rules

Severity: **High**
Status: **Open**
Dependency impact: **Blocks maintainable integration of subsequent cloud phases**

Evidence:

- `jules.ts` grew to 453 lines and owns 14 credential, discovery, dispatch, query, approval, feedback, lifecycle, activity, Git review, and Codex-review endpoints.
- The route module constructs/resolves concrete vault, API client, and session manager dependencies and directly orchestrates Store repositories, provider calls, Git/worktree review, verification, Codex review, and event persistence.
- It contains workflow policy and state transitions rather than limiting controllers to authentication, validation, and HTTP mapping as required by `implementation-integrity.md`.
- The overload accepting `Store | JulesRouterOptions` and mutable lazy `sessionManager` add construction modes rather than clear application ports.
- No application services, request schemas, command/query handlers, durable workflow/outbox, or provider-neutral lifecycle interfaces were introduced.

Risk:

- Adding monitoring, recovery, UI actions, PR import, repair, or another provider expands one high-coupling controller and can disrupt unrelated credential or session routes.
- Network request lifetime becomes the owner of durable provider, Git, verification, and model workflows, making failure isolation and restart recovery difficult.

Deferred adjustment:

- Split HTTP schemas/controllers by feature and keep them thin over provider-neutral application commands/queries.
- Extract durable dispatch, plan interaction, lifecycle control, activity querying/polling, and PR import/review services with narrow repositories/adapters and explicit transactions.
- Compose dependencies once at bootstrap and add import-graph rules that reject route-to-infrastructure/provider workflow orchestration.

### R-129 — Tests use better mechanics but still validate invented contracts and bypass the required safety properties

Severity: **High**
Status: **Open**
Dependency impact: **Blocks the Phase 16 completion claim**

Evidence:

- Positive: the tests issue real HTTP requests, use Express, temporary SQLite, and a temporary Git repository, and clean up their resources.
- They do not test any planned Phase 16 polling acceptance criterion: pagination completion, durable cursor, deduplication/order, restart, multi-instance lease, rate limits/backoff, paused cadence, terminal stop, or unknown-type persistence.
- The dispatch test exposes and uses production `skipPush`, fabricates an origin-tracking ref locally without remote verification, and therefore removes the Git guarantee it claims to exercise.
- Provider fixtures preserve the implementation-invented `:sendFeedback`/`message` contract and treat pause as cancellation rather than using authoritative provider fixtures.
- The happy-path test approves and sends feedback in `PLANNING` and asserts only HTTP 200/provider booleans, encoding behavior forbidden by Phase 15 acceptance criteria.
- There are no malformed input, wrong-state, cross-project ownership, duplicate/concurrent request, timeout-after-acceptance, partial-write, restart, provider error mapping, failed review, changed SHA, cleanup, or request-cancellation tests.
- Both focused tests and all 117 repository tests passed while the adversarial HTTP probe reproduced duplicate remote sessions, cross-project binding, repeated invalid actions, invalid pagination acceptance, and token loss.

Risk:

- Green tests create stronger-looking but false completion evidence and allow the controller to activate known-broken provider/Git workflows.

Deferred adjustment:

- Retain the real HTTP/SQLite/Git mechanics, but drive them from the authoritative phase acceptance map and documented provider fixtures.
- Replace bypass flags with injected ports, add negative/fault/concurrency/restart cases, and assert durable database/provider state rather than only response status.
- Add a completion-gate test matrix and architecture failure fixture matching the new Markdown rules before dependent work resumes.

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
