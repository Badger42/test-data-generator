# Validation status — v1.0.0-rc.5

## Исправления по межфайловому аудиту rc.3

- Project-wide `FunctionIndex` строится по всем implementation source files TypeScript Program; summaries используют module-qualified symbol/function IDs и корректные source spans каждого файла.
- Реэкспортированные и переименованные imports разрешаются до исходного declaration symbol; summaries imported helpers и их parameter-based effects доходят до вызывающего файла.
- Project-local functions и pure intrinsics больше не превращаются автоматически в моки. Внешними считаются node_modules dependencies, host `globalThis` seams и contract-only methods без реализации. Явный `mockBehaviorOverrides` пользователя сохраняет приоритет.
- Points-to анализ включает `unknown/top` для переменных и heap fields; unknown reassignment/store распространяет неопределённость, а Memory SSA не выполняет unsafe allocation-site canonicalization.
- Recursive SCC uncertainty устанавливается до fixed-point propagation и распространяется на вызывающие summaries; недоказанные helper aliases остаются недоступными Solver.
- В production SSA устранён `Array.prototype.at`; Node compatibility suite проверяет все production `.mjs`.
- Generated Jest harness безусловно вызывает `jest.resetAllMocks()` перед каждой строкой `test.each`, затем выполняет optional project reset hook и применяет row-specific mocks.
- Behavior-only mock override меняет Jest behavior, сохраняя значение, рассчитанное Solver; явный `value` заменяет его.

## Архитектурные проверки

- `npm run check:contracts`: passed.
- `node tests/module-boundaries.mjs`: passed; 113 автоматически обнаруженных source modules, отсутствуют относительные циклы и запрещённые направления зависимостей.
- `node tests/interfile-regressions.mjs`: passed; imported/re-exported helpers, source spans, pure intrinsics, callback boundaries, external dependencies, points-to widening и recursive caller uncertainty.
- `node tests/node-compatibility.mjs`: passed; 112 production `.mjs` не используют `Array.prototype.at` при `engines.node >=14.17`.
- Documentation structure: passed; 7 Markdown-файлов, история IMPLEMENTED сведена в единый документ.
- `MODULE_MAP.json` синхронизирован с package version и деревом исходников.

## Функциональные группы

Успешно завершены отдельными командами:

- Type/Path/Inference; Constraint IR/Solver, compiler, hybrid migration, extended operands и multi-witness.
- Standard/callback/advanced MC/DC: 17 + 21 + 15 independence pairs.
- Function Analysis Session/state, expression traversal, function orchestration и operation-context tests.
- Data Flow CFG/SSA, Points-to/Memory SSA, imported FunctionSummary, Data Flow → Constraint Compiler.
- Array callback, Array Pipeline, Reduce, sorting/flat/last и array-dataflow fixtures (192 scenarios).
- Scenario Engine, Mock Engine, production Mock Planner и explicit override behavior.
- Execution/Coverage, fake Jest feedback, mock setup, iterative feedback, branch mapping и minimization.
- Test Batching, `test.each` rendering, row isolation и incompatible-case fallback.
- Reporting, CLI modules, cross-file CLI integration и v1 integration tests.
- Golden baseline: 11 fixtures; golden compatibility с frozen v0.18 output.

`node tests/real-jest.integration.mjs` завершился штатным `skipped`: Jest не установлен. Синтетический Jest-compatible runner проверяет harness hooks и flow, но не заменяет проверку на настоящей поддерживаемой версии Jest.

## Итог полного прогона

`npm test` запускался единым процессом, но достиг 300-секундного лимита среды. Это не засчитано как успешный one-shot прогон. Все тестовые группы из сценария запуска затем проверялись отдельными командами или ограниченными пакетами; все завершённые команды вернули success, за исключением real-Jest test, который штатно skipped из-за отсутствия Jest.

## Оставшиеся ограничения

- Реальная Jest matrix: поддерживаемые версии Jest, ESM/CJS трансформации consuming project, V8/Babel coverage providers и реальный `test.each` lifecycle.
- Escaped-reference / interprocedural heap analysis остаётся ограниченным; неизвестные эффекты консервативно расширяют `top` и не доказывают `must-alias`.
- Полная path-sensitive heap analysis, межмодульные циклические компоненты с контекстным memory state и broad project performance benchmarks не заявляются завершёнными.
- Статические Data Flow evidence являются candidate/diagnostic, не доказательством runtime coverage.

Этот файл описывает фактически наблюдавшиеся результаты rc.4. Единый `npm test` не объявлен passed, поскольку он не завершился с exit code 0 в лимит среды.


## v1.0.0-rc.5 — shareable real-run report form

- Added a companion `*.analysis-run-form.json` generated together with the diagnostic analysis report.
- The form pre-populates scenario/function/branch IDs and leaves real execution statuses as `not-run` until the user or CI fills them.
- Added schema validation and `tools/finalize-analysis-report.mjs` to merge a filled form into the matching diagnostic report after `reportId` and Scenario ID validation.
- Captures runner command, Node/Jest/TypeScript versions, duration, per-scenario status/failure, coverage metrics, JUnit/Jest/coverage artifacts, notes and issues.
- Absolute artifact paths are rejected; finalizer redacts absolute paths and high-entropy tokens in user-entered command/failure details. Manual values are flagged for review before sharing.
- Added unit and CLI integration tests for fillable form generation, manual result merging, unknown Scenario IDs, reportId mismatch and path redaction.

## v1.0.0-rc.5 — real-run analysis report handoff

- `npm run check:contracts`: passed, including the expanded `AnalysisRunForm` and finalizer contracts.
- `npm run test:reporting`: passed; public report schema, project graph, call graph, Data Flow summary, redaction, hash/include modes, run-form generation and finalizer validation.
- `npm run test:v1-integrations`: passed; Data Flow evidence, evidence-safe projection, Data Flow-backed mock dependencies and bounded solver-feedback loop.
- `npm run test:v1-cli-integration`: passed; CLI generated 19 scenarios, 16 with static Data Flow evidence, plus default and custom execution-form paths.
- `node tests/analysis-run-form.mjs`: passed; scenario linking, `not-run` semantics, manual results, coverage merge, path/token redaction, report/fingerprint identity, unknown/duplicate Scenario ID rejection and finalizer CLI.
- End-to-end handoff passed: CLI generated analysis report + companion form; a filled 19-case form (18 passed, 1 failed) merged into a final report with coverage and a matching report ID; absolute stack paths were removed.
- `node tests/module-boundaries.mjs`: passed; 118 auto-discovered modules, no relative cycles or forbidden layer dependencies.
- `node tests/node-compatibility.mjs`: passed; 117 production modules do not use `Array.prototype.at` with the declared Node >=14.17 engine.
- `node tests/docs-structure.mjs`: passed; documentation remains at 7 Markdown files.
- `node tests/golden-baseline.mjs`: passed; all 11 frozen fixtures.
- `node tests/golden-compatibility.mjs`: passed against frozen v0.18 output.
- `node tests/interfile-regressions.mjs`: passed; project-wide import/re-export summaries, points-to unknown/top widening and recursive caller uncertainty.
- `node tests/test-batching.mjs`: passed; stable signatures, grouping, isolation and fallback.

The full `npm test` one-shot run and real Jest integration are not claimed as passed. Jest is not installed in this environment; the synthetic Jest-compatible runner verifies the generated harness but does not replace the real Jest matrix.
