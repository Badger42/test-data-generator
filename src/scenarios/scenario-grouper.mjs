import { createHash } from 'node:crypto';
import { createScenarioFingerprint } from './scenario-fingerprint.mjs';

/** Groups exact duplicate runtime payloads while retaining their individual branch targets. */
export function groupEquivalentScenarios(scenarios = []) {
  if (!Array.isArray(scenarios)) throw new TypeError('Scenario grouping expects an array.');
  const groups = new Map();
  for (const scenario of scenarios) {
    if (!scenario || !Array.isArray(scenario.arguments)) continue;
    const mocks = scenario.mocks ?? [];
    const fingerprint = createScenarioFingerprint({ arguments: scenario.arguments, mocks });
    let group = groups.get(fingerprint);
    if (!group) {
      group = { fingerprint, arguments: scenario.arguments, mocks, scenarioIds: [], targets: [] };
      groups.set(fingerprint, group);
    }
    if (scenario.id && !group.scenarioIds.includes(scenario.id)) group.scenarioIds.push(scenario.id);
    if (scenario.target) group.targets.push({
      scenarioId: scenario.id ?? null,
      branchId: scenario.target.branchId ?? null,
      outcome: scenario.target.outcome ?? null,
      kind: scenario.target.kind ?? null,
    });
  }
  return [...groups.values()].filter(group => group.scenarioIds.length > 1).map(group => {
    const fingerprint = createHash('sha256').update(group.fingerprint).digest('hex').slice(0, 16);
    return Object.freeze({
      id: `scenario-group-${fingerprint}`,
      fingerprint,
      size: group.scenarioIds.length,
      arguments: group.arguments,
      mocks: group.mocks,
      scenarioIds: Object.freeze([...group.scenarioIds]),
      targets: Object.freeze(group.targets),
    });
  });
}
