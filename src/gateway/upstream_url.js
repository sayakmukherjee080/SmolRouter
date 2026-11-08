// Joins a provider base URL with an OpenAI sub-path without duplicating segments.
export function buildUpstreamUrl(baseUrl, subPath) {
  const base = baseUrl.replace(/\/+$/, '');
  const clean = subPath.replace(/^\/+/, '');
  return base.includes(clean) ? base : `${base}/${clean}`;
}
