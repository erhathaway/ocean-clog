export function randomId(prefix: string): string {
  // dependency-free; replace with UUID if preferred
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}