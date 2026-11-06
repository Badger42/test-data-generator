# План стабилизации v1.0.0

Текущая версия разработки: **1.0.0-rc.7**. Переход к стабильной версии определяется критериями ниже, а не только изменением номера версии.

## Обязательные release gates

1. **Real Jest integration:** запустить `tests/real-jest.integration.mjs` на поддерживаемых версиях Jest и на конфигурациях consuming project. Проверить ESM/CJS трансформации, setup hooks, mock reset, `test.each`, retries/timeouts, V8 и Babel coverage providers.
2. **End-to-end batching:** подтвердить реальную регистрацию каждого `test.each` row как отдельного теста, правильное применение/сброс mock state, сохранение порядка, Scenario ID и coverage attribution.
3. **Whole-project analysis:** определить и протестировать поддержку импортируемых функций, межфайловых summaries, recursion/SCC convergence, escaped references и invalidation effects. Если часть языка остаётся неподдержанной — явно задокументировать fragment и conservative fallback.
4. **Evidence completeness:** провести аудит branch, MC/DC, callback, loop и feedback-expanded producers; статические candidate evidence и runtime-verified evidence должны различаться во всех отчётах.
5. **Performance / robustness:** benchmark на небольших, средних и крупных реальных TS-проектах; установить лимиты CPU/memory, deterministic partial results, поведение при budget exhaustion и cancellation.
6. **API / report compatibility:** зафиксировать CLI, JSON schema, test-batching config и deprecated aliases; golden/differential tests должны сравнивать целостный публичный payload.
7. **Architecture enforcement:** `npm run check:contracts`, автоматическая проверка всех source imports, отсутствие циклов и forbidden dependency directions в CI.

## Политика Legacy / fallback

Старый `src/legacy` и монолитный `legacy-engine.mjs` удалены. Стабильный релиз не требует удаления консервативного recursive-AST fallback: он является отдельным solver adapter для явно unsupported/unproven IR fragments. Публичный `--constraint-engine legacy`, telemetry key `legacyFallback` и deprecated type aliases сохраняются на период обратной совместимости; они должны быть описаны как aliases/metrics, а не как отдельная архитектурная подсистема.

`src/runtime/typescript-analysis-runtime.mjs` — TypeScript-specific composition root. Его допустимо далее дробить только при наличии устойчивых портов и независимых тестов; сам факт, что composition root знает о многих реализациях, не нарушает dependency direction, если нижние слои не импортируют runtime.

## Рекомендуемая последовательность закрытия

- **RC.4 (released):** исправлены межфайловые helper summaries, Points-to unknown/top propagation, recursive summary widening, mock classification/override semantics и обязательный row-level Jest reset. Добавлены adversarial inter-file fixtures и Node compatibility check.
- **RC.5 (released):** shareable real-run handoff — диагностический отчёт, заполняемая execution form, проверка Scenario ID/reportId и финализация общего JSON.
- **RC.6 (released):** Jest `26.6.0` закреплён в `devDependencies`; real-Jest integration обязателен для `npm test`, без молчаливого skip. Runner продолжает предпочитать Jest целевого проекта; `JEST_BIN` используется для явной проверки другой установки. Следующая задача — matrix ESM/CJS и V8/Babel в consuming project.
- **RC.7 (current):** обновление Node/Jest, корректность harness и test batching, безопасное исключение неподдерживаемых сценариев, runtime exception outcomes, V8/Istanbul remapping, CLI validation и CI. Оставшиеся проверки перечислены в `VALIDATION_STATUS.md`. Lockfile не включён в RC.7 из-за недоступности npm registry и остаётся обязательным pre-stable gate.
- **Stable 1.0.0:** все gates закрыты либо каждый ограниченный capability явно принят как documented non-goal; нет известных output regressions.


### v1.0.0-rc.5 — real-run analysis handoff (implemented)

Every `--analysis-report` run also produces a fillable `*.analysis-run-form.json`. After tests execute in the consuming project, fill the per-scenario results and coverage/artifact metadata, then merge it with the diagnostic report using `tools/finalize-analysis-report.mjs`. Stable release still requires real Jest matrix and performance verification.

### v1.0.0-rc.6 — Jest 26.6.0 development dependency

- Added exact `jest: 26.6.0` devDependency.
- Added a dependency-contract test that verifies the manifest pin and installed Jest version.
- Real Jest integration is no longer reported as a successful skip when Jest is missing.
- Jest discovery still prefers the consuming project's installation; `--jest-bin`/`JEST_BIN` remains available for explicit selection.
- `jest-unit` is intentionally not included.


### v1.0.0-rc.7 — Node.js 24+ / Jest 30.5.2

- Runtime baseline raised to Node.js >=24.0.0. CI targets Node 24 and 26; `.nvmrc` and `.node-version` select Node 26.
- Generator development integration is pinned to Jest 30.5.2. The consumer project's Jest is validated separately before coverage feedback runs.
- TypeScript dependency is pinned to 5.8.3. A committed lockfile remains blocked on registry access and is still a pre-stable release gate.
- Harness batching uses positional rows and `%s` titles with unique Scenario IDs; fake Jest runner intercepts only the generated test module and does not use `NODE_PATH`.
- Instrumented-source branch/statement/function locations are remapped against the generated instrumented source text; line counters are rebuilt from remapped statements.
- Expected exceptions are retained on branch and MC/DC execution cases; unsupported destructured parameters and unsupported solver outcomes are reported instead of receiving fabricated values.
- Syntax errors and missing CLI values fail explicitly; output directories must already exist.
- Test suite runs discovered test modules with bounded concurrency; Node 24/26 CI workflow added.
