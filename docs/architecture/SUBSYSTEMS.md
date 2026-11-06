# Подсистемы, контракты и ограничения

## Project / AST / Inference

- `src/project/load-typescript-project.mjs`: TypeScript Program и project configuration.
- `src/project/discover-functions.mjs`: стабильная идентификация анализируемых функций.
- `src/project/function-index.mjs`: project-wide FunctionIndex, разрешение import aliases/re-exports и классификация вызовов (project function / external / intrinsic / opaque).
- `src/ast/ast-facade.mjs`, `path-resolver.mjs`, `source-spans.mjs`: AST primitives, PathRef, aliases и source locations.
- `src/inference/type-model-provider.mjs`, `property-inference.mjs`: checker-backed type model, defaults, usage-based property facts.

TypeScript Node/Type/Symbol остаются на front-end/runtime границе; за неё передаются JSON-safe DTO или именованные операции.

## Data Flow Engine

`src/data-flow/` содержит:

- CFG, dominators/post-dominators, control dependence, natural loops;
- reaching definitions и liveness fixed points;
- pruned Cytron scalar SSA, dominator-tree renaming, versioned def-use и phi operands;
- field-sensitive Memory SSA, allocation-site points-to, strong/weak updates;
- local context-sensitive interprocedural summaries и транзитивные эффекты;
- Array Pipeline stage/index provenance и Reduce/loop flow summaries.

Прямые вызовы imported/re-exported project functions получают module-qualified summaries и parameter-path effect substitution; contract-only collaborator methods классифицируются как внешние зависимости. Ограничения: escaped-reference analysis, межмодульная heap state propagation и сложные динамические dispatch/dynamic import остаются консервативными; динамические индексы и may-alias используют weak updates. Неподдержанный факт остаётся unknown/unsupported и не превращается в доказанную alias-связь.

## Constraints / Solver

- `src/constraints/constraint-ir.mjs`: parser-independent IR и validation.
- `src/constraints/compile-typescript-condition.mjs`: TypeScript adapter.
- `src/solver/constraint-solver.mjs`: bounded multi-witness solver.
- `src/solver/constraint-analysis-service.mjs`: IR-first routing, preservation checks и fallback policy.
- `src/solver/recursive-ast-fallback.mjs`: conservative AST fallback через injected ports.

`unsupported`, budget truncation и unproven preservation не означают unsatisfiable. Telemetry сохраняет причины fallback. Публичный CLI value `legacy` — alias для `recursive-ast`.

## Control Flow / Arrays / MC/DC

`src/analysis/` содержит per-function/session orchestration, immutable operation ports, reducers, statement/loop analyzers, callback discovery, Array Pipeline runtime и path-sensitive bounded loop planner.

`src/mcdc/` разделяет decision extraction, unique-cause pair planning/feasibility, scenario materialization, source instrumentation, runtime recorder и verifier. Статическая пара не считается runtime verified, пока не прошли обе стороны и необходимые проверки inputs/runtime evidence.

## Scenarios / Mocks

- `ScenarioBuilder` создаёт только `ScenarioCase`.
- `ScenarioEvidenceBuilder` формирует assumptions, warnings и evidence.
- `ScenarioDeduplicator` учитывает arguments и mock behavior/results; evidence не меняет fingerprint.
- `MockPlanner` строит `MockPlan`; `DataFlowMockEnricher` добавляет зависимости и эффекты как candidate evidence.
- Project-local helpers и pure intrinsics не мокируются автоматически; external package calls, contract-only ports и явно распознанные host runtime seams остаются mockable. Явный `mockBehaviorOverrides` имеет приоритет.
- `JestMockAdapter` применяет domain mock actions к injected mock functions.

`src/reporting/scenario-report-adapter.mjs` и `mock-report-adapter.mjs` — единственное место проекции в старую публичную JSON-форму. Кандидатные mock/data-flow facts не равны runtime-verified поведению.

## Execution / Coverage / Minimization

`src/execution/` отвечает за Jest process, harness, чтение результатов и runtime traces. `src/coverage/` отвечает за Istanbul/source maps/branch mapping, scenario attribution и feedback transforms. `src/minimization/` строит obligations и выбирает exact/greedy minimal suite с сохранением обязательных outcomes и MC/DC pair sides.

Real Jest проверяется отдельно, с настоящей версией Jest и конфигурацией consuming project. Синтетический runner проверяет только внутренний контракт и не заменяет real integration.

## Test Batching Engine

`src/testing/batching/` состоит из `execution-signature.mjs`, `test-batch-builder.mjs` и `jest-each-generator.mjs`.

Группируются только соседние совместимые сценарии с одной execution shape и устойчивой идентичностью mock methods. Порядок регистрации сохраняется. Различающиеся arguments, expected values и supported mock payloads остаются row data. Сценарии, требующие изоляции, имеющие неизвестную mock identity или несовместимый lifecycle, запускаются индивидуально. Каждая строка `test.each` — отдельный тест со своим Scenario ID. Harness вызывает `jest.clearAllMocks()` перед каждой строкой, чтобы очистить историю вызовов, сохранив реализации моков из setup-файлов; затем выполняет optional project reset hook и row-specific mock application.

Настройки: `--no-test-batching`, `--test-batch-min-size`, `--test-batch-max-size`. Batching не заменяет ScenarioCase и выполняется после minimization.

## Reporting

`ReportBuilder` формирует отчётный DTO, `report-schema.mjs` валидирует публичную форму, `json-writer.mjs` отвечает за запись. Внутренние domain-модели не должны импортировать reporting serializers.
