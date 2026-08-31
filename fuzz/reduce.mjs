/**
 * @param {string} source
 * @param {(candidate: string) => boolean | Promise<boolean>} preservesFailure
 * @param {number} [maximumAttempts]
 */
export async function reduceSource (source, preservesFailure, maximumAttempts = 64) {
  let reduced = source;
  let parts = 2;
  let attempts = 0;

  while (reduced.length > 1 && attempts < maximumAttempts) {
    const partLength = Math.ceil(reduced.length / parts);
    let changed = false;
    for (let index = 0; index < reduced.length && attempts < maximumAttempts; index += partLength) {
      const candidate = reduced.slice(0, index) + reduced.slice(index + partLength);
      attempts++;
      if (await preservesFailure(candidate)) {
        reduced = candidate;
        parts = Math.max(2, parts - 1);
        changed = true;
        break;
      }
    }
    if (changed) {
      continue;
    }
    if (parts >= reduced.length) {
      break;
    }
    parts = Math.min(reduced.length, parts * 2);
  }

  return reduced;
}
