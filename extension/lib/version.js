// True when `version` ("0.2.0") is at least `minimum`; unknown or unparsable versions are never enough.
export function versionAtLeast(version, minimum) {
  const parse = (text) => (/^\d+(\.\d+)*$/.test(String(text)) ? String(text).split(".").map(Number) : null);
  const have = parse(version);
  const need = parse(minimum);
  if (!have || !need) return false;
  for (let i = 0; i < Math.max(have.length, need.length); i += 1) {
    const diff = (have[i] ?? 0) - (need[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return true;
}
