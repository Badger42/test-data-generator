# Документация проекта

Документация намеренно сведена к нескольким актуальным документам. Исторические release notes не дублируются отдельными файлами: их назначения и результаты собраны в `releases/IMPLEMENTATION_HISTORY.md`.

| Документ | Назначение |
|---|---|
| `architecture/ARCHITECTURE.md` | Архитектурные слои, направление зависимостей, composition root, правила импортов и compatibility boundary. |
| `architecture/SUBSYSTEMS.md` | Назначение подсистем, ключевые модули, публичные DTO и ограничения реализации. |
| `architecture/VALIDATION_STATUS.md` | Фактические результаты проверок текущего release candidate и известные пробелы в тестовом окружении. |
| `architecture/RELEASE_PLAN.md` | Критерии перехода от release candidate к стабильному v1.0.0. |
| `releases/IMPLEMENTATION_HISTORY.md` | Сводка всех прежних `IMPLEMENTED_*.md` и основных versioned implementation reports, сгруппированная по назначению. |
| `schemas/analysis-report.schema.json` | JSON Schema диагностического отчёта генератора. |
| `schemas/analysis-run-form.schema.json` | JSON Schema формы результатов реального запуска тестов. |

`contracts/*.d.ts` — машинно-проверяемые контракты. Исходники и unit/integration tests остаются главным источником фактического поведения; документы описывают архитектуру и поддерживаемые границы, но не заменяют тесты.

## Отчёт для последующего анализа

`--analysis-report` создаёт два файла: `*.analysis-report.json` с результатами статического анализа и `*.analysis-run-form.json` — заполняемую форму реального прогона. После заполнения формы их нужно объединить командой `node tools/finalize-analysis-report.mjs <analysis-report.json> <analysis-run-form.json> [--out final-report.json]`. Финальный `*.final.json` предназначен для передачи в ChatGPT. Форма содержит заранее заполненный список `scenarioId`, чтобы реальные результаты тестов можно было связать с ветвями генератора. Путь по умолчанию можно изменить через `--analysis-report-form-out <file.json>`. Report и form содержат SHA-256 fingerprint всех implementation source files; финализатор дополнительно сверяет его, чтобы не объединить результаты теста с отчётом от другой версии проекта.

- сведения об окружении, TypeScript compiler options, список файлов проекта и разрешённые/неразрешённые import/re-export edges;
- Project Function Index и межфайловый call graph;
- сводки CFG, reaching definitions, scalar/Memory SSA, Points-to, interprocedural summaries, Array Pipeline и loop flow;
- сценарии, целевые ветви, mock actions, evidence, unsupported branches и Constraint Solver fallback;
- Jest test results, `test.each` batching, Istanbul coverage, per-scenario attribution и MC/DC verification, когда включён `--coverage-feedback`;
- секцию `externalExecution` для результатов самостоятельного запуска тестов, если генератор не запускал Jest.

По умолчанию используется `--analysis-report-values shape`: реальные аргументы и mock values заменяются описанием типа/формы. `hash` сохраняет возможность сопоставлять одинаковые значения, не раскрывая их. `include` записывает реальные значения и source expressions — перед передачей такого отчёта обязательно проверьте его на персональные данные, секреты и коммерческую информацию. Абсолютные пути и содержимое исходных файлов в диагностический отчёт не включаются. При ручном заполнении формы не добавляйте секреты и реальные персональные данные; перед передачей финального файла проверьте сообщения об ошибках и notes.

Пример: `node branch-scenarios.mjs src/feature.ts --function calculate --mcdc --coverage-feedback --include-evidence --analysis-report`. Для самостоятельного Jest-прогона заполните в форме `execution`, `testResults.cases`, `coverage`, `artifacts` и `notes`. Каждому кейсу оставьте неизменным `scenarioId`, укажите `passed` / `failed` / `skipped` / `pending` / `not-run`, а затем выполните merge-команду. Финализатор проверяет `reportId`, неизвестные Scenario ID и удаляет абсолютные пути из путей артефактов и stack traces. Желательно приложить соответствующие исходники с удалёнными секретами и точную команду запуска.


### Поля формы реального запуска

- `execution`: runner, точная команда, время начала/окончания, duration и версии Node/Jest/TypeScript/coverage provider.
- `testResults`: итоговые счётчики и построчные результаты, заранее связанные с `scenarioId`, `functionId`, `branchId`, `batchId`. Статусы `not-run` сохраняются отдельно, их нельзя считать успешными.
- `coverage`: provider, показатели statements/branches/functions/lines, uncovered targets и путь к coverage JSON.
- `artifacts`: относительные пути к JUnit XML, Jest JSON, coverage-final.json и логам. Абсолютные пути не переносятся в финальный отчёт.
- `notes` и `issues`: наблюдения, несоответствия, flaky tests, setup/mocking problems и другие факты реального запуска.

Форма может быть заполнена вручную или скриптом CI. Для автоматического объединения используется `tools/finalize-analysis-report.mjs`; он проверяет совпадение `reportId`, принадлежность Scenario ID исходному отчёту и формирует `externalExecution` в финальном диагностическом JSON.
