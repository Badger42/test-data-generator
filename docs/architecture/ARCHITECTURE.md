# Архитектура и межмодульные зависимости

## 1. Основной поток

```text
CLI / Project Loader
  → Project-wide FunctionIndex + TypeScript Front-end (AST, TypeChecker, PathResolver, Inference)
  → FunctionContextBuilder + FunctionDataModel
  → Control Flow / Array / Loop / MC/DC analysis
  → Constraint Compiler → Constraint IR → Solver
  → ScenarioCase + MockPlan
  → Reporting / Coverage / Minimization
  → TestBatchBuilder → Jest test.each или индивидуальный тест
```

Coverage Feedback может повторно запустить анализ для непокрытых branch obligations. Runtime coverage и MC/DC verification используют только фактические результаты исполнения; статическое Data Flow evidence само по себе не считается runtime coverage.

## 2. Слои

| Слой | Каталоги | Ответственность |
|---|---|---|
| Interface | `src/cli` | Парсинг аргументов, help и composition invocation. |
| Application | `src/application` | Use cases и orchestration; получает анализатор и runtime операции через injection. |
| Runtime / infrastructure | `src/runtime`, `src/execution` | TypeScript-aware composition, process/filesystem/Jest adapters. |
| Front-end | `src/project`, `src/ast`, `src/inference` | Загрузка проекта, project-wide FunctionIndex/import resolution, AST primitives, type model, path resolution и property inference. |
| Domain | `src/domain` | Общие политики и стабильные значения; leaf layer без импортов из других слоёв. |
| Compiler | `src/constraints`, `src/solver` | AST-to-IR adapter, parser-independent IR Solver и ограниченный recursive-AST fallback. |
| Analysis | `src/analysis`, `src/data-flow`, `src/mcdc` | CFG, SSA, Data Flow facts, function analysis и MC/DC planning/verification. |
| Generation | `src/scenarios`, `src/mocks` | Domain ScenarioCase и MockPlan. Не знают о публичном JSON-формате и Jest runtime. |
| Output / quality | `src/reporting`, `src/coverage`, `src/minimization`, `src/testing` | Report DTO projection, coverage attribution, set-cover minimization и batching. |

## 3. Правила направления зависимостей

1. `domain` не импортирует ни один другой слой.
2. `constraints` и `solver` могут использовать только `domain` и собственные compiler-модули. Сам `ConstraintSolver` получает `ConstraintExpr`, не `ts.Node`.
3. Data Flow core не импортирует TypeScript package, runtime, application, Solver или reporting. AST/type операции передаются через front-end adapters; результат `FunctionDataModel` — JSON-safe DTO.
4. `inference` не зависит от `analysis`; общие Array method policies находятся в `domain`.
5. `ScenarioBuilder` и `MockPlanner` не импортируют `reporting`; проекции публичных report DTO выполняются в `src/reporting/*-report-adapter.mjs`.
6. Application use cases не импортируют TypeScript runtime. `src/cli/main.mjs` — composition root, который внедряет runtime implementations.
7. Jest runner получает process/filesystem ports. Batching engine не импортирует TypeScript или runtime.
8. Чистые reducers, obligation builders и coverage feedback transforms не импортируют application/runtime services.
9. Циклические относительные импорты запрещены. `tests/module-boundaries.mjs` автоматически обнаруживает каждый `.mjs` под `src/`, проверяет разрешение импортов, layering и cycles.

## 4. Composition root и остаточная compatibility

`src/runtime/typescript-analysis-runtime.mjs` создаёт TypeScript-backed adapters и соединяет их портами. Это composition root, а не старый монолитный анализатор: session state, CFG/Data Flow, Solver, MC/DC, Scenario, Mock, Reporting и execution algorithms находятся в самостоятельных модулях.

Каталога `src/legacy` и старого `legacy-engine.mjs` в поставке нет. Публичный флаг `--constraint-engine legacy` сохранён для обратной совместимости и маршрутизируется во внутренний режим `recursive-ast`. `legacyFallback` в старых JSON diagnostics и несколько deprecated TypeScript aliases также сохранены как внешние compatibility поля; они не обозначают отдельный модуль Legacy.

`src/solver/recursive-ast-fallback.mjs` — ограниченный fallback для AST-конструкций, где компиляция или доказательство полноты Constraint IR пока не подтверждены. Он получает узкие операции через injection, не импортирует TypeScript package и не содержит старого монолитного контекста. Удалять этот fallback можно только после differential parity для поддерживаемой syntax matrix.

## 5. DTO и границы

- `FunctionDataModel`: JSON-safe CFG, SSA/Memory SSA, aliases, points-to с explicit unknown/top state, mutation, project-wide function summaries, array pipeline и provenance.
- `ConstraintExpr`: parser-independent ограничение для Solver.
- `AnalysisOperationContext`: immutable именованные ports (`function`, `limits`, `constraints`, `paths`, `arrays`, `mcdc`, `events`); общего `compatibility.context` нет.
- `ScenarioCase`: доменный сценарий с аргументами, mocks, targets, assumptions, warnings и fingerprint.
- `MockPlan`: доменные mock actions и поведение, без сериализации публичного отчёта.
- `TestBatch`: упорядоченная регистрация группы совместимых ScenarioCase; каждая строка остаётся самостоятельным Jest test case.

Подробности по подсистемам и ограничениям приведены в [SUBSYSTEMS.md](SUBSYSTEMS.md). Проверка текущего графа и матрица тестов — в [VALIDATION_STATUS.md](VALIDATION_STATUS.md). Машинно-читаемый список модулей находится в `MODULE_MAP.json`, диаграмма импортных и data-flow связей — в `DEPENDENCY_GRAPH.mmd`.
