import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const localRelayEnv = resolve(here, "../../../convex-relay/.env.local");

/**
 * Resolve the relay URL to bake into the bundle.
 *
 * `PANDA_CODE_RELAY_URL` wins. Failing that, we read `CONVEX_URL` out of
 * `convex-relay/.env.local` — the gitignored file `npx convex dev` writes for
 * whoever is running the relay from this checkout. That is the *operator's own*
 * deployment, discovered from their machine; no URL is ever committed, and a
 * checkout without that file (every third-party clone, every CI run) resolves to
 * empty and builds the fully local, single-machine app.
 *
 * This exists because the URL used to come only from the shell env, so any
 * repackage that forgot the prefix produced a build with the relay silently
 * disabled — it looks fine on the desktop and shows up as "Mac offline" on the
 * phone hours later.
 */
export function resolveRelayUrl() {
  const fromEnv = process.env.PANDA_CODE_RELAY_URL?.trim();
  if (fromEnv) return { url: fromEnv, source: "PANDA_CODE_RELAY_URL" };

  try {
    const match = readFileSync(localRelayEnv, "utf8").match(/^CONVEX_URL=(.+)$/m);
    const url = match?.[1]?.trim();
    if (url) return { url, source: "convex-relay/.env.local" };
  } catch {
    // No local relay checkout configured — local-only build.
  }

  return { url: "", source: "unset" };
}
