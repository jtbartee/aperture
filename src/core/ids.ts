let counter = 0;
/** Short unique ids for UI-created objects (generators use deterministic ids instead). */
export function uid(prefix = 'id'): string {
  counter = (counter + 1) % 1e6;
  const rand = typeof crypto !== 'undefined' && 'getRandomValues' in crypto
    ? crypto.getRandomValues(new Uint32Array(1))[0].toString(36)
    : Math.floor(Math.random() * 1e9).toString(36);
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${rand}`;
}
