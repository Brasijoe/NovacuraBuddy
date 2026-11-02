function normalizedIncludes(haystack, needle) {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}
function namePlausiblyMatches(origin, name) {
  if (!name) return false;
  return normalizedIncludes(name, origin) || normalizedIncludes(origin, name);
}
function baseUrlPlausiblyMatches(origin, baseUrl) {
  if (!baseUrl) return false;
  return normalizedIncludes(baseUrl, origin);
}
function matchInstanceByEnvironmentOrigin(environmentOrigin, instances) {
  const origin = environmentOrigin?.trim();
  if (!origin) return { kind: "none" };
  const candidates = instances.filter(
    (instance) => namePlausiblyMatches(origin, instance.name) || baseUrlPlausiblyMatches(origin, instance.baseUrl)
  );
  if (candidates.length === 0) return { kind: "none" };
  if (candidates.length === 1) return { kind: "matched", instance: candidates[0] };
  return { kind: "ambiguous", candidates };
}
export {
  matchInstanceByEnvironmentOrigin
};
