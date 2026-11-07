# Branch Scenario Generator 1.0.0-rc.8

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
- В сценариях `externalCalls` перечислены внешние вызовы по call-site: выражение, аргументы, расположение в исходнике, `mockTarget` и кандидат поведения/значения.
- Jest-адаптер автоматически подготавливает поддерживаемые module exports до импорта тестируемого файла и применяет scenario-specific mocks для импортов, DI-параметров, `this` и известных global APIs. Неоднозначные dynamic bindings остаются явно помеченными `manual-setup-required`.
- `scenarioGroups` объединяет сценарии с идентичными `arguments + mocks`, сохраняя все branch targets. Это отдельная функция от Jest `test.each` batching: batching объединяет соседние случаи с одинаковой формой выполнения, даже если входные значения и значения моков различаются.

## Быстрый старт

Установи зависимости генератора (TypeScript и Jest 30.5.2 для integration tests):

### Конфигурация запуска

Чтобы не передавать одни и те же параметры при каждом запуске, создай в рабочем каталоге файл `branch-scenarios.config.json`. CLI автоматически загрузит его. В конфигурации используются те же имена параметров в `camelCase`, что и в `src/cli/parse-args.mjs`; пути к исходному файлу и результатам задаются относительно каталога, из которого запускается CLI.

```json
{
  "$schema": "./docs/schemas/branch-scenarios.config.schema.json",
  "file": "src/passenger.ts",
  "functionName": "getPassengerCategory",
  "out": "test-data/passenger.scenarios.json",
  "maxScenarios": 40,
  "mcdc": true,
  "coverageFeedback": true,
  "analysisReport": true,
  "coverageProvider": "v8"
}
```

После этого достаточно выполнить `node /path/to/generator/branch-scenarios.mjs`. Аргументы командной строки переопределяют значения файла конфигурации. Можно выбрать другой файл через `--run-config path/to/config.json` или отключить автоматическую загрузку через `--no-run-config`. Полный стартовый шаблон находится в `branch-scenarios.config.example.json`.

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
  --out passenger.scenarios.json
```

Coverage feedback через Jest:

```bash
node branch-scenarios.mjs src/passenger.ts \
  --function getPassengerCategory \
  --coverage-feedback \
  --jest-config jest.config.js
```

`--jest-timeout <ms>` ограничивает один запуск Jest (по умолчанию 120000 ms), а `--coverage-feedback-timeout <ms>` задаёт общий бюджет всех итераций Coverage Feedback (по умолчанию 600000 ms). При исчерпании бюджета отчёт получает отдельный статус `execution-timeout`.

`--constraint-engine legacy` оставлен как публичный совместимый псевдоним режима `recursive-ast`; рекомендуемый режим — `hybrid`.

## Проверки

```bash
npm run check:contracts
npm run test:architecture
npm test
```

`npm install` устанавливает закреплённый Jest `30.5.2`. `npm test` включает обязательный реальный Jest integration test; отсутствие установленного Jest теперь считается ошибкой подготовки окружения, а не успешным skip. `npm run test:real-jest` можно запускать отдельно.

## Документация

- [Индекс документов](docs/README.md)
- [Архитектура и правила зависимостей](docs/architecture/ARCHITECTURE.md)
- [Подсистемы и контракты](docs/architecture/SUBSYSTEMS.md)
- [Статус проверок](docs/architecture/VALIDATION_STATUS.md)
- [План выхода на стабильный v1.0.0](docs/architecture/RELEASE_PLAN.md)
- [История реализации v0.19–v1.0.0-rc.8](docs/releases/IMPLEMENTATION_HISTORY.md)

## Требования

- Node.js `>=24.0.0`.
- TypeScript `5.8.3` — точная зависимость генератора для AST/type analysis.
- Jest `30.5.2` — точная `devDependency` генератора для реальных integration tests. При coverage-feedback runner предпочитает Jest целевого проекта; поддерживается только Jest `>=30.5.2 <31.0.0`, а `--jest-bin` позволяет выбрать конкретную установку. `jest-unit` не является зависимостью генератора.

## Shareable analysis report

After generating scenarios for a real project, add `--analysis-report` to write a separate `*.analysis-report.json` file and a companion `*.analysis-run-form.json` form for recording results from real test runs. It contains project/import and function indexes, call-graph edges, Data Flow/SSA/Points-to summaries, scenario/mock metadata, unsupported/fallback diagnostics, and Jest/Istanbul results when `--coverage-feedback` is used. The default `shape` value mode redacts scenario values; use `--analysis-report-values hash` to correlate values without revealing them, or `include` only when you have reviewed the data and explicitly want raw test values in the export.

Example:

```bash
node branch-scenarios.mjs src/feature.ts --function calculate --mcdc --coverage-feedback --include-evidence --analysis-report
```

В `*.analysis-report.json` у каждой функции есть `scenarioGroups` — группы одинаковых входных данных и моков с `scenarioIds` и всеми целевыми ветвями. Основной `*.scenarios.json` сохраняет прежний формат. Каждая запись `scenario.externalCalls` содержит конкретный вызов, его аргументы, `mockTarget` и сценарный кандидат ответа. При `--coverage-feedback` Jest-адаптер автоматически применяет поддерживаемые цели (`module-export`, `object-member`, `parameter-callable`, `this-member`, `global-member`) до/во время каждого теста. Неразрешённые или динамические связи помечаются `manual-setup-required`; для них остаётся hook `__BRANCH_SCENARIO_APPLY_MOCKS__`. `appliedAutomatically` в статическом JSON остаётся `false`, поскольку фактическое применение происходит только во время выполнения Jest.

Use `--analysis-report-form-out <file.json>` to choose a custom form path. After running tests, fill `*.analysis-run-form.json` (keep every `scenarioId` unchanged), then create the merged report with `node tools/finalize-analysis-report.mjs <analysis-report.json> <analysis-run-form.json>`. Attach the resulting `*.final.json` here. For failures, also attach the smallest relevant source files with secrets removed and the exact test command. See `docs/README.md` for the workflow.


## Platform requirements (rc.8)

- Node.js `>=24.0.0` (CI matrix: 24.x and 26.x; `.nvmrc` selects 26).
- Jest `30.5.2` is pinned for generator development and integration tests. Coverage feedback validates the consuming project's Jest version.
- TypeScript is pinned to `5.8.3`; install the exact direct dependency versions with `npm install`. CI runs `npm ci` when `package-lock.json` is present; this prepared archive does not include the repository lockfile because the npm registry was unreachable during assembly, so use `npm install` for this archive and regenerate/commit the lockfile before a reproducible release.


### Security note for runtime MC/DC

`--coverage-feedback --mcdc` evaluates selected condition expressions with the JavaScript `Function` constructor to validate concrete input values. This happens inside the same Node/Jest process that imports and executes the target module. Only use runtime feedback with source code you trust; do not run it against untrusted repositories or pull requests in a privileged environment.
