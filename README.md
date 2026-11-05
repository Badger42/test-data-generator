# Branch Scenario Generator 1.0.0-rc.5

Генератор тестовых данных и Jest-сценариев для JavaScript/TypeScript-функций. Анализирует AST, Control Flow и Data Flow, строит ограничения, подбирает входные значения и моки, а при включённом coverage feedback проверяет результат реальным запуском Jest.

> **Статус:** release candidate. Старый монолитный Legacy Engine удалён; остались TypeScript-aware composition root и консервативный recursive-AST fallback для фрагментов, которые пока нельзя доказанно решить через Constraint IR.

## Возможности

- CFG, dominators, reaching definitions, Cytron scalar SSA и field-sensitive Heap/Memory SSA.
- Allocation-site points-to, локальные context-sensitive summaries и provenance Array Pipeline.
- Constraint IR / Solver с bounded multi-witness solving и явной диагностикой fallback.
- Branch, loop, array callback и MC/DC scenario generation.
- ScenarioCase / MockPlan с Data Flow evidence и provenance.
- Coverage feedback, per-scenario attribution и минимизация набора тестов.
- Jest `test.each` batching для соседних совместимых сценариев; несовместимые случаи запускаются индивидуально.
- Стабильный JSON-отчёт; подробные статические evidence включаются через `--include-evidence`.

## Быстрый старт

```bash
npm install
node branch-scenarios.mjs src/passenger.ts --function getPassengerCategory
```

Сбор данных для branch и MC/DC:

```bash
node branch-scenarios.mjs src/passenger.ts \
  --function getPassengerCategory \
  --mcdc \
  --include-evidence \
  --out test-data/passenger.scenarios.json
```

Coverage feedback через Jest:

```bash
node branch-scenarios.mjs src/passenger.ts \
  --function getPassengerCategory \
  --coverage-feedback \
  --jest-config jest.config.js
```

`--constraint-engine legacy` оставлен как публичный совместимый псевдоним режима `recursive-ast`; рекомендуемый режим — `hybrid`.

## Проверки

```bash
npm run check:contracts
npm run test:architecture
npm test
```

`npm test` запускает функциональные, regression, golden, batching, reporting и интеграционные тесты. `npm run test:real-jest` требует установленного Jest и конфигурации целевого проекта.

## Документация

- [Индекс документов](docs/README.md)
- [Архитектура и правила зависимостей](docs/architecture/ARCHITECTURE.md)
- [Подсистемы и контракты](docs/architecture/SUBSYSTEMS.md)
- [Статус проверок](docs/architecture/VALIDATION_STATUS.md)
- [План выхода на стабильный v1.0.0](docs/architecture/RELEASE_PLAN.md)
- [История реализации v0.19–v1.0.0-rc.5](docs/releases/IMPLEMENTATION_HISTORY.md)

## Требования

- Node.js `>=14.17`.
- TypeScript `^5.8.3` для AST/type analysis.
- Jest — только для реального coverage-feedback/integration запуска.

## Shareable analysis report

After generating scenarios for a real project, add `--analysis-report` to write a separate `*.analysis-report.json` file and a companion `*.analysis-run-form.json` form for recording results from real test runs. It contains project/import and function indexes, call-graph edges, Data Flow/SSA/Points-to summaries, scenario/mock metadata, unsupported/fallback diagnostics, and Jest/Istanbul results when `--coverage-feedback` is used. The default `shape` value mode redacts scenario values; use `--analysis-report-values hash` to correlate values without revealing them, or `include` only when you have reviewed the data and explicitly want raw test values in the export.

Example:

```bash
node branch-scenarios.mjs src/feature.ts --function calculate --mcdc --coverage-feedback --include-evidence --analysis-report
```

Use `--analysis-report-form-out <file.json>` to choose a custom form path. After running tests, fill `*.analysis-run-form.json` (keep every `scenarioId` unchanged), then create the merged report with `node tools/finalize-analysis-report.mjs <analysis-report.json> <analysis-run-form.json>`. Attach the resulting `*.final.json` here. For failures, also attach the smallest relevant source files with secrets removed and the exact test command. See `docs/README.md` for the workflow.
