export interface InputModel {
  base: number;
  discount?: number;
  user: { score: number };
  items: number[];
}

export function analyzeInput(input: InputModel, useDiscount: boolean): boolean {
  let total = input.base;
  if (useDiscount) {
    total = input.base - (input.discount ?? 0);
  } else {
    total = input.base + 10;
  }

  const userAlias = input.user;
  userAlias.score = total;
  input.items.push(total);

  const calculate = (factor: number) => total * factor;
  const incrementUser = () => {
    userAlias.score += 1;
    return userAlias.score;
  };
  const calculated = calculate(input.base);
  return calculated > 20;
}

export function mutateLoop(input: InputModel): number {
  let total = 0;
  for (let index = 0; index < input.items.length; index += 1) {
    total += input.items[index];
  }
  return total;
}

export function interproceduralCalls(input: { value: number }): number {
  const bump = (target: { value: number }) => {
    target.value += 1;
    return target.value;
  };
  const invoke = (target: { value: number }) => bump(target);
  return invoke(input);
}

export function recursiveLocalCall(input: number): number {
  const descend = (value: number): number => value > 0 ? descend(value - 1) : 0;
  return descend(input);
}

export function reduceAccumulator(input: { values: number[] }): number {
  return input.values.reduce((accumulator, item, index) => {
    const next = accumulator + item;
    return index >= 0 ? next : accumulator;
  }, 0);
}

export function controlFlowTransfers(input: InputModel, enabled: boolean): number {
  let total = 0;
  if (enabled) total = input.base;
  else total = 1;
  for (let index = 0; index < input.items.length; index += 1) {
    if (input.items[index] < 0) continue;
    if (input.items[index] > 100) break;
    total += input.items[index];
  }
  switch (total) {
    case 0:
      total = 1;
    case 1:
      total += 2;
      break;
    default:
      total += 3;
  }
  return total;
}

export function doWhileControlFlow(input: { count: number }): number {
  let count = 0;
  do {
    count += 1;
  } while (count < input.count);
  return count;
}


export function ambiguousLocalHelpers(input: { value: number }, enabled: boolean): number {
  if (enabled) {
    const touch = (target: { value: number }) => { target.value += 1; };
    touch(input);
  } else {
    const touch = (target: { value: number }) => { target.value -= 1; };
    touch(input);
  }
  return input.value;
}

export function returnSubstitution(input: { left: { value: number }; right: { value: number } }): number {
  const readValue = (target: { value: number }) => target.value;
  const first = readValue(input.left);
  const second = readValue(input.right);
  return first + second;
}

export function pureHelperConstraint(input: { value: number }): boolean {
  const readValue = (target: { value: number }) => target.value;
  const currentValue = readValue(input);
  if (currentValue > 3) return true;
  return false;
}


export function shortCircuitControlFlow(input: { enabled: boolean; value: number; fallback: boolean }, choosePrimary: boolean): boolean {
  if (input.enabled && (choosePrimary ? input.value > 0 : input.fallback || input.value > 10)) {
    return input.value < 50;
  }
  return false;
}


export function computedHelperConstraint(input: { value: number }): boolean {
  const addOffset = (target: { value: number }) => target.value + 5;
  const computed = addOffset(input);
  return computed > 10;
}


export function conditionEvaluationFlow(input: { value: number }): boolean {
  let enabled = false;
  if ((enabled = input.value > 0) && enabled) return true;
  return enabled;
}


export function constantReturnHelper(input: { value: number }): boolean {
  const alwaysEnabled = () => true;
  const enabled = alwaysEnabled();
  return enabled && input.value > 0;
}

export function ssaVersionedBranch(input: { left: number; right: number }, enabled: boolean): number {
  let selected = 0;
  if (enabled) selected = input.left;
  else selected = input.right;
  return selected;
}

export function ssaVersionedLoop(limit: number): number {
  let total = 0;
  for (let index = 0; index < limit; index += 1) total += index;
  return total;
}

export function heapVersionedBranch(input: { user: { score: number } }, enabled: boolean): number {
  if (enabled) input.user.score = 10;
  else input.user.score = 20;
  return input.user.score;
}

export function heapVersionedAlias(input: { user: { score: number } }): number {
  const userAlias = input.user;
  userAlias.score = 30;
  return input.user.score;
}

export function heapVersionedDynamicIndex(input: { values: number[] }, index: number): number {
  input.values[index] = 40;
  return input.values[0];
}

export function heapVersionedMayAlias(input: { user: { score: number }; other: { score: number } }): number {
  let userAlias = input.user;
  userAlias = input.other;
  userAlias.score = 50;
  return input.user.score;
}

export function heapVersionedTemporalAlias(input: { user: { score: number }; other: { score: number } }): number {
  let userAlias = input.user;
  userAlias.score = 60;
  userAlias = input.other;
  userAlias.score = 70;
  return input.user.score + input.other.score;
}

export function ssaDerivedConstraint(input: { value: number }, enabled: boolean): boolean {
  let current: number;
  if (enabled) current = input.value;
  else current = input.value;
  if (current > 3) return true;
  return false;
}

export function pointsToAliasing(input: { enabled: boolean }): number {
  const first = { value: 0 };
  let second = input.enabled ? first : { value: 1 };
  second.value = 2;
  return first.value;
}

export function contextSensitiveEffects(input: { left: { value: number }; right: { value: number } }): number {
  const mutate = (target: { value: number }) => { target.value += 1; };
  const invoke = (target: { value: number }) => mutate(target);
  invoke(input.left);
  invoke(input.right);
  return input.left.value + input.right.value;
}

export function ssaAmbiguousConstraint(input: { left: number; right: number }, enabled: boolean): boolean {
  let current: number;
  if (enabled) current = input.left;
  else current = input.right;
  return current > 3;
}

export function pointsToFieldLoad(): number {
  const child = { value: 1 };
  const holder = { child };
  const loaded = holder.child;
  loaded.value = 4;
  return child.value;
}

export function pointsToExternalAlias(left: { value: number }, right: { value: number }): number {
  left.value += 1;
  return right.value;
}
