/** @typedef {{ region: 'NL' | 'BE' | 'DE' }} IterativeCoverageInput */

/** @param {IterativeCoverageInput} input */
export function iterativeCoverageTarget(input) {
  if (input.region === 'NL') {
    return 'home';
  }
  return input.region;
}
