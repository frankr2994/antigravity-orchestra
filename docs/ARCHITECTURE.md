# Antigravity Orchestra — System Architecture & Modularity Boundaries

This document defines the architectural layers, module ownership, dependency direction rules, and provider boundaries for Antigravity Orchestra.

---

## 1. Architectural Layers & Dependency Direction

Orchestra follows clean hexagonal / onion architecture principles:

```
┌────────────────────────────────────────────────────────┐
│                   Presentation & API                   │
│   (server/api/*, src/app/*, src/features/*)            │
└───────────────────────────┬────────────────────────────┘
                            │ depends on
                            ▼
┌────────────────────────────────────────────────────────┐
│                  Application Workflows                 │
│   (server/application/*, Task Orchestration, Review)   │
└───────────────────────────┬────────────────────────────┘
                            │ depends on
                            ▼
┌────────────────────────────────────────────────────────┐
│                      Domain Layer                      │
│   (server/domain/*, Task States, Provider Contracts)   │
└───────────────────────────▲────────────────────────────┘
                            │ implements / adapts
              ┌─────────────┴─────────────┐
              │                           │
┌─────────────┴────────────┐ ┌────────────┴────────────┐
│   Execution Providers    │ │ Infrastructure Adapters │
│  (server/providers/*)    │ │ (server/infrastructure) │
│  - Antigravity (Local)   │ │  - SQLite Persistence   │
│  - Jules (Cloud)         │ │  - Git Operations       │
│  - Codex (Auditor)       │ │  - Process Runner       │
│  - Gemma (Distiller)     │ │  - OS Credential Store  │
└──────────────────────────┘ └─────────────────────────┘
```

### Dependency Rules:
1. **Unidirectional Inward Dependencies:**
   * Outer layers depend on inner layers.
   * `API/UI` $\to$ `Application Workflows` $\to$ `Domain Interfaces`.
2. **Domain Isolation:**
   * Domain modules (`server/domain/`) MUST NOT import from `infrastructure/`, `providers/`, `application/`, or `api/`.
   * Domain defines pure interfaces, entities, state machines, and contracts.
3. **Provider Isolation:**
   * Providers (`server/providers/`) implement domain provider interfaces.
   * Providers MUST NOT import SQLite singletons or write directly to the database.
   * Generic task modules MUST NOT inspect raw provider-specific response objects (e.g. Jules API alpha fields).
4. **Route Handler Simplicity:**
   * API Route handlers parse HTTP/SSE input, invoke application services, and return responses.
   * Route handlers MUST NOT implement business logic or issue raw SQL queries directly.
5. **No Monolithic Expansion:**
   * New functionality is placed into modular feature packages rather than enlarging legacy coordinator files.

---

## 2. Server Module Organization

```
orchestra-dashboard/server/
├── api/
│   ├── routes/              # HTTP endpoint definitions
│   ├── controllers/         # Request handling & schema validation
│   ├── middleware/          # Security, error handling, logging
│   └── sse/                 # Server-Sent Events stream manager
├── application/
│   ├── tasks/               # Task lifecycle orchestration
│   ├── routing/             # Task target selection (Auto, Local, Cloud)
│   ├── review/              # Codex independent review coordinator
│   ├── verification/        # Deterministic build & test verification
│   └── recovery/            # Crash recovery & session reconciliation
├── domain/
│   ├── tasks/               # OrchestraTaskState, Task entity, Event schemas
│   ├── execution/           # ExecutionAttempt, Target (local/cloud/auto)
│   ├── events/              # Canonical TaskEvent & Timeline event models
│   └── providers/           # ExecutionProvider & Specialist interfaces
├── providers/
│   ├── antigravity/         # Antigravity CLI local worker adapter
│   ├── codex/               # Codex CLI / App-Server specialist adapter
│   ├── gemma/               # Local Gemma LM Studio client adapter
│   └── jules/               # Google Jules Cloud API client & poller
├── infrastructure/
│   ├── database/            # SQLite repositories & versioned migrations
│   ├── git/                 # Git operations, worktrees, locks, diffs
│   ├── processes/           # Process runner with timeout & idle monitors
│   ├── credentials/         # OS credential store & environment variable access
│   └── logging/             # Structured redaction & telemetry
└── bootstrap/               # Application wiring & dependency injection
```

---

## 3. Frontend Module Organization

```
orchestra-dashboard/src/
├── app/                     # App shell, root layout, context providers
├── api/                     # Typed client API hooks and SSE subscriber
├── features/
│   ├── tasks/               # Task submission, prompt composer, queue
│   ├── cloud-execution/     # Jules cloud session panel, activity feed
│   ├── projects/            # Project switcher, onboarding, greenfield
│   ├── checkpoints/         # Git commit history & diff viewer
│   ├── settings/            # Models, timeouts, credentials configuration
│   └── monitoring/          # Run health, token gauges, context metrics
└── shared/
    ├── components/          # Buttons, modals, cards, badges, status chips
    ├── hooks/               # useEventStream, useLocalStorage, useDebounce
    ├── types/               # Generated or shared domain types
    └── utilities/           # Date formatters, diff formatters, text helpers
```

---

## 4. Provider Boundaries & State Mapping

### Core State Separation:
To avoid vendor lock-in and state corruption, Orchestra enforces strict state hierarchy:

1. **`OrchestraTaskState` (Domain Level):**
   `queued` | `running` | `reviewing` | `verifying` | `completed` | `completed_unpushed` | `failed` | `recovering` | `recovery_required` | `baseline_required` | `review_disputed` | `cancelled`

2. **`ProviderExecutionState` (Contract Level):**
   `IDLE` | `DISPATCHING` | `EXECUTING` | `AWAITING_INPUT` | `SUCCEEDED` | `FAILED`

3. **`JulesSessionState` (Adapter Level):**
   `STATE_UNSPECIFIED` | `QUEUED` | `PLANNING` | `AWAITING_PLAN_APPROVAL` | `AWAITING_USER_FEEDBACK` | `IN_PROGRESS` | `PAUSED` | `COMPLETED` | `FAILED`

The Jules Provider adapter maps raw `JulesSessionState` $\to$ standard `OrchestraTaskState`.
Unknown future cloud states degrade safely without crashing the system.

---

## 5. Automated Verification & Architecture Checks

All code changes are automatically validated against these boundaries via:
* `npm run lint` (`oxlint` checking for unused imports, syntax, and bad patterns)
* `npm test` (`tests/architecture-rules.test.mjs` verifying file boundaries, prohibited imports, and circular dependencies)
* `npm run check` (full end-to-end typecheck, build, and unit verification)
