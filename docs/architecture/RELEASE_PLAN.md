# План стабилизации v1.0.0

Текущая версия разработки: **1.0.0-rc.5**. Переход к стабильной версии определяется критериями ниже, а не только изменением номера версии.

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

- **RC.4 (текущий):** исправлены межфайловые helper summaries, Points-to unknown/top propagation, recursive summary widening, mock classification/override semantics и обязательный row-level Jest reset. Добавлены adversarial inter-file fixtures и Node compatibility check.
- **RC.5 (текущий):** shareable real-run handoff — диагностический отчёт, заполняемая execution form, проверка Scenario ID/reportId и финализация общего JSON.
- **RC.6:** real Jest matrix + batching runtime assertions на настоящем Jest; ESM/CJS конфигурации consuming project и V8/Babel providers.
- **RC.7:** escaped-reference/interprocedural heap scope, performance/memory budgets, deterministic partial results и полный evidence audit.
- **Stable 1.0.0:** все gates закрыты либо каждый ограниченный capability явно принят как documented non-goal; нет известных output regressions.


### v1.0.0-rc.5 — real-run analysis handoff (implemented)

Every `--analysis-report` run also produces a fillable `*.analysis-run-form.json`. After tests execute in the consuming project, fill the per-scenario results and coverage/artifact metadata, then merge it with the diagnostic report using `tools/finalize-analysis-report.mjs`. Stable release still requires real Jest matrix and performance verification.
