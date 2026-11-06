# Validation status — v1.0.0-rc.8

## Текущее состояние

RC.8 — кандидат на выпуск с усиленной runtime-изоляцией, корректной обработкой исключений, ограничениями времени выполнения, более строгим определением Jest и расширенной CI-матрицей.

Пакет требует Node.js `>=24.0.0`; `.nvmrc` и `.node-version` выбирают Node 26. GitHub Actions проверяет Ubuntu и Windows на Node 24 и 26. Jest генератора закреплён на `30.5.2`; для Coverage Feedback версия Jest целевого проекта должна быть `>=30.5.2 <31.0.0`. Неопределённая версия считается ошибкой совместимости.

**Ограничение происхождения архива:** этот рабочий снимок подготовлен из доступного локального RC.7-архива. Получить побайтно актуальный удалённый `main` не удалось из-за DNS/сетевой недоступности GitHub в среде сборки. Поэтому RC.8 ZIP не следует считать экспортом текущего GitHub `main`; перед применением поверх более новых коммитов нужно сверить изменения.

Локальная среда использует Node.js `22.16.0`, то есть ниже объявленной платформы. Jest 30.5.2 не установлен. Получить Jest и сформировать настоящий `package-lock.json` не удалось: npm registry завершал запросы ошибкой `EAI_AGAIN`, а локальный offline cache не содержал пакет Jest. Поэтому реальная Jest 30 integration и выполнение на Node 24/26/Windows здесь не заявляются как пройденные. Архив не содержит `package-lock.json`; workflow использует `npm ci`, если lockfile присутствует, иначе `npm install`. Воспроизводимость установки остаётся release gate.

## RC.8: выполненные локальные проверки

Следующие наборы успешно выполнены в доступной среде (Node 22.16.0 + TypeScript 5.8.3; TypeScript подключался только для локальных проверок через временный symlink):

- `npm run check:contracts` — TypeScript contracts.
- `npm run test:constraints` — Constraint IR и TypeScript constraint compiler.
- `npm run test:analysis-state` — reducer, function session, traversal и orchestration.
- `npm run test:scenarios` — scenario materialization, undefined serialization и report compatibility.
- `npm run test:mocks` — mock engine и production planner integration.
- `npm run test:interfile` — inter-file summaries, import/re-export, recursion и points-to uncertainty.
- `npm run test:test-batching` — batch signatures, row-level mock variance и `%s` rendering.
- `npm run test:architecture` — contracts, docs, module map, dependency directions и cycle detection.
- `npm run test:mcdc` — decision extraction, independence pairs, callbacks и advanced callback/index MC/DC.
- `npm run test:arrays` — callback, array chains, sorting/flat/last methods и array dataflow.
- `npm run test:reporting` — report schema, redaction, execution form и validation.
- `npm run test:execution-coverage` — Jest runner, source-map remapping, feedback, iterative coverage, branch mapping и minimal suite через fake runner.
- `npm run test:v1-integrations` и `npm run test:v1-cli-integration`.
- Дополнительно: `tests/coverage-feedback-timeouts.mjs`, `tests/runtime-callback-async.mjs`, `tests/test-runner-config.mjs`, `tests/node-compatibility.mjs`, `tests/cli-modules.mjs`, `tests/docs-structure.mjs`, `tests/module-boundaries.mjs`, `tests/expected-exception-coverage.mjs`.

Архитектурная проверка обнаружила 119 source modules: циклов и запрещённых межслойных зависимостей не обнаружено. Во время проверки были найдены и исправлены регрессии в result reader и MODULE_MAP.

**Не пройдено/не подтверждено:** полный агрегированный `npm test` превысил 300-секундный лимит среды; Jest-зависимые `jest-dependency` и `real-jest.integration` не запускались из-за отсутствия установленного Jest 30.5.2; Node 24/26 и Windows не запускались локально. В CI обязательны `npm run check:contracts`, `npm run test:node-compatibility` и полный `npm test`.

## RC.8: дополнительные исправления надёжности

- Runtime callback и decision frames используют `AsyncLocalStorage`, чтобы `await` и параллельные callbacks не делили MC/DC frames; поздние события завершённого сценария не приписываются следующему.
- Harness различает thrown value и truthiness: `throw null`, `throw undefined`, `throw false` и `throw 0` не считаются отсутствием исключения. Примитивные ожидаемые исключения сравниваются по типу/значению; неизвестные выражения отклоняются fail-closed.
- `clearAllMocks()` очищает историю вызовов и сохраняет реализации моков из setup-файлов. Result reader сохраняет счётчик очистки из fake runner.
- Jest version discovery следует по symlink и Windows `.cmd`/`.bat`; неизвестная версия не считается совместимой.
- Один запуск Jest ограничен `--jest-timeout` (120000 ms по умолчанию), суммарное время итераций — `--coverage-feedback-timeout` (600000 ms по умолчанию). Таймаут отражается как `execution-timeout`; на Windows дополнительно завершается дерево процесса Jest через `taskkill /t /f`. Временные файлы удаляются на ошибках сборки harness, instrumentation, result/report processing и timeout.
- Test runner проверяет положительные целые `TEST_CONCURRENCY`/`TEST_FILE_TIMEOUT_MS`, ограничивает время и объём captured output, отказывается выполнять пустой suite и завершает дерево процессов при timeout на Windows.
- Интеграционный набор расширен CJS+Babel+setup-mock, TypeScript transform и falsy-throw кейсами. Эти проверки требуют реального Jest и остаются ожидающими CI.
- GitHub Actions проверяет Ubuntu/Windows × Node 24/26; использует `npm ci`, когда package lock присутствует.
- MODULE_MAP включает общий модуль конфигурации тестового runner; docs и version references синхронизированы с RC.8.

## Оставшиеся release gates

1. Получить и закоммитить настоящий `package-lock.json`; проверить `npm ci` на Node 24/26.
2. Запустить настоящий Jest 30.5.2 integration на Node 24 и 26: ESM/V8, CJS/Babel, setup mocks, TypeScript transform, `test.each`, expected primitive throws и minimal suite.
3. Получить зелёный GitHub Actions matrix на Ubuntu и Windows.
4. Выполнить `npm audit` на lockfile и закрыть high/critical advisories либо зафиксировать обоснованные исключения.
5. Проверить ESM/CJS edge cases и Jest launchers на реальной Windows-среде.
6. Benchmark на небольших, средних и крупных проектах; установить CPU/memory budgets и проверить cancellation при реальных зависающих тестах.
7. Проверить Solver на более широком наборе unsupported operations и убедиться, что conservative statuses сохраняются во всех итоговых отчётах.

## Историческое состояние RC.7

RC.7 поднял платформу до Node.js `>=24.0.0`, закрепил Jest `30.5.2` и TypeScript `5.8.3`, исправил batching, fake runner, runtime exception handling, V8/Istanbul remapping, destructured/unsupported inputs, syntax diagnostics и CLI validation. Эти изменения являются базой RC.8, но не подменяют проверки RC.8 выше.

Предыдущие release candidates проверяли межфайловый FunctionIndex, import/re-export summaries, points-to unknown/top propagation, recursive summary widening, CFG/SSA, Constraint IR/Solver, callback/array/MC/DC engines и reporting. Результаты этих прогонов относятся к своим исходным версиям.
