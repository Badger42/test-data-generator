# История реализации и назначение release-документов

Этот документ заменяет все разрозненные `IMPLEMENTED_*.md` и version-specific implementation notes. История сгруппирована по назначению подсистем, чтобы не приходилось читать десятки почти одинаковых отчётов. Текущие границы и ограничения описаны в `docs/architecture/`; здесь остаётся сводка того, что принесла каждая серия релизов.

## 1. Основа проекта и CLI — v0.19

Сформированы characterization/golden baseline, стабильная CLI-точка входа, application shell, загрузка TypeScript проекта, function discovery и source spans. Зафиксированы публичные CLI flags, exit codes, default output и JSON совместимость. Это основа, на которой выполнялись последующие extraction этапы.

## 2. Constraint IR и Solver — v0.20–v0.26

- Создан parser-independent `ConstraintExpr` / Constraint IR и отдельный bounded Solver.
- Добавлены логические выражения, negation, сравнения, numeric ranges, `.length` constraints и объединение path domains.
- Реализованы short-circuit/multi-witness решения и preservation incoming assignments.
- Constraint Compiler отделён от solver backend; TypeScript AST остаётся на compiler adapter границе.
- Введён IR-first/hybrid routing и видимая диагностика fallback. Неподдержанное или неполное IR решение не объявляется unsatisfiable.
- Добавлены arithmetic Expression IR и локальные Data Flow facts для условий и mock results.

## 3. Function Analysis и Data Flow foundation — v0.27–v0.30

- Выделены AstFacade и FunctionAnalysisSession со стабильной function identity и session-owned state.
- Добавлены Data Flow Analyzer, local aliases, SSA/phi foundation, mutation/escape facts и function summaries.
- Выделены Control Flow и Loop Analyzer, затем Array Callback Engine с pipeline composition и bounded Reduce interpreter.
- AST traversal и per-function orchestration постепенно отделены от центрального runtime composition.

## 4. Генерация сценариев, моки и MC/DC — v0.31–v0.33

- Созданы domain `ScenarioCase`, assignment materialization, fingerprint/deduplication и evidence builder.
- Mock Engine разделён на dependency discovery, template builder, state planner и Jest adapter; поведение моков представлено явным `MockPlan`.
- MC/DC разделён на decision extraction, atomic conditions, unique-cause pair planning/feasibility, scenario materialization, source instrumentation, runtime recorder и verifier.
- Статический candidate и runtime-verified MC/DC разведены семантически.

## 5. Исполнение, покрытие и минимизация — v0.34–v0.38

- Вынесены Jest runner/harness, coverage case collection, result/trace readers.
- Созданы Istanbul reader, source-map normalizer, branch mapper и per-scenario attribution.
- Добавлены iterative coverage feedback, candidate expansion, coverage obligations и exact/greedy test suite minimization.
- Введены чистый analysis-state reducer/store и lifecycle-scoped `FunctionAnalysisSession`.
- Выделены expression traversal, function analysis orchestration, immutable named `AnalysisOperationContext`, IR-first `ConstraintAnalysisService`, recursive AST fallback и MC/DC orchestration.

## 6. Type/Path/Inference и углубление Data Flow — v0.39–v0.70

- Вынесены `PathResolver`, `TypeModelProvider`, usage-based `PropertyInference` и `FunctionContextBuilder`.
- CFG обогащён expression-level short-circuit nodes, dominators/post-dominators, control dependence и natural loops.
- Реализованы reaching definitions/liveness, pruned Cytron scalar SSA, dominator-tree version renaming и versioned def-use.
- Выделены field-sensitive Heap/Memory SSA, allocation-site points-to, must/may alias и weak memory updates.
- Добавлены local context-sensitive function summaries, transitive effects, array-stage/index provenance и reduce/loop flow summaries.
- SSA-aware aliases стали доступны Constraint Compiler; простые доказуемые helper-return paths могут быть использованы как символические aliases, неоднозначные результаты остаются unknown.

## 7. End-to-end generation и release candidate — v1.0.0-rc.1–rc.3

### rc.1 — evidence и report contracts

Data Flow evidence доведено до ScenarioCase/MockPlan, добавлены bounded path-sensitive loop planning и Solver feedback, самостоятельный ReportBuilder и публичная JSON schema. Default report остался совместимым; расширенные evidence включаются opt-in.

### rc.2 — batching и Legacy boundary

Добавлен Test Batching Engine: Execution Signature, contiguous compatible batching, `test.each` renderer, row-level identity/isolation и fallback на individual tests. Batching включён в Coverage Feedback. Старый `src/legacy` analyzer path заменён compatibility entrypoint, TypeScript runtime и Array Pipeline runtime разделены лучше.

### v1.0.0-rc.3 — межмодульные зависимости и report projection

- Application Use Cases получают TypeScript runtime через injected ports; runtime implementation не импортируется из application.
- Общая Array method policy перенесена в domain; inference не зависит от analysis implementation.
- `AnalysisOperationContext` состоит из именованных ports, общего `compatibility.context` нет.
- `ScenarioBuilder`/`MockPlanner`/Jest mock adapter не формируют публичный JSON; dedicated report adapters находятся в `src/reporting/`.
- Старые имена runtime/fallback adapters заменены нейтральными (`function-analyzer-adapter`, `recursive-ast-fallback`).
- Module boundary test автоматически обнаруживает все source modules и проверяет imports, layering, cycles и актуальность Module Map.

### v1.0.0-rc.4 — исправления межфайлового анализа и soundness

- Добавлен project-wide FunctionIndex с разрешением import aliases/re-exports, module-qualified symbol IDs и корректными source spans импортированных функций.
- Project-local helpers и pure intrinsics исключены из автоматического mock discovery; внешние package functions, contract-only ports и global runtime seams остаются mockable. Явные пользовательские mock overrides имеют приоритет.
- Points-to analysis расширен явным unknown/top для переменных и heap fields; исключены ложные `must-alias` после неизвестных reassignment/store, Memory SSA учитывает неопределённость полей.
- Recursive SCC uncertainty распространяется на вызывающие summaries до определения purity и доступности Constraint aliases.
- Jest harness безусловно сбрасывает mocks перед каждой строкой `test.each`; behavior-only override сохраняет Solver-generated value.
- Устранён `Array.prototype.at` из production Node modules при сохранении `engines.node >=14.17`; добавлены adversarial межфайловые regression fixtures.

## 8. Как читать прежние IMPLEMENTED-файлы

Все перечисленные ниже файлы были сведены в разделы 1–7 выше. Их отдельные копии удалены, чтобы не поддерживать несколько противоречивых статусов и повторяющиеся validation lists.

### Архив исходных имён

| Диапазон / файл | Назначение исторического отчёта |
|---|---|
| `IMPLEMENTED_0.19.0.md` | Baseline, CLI/application shell, project/AST extraction. |
| `IMPLEMENTED_0.20.0.md`–`IMPLEMENTED_0.26.0.md` | Constraint IR, Solver capabilities, IR-first migration, Expression IR и Data Flow facts. |
| `IMPLEMENTED_0.27.0.md`–`IMPLEMENTED_0.30.0.md` | Analysis Session, Data Flow foundation, Control Flow/Loops, Array Callback Engine. |
| `IMPLEMENTED_0.31.0.md`–`IMPLEMENTED_0.33.0.md` | Scenario Engine, Mock Engine, MC/DC Engine. |
| `IMPLEMENTED_0.34.0.md`–`IMPLEMENTED_0.38.0.md` | Execution/Coverage, feedback/minimization, analysis state, traversal and orchestration extraction. |
| `IMPLEMENTED_0.39.0.md` (root/archive copy) | Type/Path/Inference extraction. |
| `IMPLEMENTED_0.40.0.md` | CFG and Data Flow integration. |
| `IMPLEMENTED_0.50.0.md` (root/archive copy) | CFG-driven Data Flow semantics, graph analysis and use bindings. |
| `IMPLEMENTED_0.60.0.md` (root/archive copy) | Cytron scalar SSA and field-sensitive Heap/Memory SSA. |
| `IMPLEMENTED_0.70.0.md` (root/archive copy) | Points-to, local context-sensitive summaries, array provenance and Solver aliases. |
| `IMPLEMENTED_1.0.0-rc.1.md` | End-to-end Data Flow evidence, loop planning and reporting contracts. |
| `IMPLEMENTED_1.0.0-rc.2.md` | Test Batching Engine and Legacy-boundary extraction. |
| `IMPLEMENTED_1.0.0-rc.3` | Architecture cleanup, automatic module-boundary checks and Markdown consolidation. |
| `IMPLEMENTED_1.0.0-rc.4` | Interfile audit fixes: Function Index, points-to unknown/top, recursive summary propagation and Jest row isolation. |

### Дубли исходных отчётов

Некоторые версии имели две копии — в корне и в `docs/architecture/` (например, `0.39.0`, `0.50.0`, `0.60.0`). Они не рассматривались как разные реализации; содержание объединено по версии и назначению.

## 9. Принцип поддержания истории

Для новых релизов не создавать новый `IMPLEMENTED_<version>.md`. Краткий release summary добавляется в соответствующий раздел этого файла, а актуальное состояние проверок обновляется только в `docs/architecture/VALIDATION_STATUS.md`. Текущие ограничения и release gates хранятся только в `RELEASE_PLAN.md`.


### v1.0.0-rc.5 — reusable real-run report handoff

Added a companion execution-results form linked to the analysis report by `reportId`. It pre-populates generated Scenario IDs, records actual Jest statuses/duration/failures, runner and environment versions, coverage metrics and artifact paths, and distinguishes `not-run` from passed cases. A finalizer validates the form and merges it into a shareable `*.final.json`. Privacy controls omit absolute artifact paths and redact path/token patterns from manually entered failure details. The purpose is to let maintainers attach the exact static analysis and corresponding observed runtime evidence in one final report.


### v1.0.0-rc.6 — Jest 26.6.0 dependency

Pinned Jest 26.6.0 as a development dependency, added an exact-version dependency check, and changed real-Jest integration from a silent skip to a required check. The runner still resolves the consuming project's Jest first; `JEST_BIN` supports explicit selection. No jest-unit dependency is added.
