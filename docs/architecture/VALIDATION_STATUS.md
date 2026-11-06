# Validation status — v1.0.0-rc.8

## Текущее состояние

RC.8 — кандидат на выпуск. Пакет требует Node.js `>=24.0.0`; `.nvmrc` и `.node-version` выбирают Node 26. Jest генератора закреплён на `30.5.2`, TypeScript — на `5.8.3`. Для Coverage Feedback версия Jest целевого проекта должна быть `>=30.5.2 <31.0.0`; неопределённая версия считается ошибкой совместимости.

В репозитории присутствует `package-lock.json`. GitHub Actions устанавливает зависимости через `npm ci` и проверяет матрицу Ubuntu/Windows × Node 24/26. Workflow запускает проверку TypeScript contracts, Node compatibility и полный `npm test`.

## Последняя проверенная матрица

**2026-11-06, commit `a20c15e150d6ef5cb218c4e5d8b67bac6d94d01c`:**

- Ubuntu / Node 24 — success.
- Ubuntu / Node 26 — success.
- Windows / Node 24 — success.
- Windows / Node 26 — success.

Полный `npm test` завершился успешно во всех четырёх конфигурациях. В него входят реальные Jest 30 integration tests, CJS/Babel, setup mocks, TypeScript transform, batching, expected primitive throws, coverage feedback, MC/DC и минимизация набора.

CI run: https://github.com/Badger42/test-data-generator/actions/runs/42204791961

Результат относится к указанному commit. Изменения после него требуют нового полного CI-прогона; локальный запуск на другой версии Node или отдельный unit test не заменяет эту матрицу.

## Дополнительные release gates

1. Выполнить `npm audit` по lockfile и закрыть high/critical advisories либо зафиксировать обоснованные исключения.
2. Провести benchmark на небольших, средних и крупных проектах; определить CPU/memory budgets.
3. Проверить cancellation и завершение процессов на реальных зависающих Jest-тестах.
4. Расширить Solver validation на unsupported operations и проверить сохранение conservative statuses в итоговых отчётах.
5. Зафиксировать эксплуатационные ограничения для callback MC/DC и V8 coverage provider в пользовательской документации.

## Исторические примечания

Предыдущие release candidates проверяли межфайловый FunctionIndex, import/re-export summaries, points-to unknown/top propagation, recursive summary widening, CFG/SSA, Constraint IR/Solver, callback/array/MC/DC engines и reporting. Результаты старых прогонов относятся к своим исходным commit и не заменяют указанную выше CI-матрицу RC.8.
