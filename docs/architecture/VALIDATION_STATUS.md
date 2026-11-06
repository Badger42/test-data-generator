# Validation status — v1.0.0-rc.7

## Текущий результат

RC.7 содержит обновление платформы и исправления из тестового аудита. Пакет объявляет Node.js `>=24.0.0`; CI workflow проверяет Node 24 и 26. Jest генератора закреплён на `30.5.2`, а Coverage Feedback проверяет версию локального Jest целевого проекта (поддерживается `>=30.5.2 <31.0.0`, когда версия установки может быть определена).

Локальная среда сборки на момент подготовки архива работает под Node `22.16.0`, то есть ниже объявленной платформы. TypeScript доступен как глобальная установка `5.8.3`; Jest не установлен. Получить Jest и сформировать `package-lock.json` не удалось: обращения npm к `registry.npmjs.org` завершались `EAI_AGAIN`. Поэтому настоящая Jest 30 integration и проверка Node 24/26 в этой среде не заявляются как пройденные. CI использует `npm install` до появления lockfile; commit lockfile остаётся pre-stable release gate.

## RC.7: выполненные регрессионные проверки

Успешно выполнены отдельные проверки:

- `tests/coverage-feedback.mjs`: fake-runner flow, callback MC/DC и явный отказ для Jest 26.6.0.
- `tests/expected-exception-coverage.mjs`: ожидаемый `RangeError` считается passing runtime outcome, соседние сценарии не теряются.
- `tests/execution-coverage-modules.mjs`: сборка execution cases, дублирующиеся отображаемые заголовки, ожидаемые исключения и remapping branch/statement/function Istanbul locations.
- `tests/test-batching.mjs`: Jest `test.each` с позиционными строками, `%s` и уникальными Scenario ID.
- `tests/input-validation-and-solver-regressions.mjs`: syntax errors, обязательные значения CLI, отсутствие автоматического создания `--out` директорий, destructured parameters, modulo witness `n=15` и неподдерживаемый `typeof`.
- Дополнительно успешно выполнены: `analysis-operation-context`, `analysis-report`, `analysis-run-form`, `analysis-state-reducer`, array callback/data-flow/method tests, CLI modules, Constraint IR migration/extended operands, constraint orchestration, control-flow/array, coverage branch mapping, iterative coverage, data-flow engine, docs structure и execution/coverage modules.

Из 55 обнаруживаемых тестовых модулей 53, не требующих установленного Jest, прошли при отдельных/параллельных прогонах; в эту группу входят Constraint IR migration/extended operands, callback MC/DC, minimal suite, multi-witness, session isolation, CLI и межфайловые регрессии. Два Jest-зависимых модуля (`jest-dependency` и `real-jest.integration`) не подтверждены локально: в среде нет Jest 30 и используется Node 22. Полный агрегированный `npm test` также не завершился в 300-секундном лимите контейнерной сессии, поэтому итоговый CI-прогон остаётся обязательным. После установки зависимостей выполнить `npm run check:contracts`, `npm run test:jest-dependency`, `npm run test:real-jest` и `npm test` на Node 24/26.

## RC.7: изменения

- `package.json`: версия `1.0.0-rc.7`, `engines.node >=24.0.0`, точные версии TypeScript `5.8.3` и Jest `30.5.2`.
- `.nvmrc` и `.node-version` выбирают Node 26; добавлен GitHub Actions matrix Node 24/26.
- Harness: исключён конфликт объявления `jest`; `test.each` использует `[title, scenario]` + `%s`; Scenario ID встроен в уникальный заголовок.
- Fake runner внедряет shim только при загрузке сгенерированного test file; `NODE_PATH` и глобальная module path mutation удалены.
- Result reader сопоставляет runtime outcomes по уникальному Scenario ID и потребляет каждое assertion ровно один раз.
- Runtime exceptions можно объявить ожидаемыми; такие outcomes проходят без потери остальных кейсов.
- V8/Istanbul remapper переводит branchMap, statementMap и fnMap из generated coordinates в original coordinates; line counters пересобираются из remapped statements.
- Destructured parameters и solver-unsupported candidates не приводят к выдаче фиктивных входных данных; ограничения видны в отчёте.
- Parse diagnostics блокируют генерацию при синтаксической ошибке; CLI проверяет отсутствующие значения и не создаёт несуществующие output directories молча.
- Устранено двойное добавление `jest-` в stop reason; `normalizeCollectionPath` теперь вызывается с корректно экранированными regex в template-generated harness.
- Общий test runner запускает обнаруженные `.mjs` тесты с ограниченной параллельностью вместо одной длинной цепочки `&&`.

## Оставшиеся release gates

- Сгенерировать и закоммитить `package-lock.json`, после чего вернуть `npm ci` в CI.
- Прогнать настоящий Jest `30.5.2` integration на Node 24 и 26; проверить consuming-project ESM/CJS и V8/Babel providers.
- Проверить Windows в полном CI; текущая workflow matrix пока Ubuntu-only.
- Выполнить `npm audit` на lockfile и закрыть все high/critical advisories либо зафиксировать обоснованные исключения.
- Benchmark на реальных малых/средних/крупных проектах и доказать поведение Solver на дополнительном наборе неподдерживаемых операций.

## Историческая валидация RC.4–RC.6

Предыдущие release candidates успешно проверяли межфайловый FunctionIndex, import/re-export summaries, points-to unknown/top propagation, recursive SCC uncertainty, CFG/SSA, Constraint IR/Solver, callback/array/MC/DC engines, reporting и golden compatibility. Эти результаты относятся к указанным историческим версиям и не являются подтверждением RC.7 на Node 24/26.

RC.5 добавил shareable analysis report и fillable execution form с проверкой `reportId`/Scenario ID. RC.6 закрепил Jest `26.6.0` как devDependency и сделал real-Jest integration обязательным. В RC.7 эта зависимость заменена на Jest `30.5.2`; `jest-unit` не добавлен.
