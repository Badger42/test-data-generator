/**
 * @param {{ age: number, enabled: boolean, role: 'admin' | 'owner' | 'user', items: { score: number }[], people: { age: number }[] }} input
 */
export function classify(input) {
  if (input.age < 18 || input.age > 65) return 'age-outlier';
  if (input.enabled && (input.role === 'admin' || input.role === 'owner')) return 'privileged';

  for (const item of input.items) {
    if (item.score < 0 || item.score > 100) return 'invalid-score';
  }

  if (input.people.some(person => person.age < 18 || person.age > 65)) return 'group-age-outlier';
  return 'ordinary';
}
