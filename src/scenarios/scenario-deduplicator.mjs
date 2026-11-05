import { createScenarioFingerprint } from './scenario-fingerprint.mjs';

/** Per-target deduplication over arguments + mocks, never arguments alone. */
export function createScenarioDeduplicator(options = {}) {
  const seen = options.seen ?? new Set();
  function claim(payload) {
    const fingerprint = createScenarioFingerprint(payload);
    if (seen.has(fingerprint)) return { duplicate: true, fingerprint };
    seen.add(fingerprint);
    return { duplicate: false, fingerprint };
  }
  return Object.freeze({ claim, has: fingerprint => seen.has(fingerprint), size: () => seen.size, fingerprints: () => [...seen] });
}
