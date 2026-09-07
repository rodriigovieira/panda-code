/**
 * Resolve the relay URL to seed into the first-run preference.
 *
 * Empty by default, deliberately: a checkout with `convex-relay/.env.local`
 * should not accidentally bake that deployment into a downloadable app. Users
 * can configure a relay later from Settings without rebuilding. Developers who
 * want a first-run default can set this env var explicitly.
 */
export function resolveRelayUrl() {
  const fromEnv = process.env.PANDA_CODE_RELAY_URL?.trim();
  if (fromEnv) return { url: fromEnv, source: "PANDA_CODE_RELAY_URL" };

  return { url: "", source: "unset" };
}
