import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolveRelayUrl } from "./scripts/relay-url";

const relay = resolveRelayUrl();
// Say it out loud at build time. A relay-less bundle is a legitimate build, but
// it is indistinguishable from a configured one until the phone says "Mac
// offline" — so never let it pass silently.
console.log(
  relay.url
    ? `[relay] baking in ${relay.url} (from ${relay.source})`
    : "[relay] no relay URL — building local-only (set PANDA_CODE_RELAY_URL to pair a phone)",
);

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // A second entry, not a second app: `peers-entry` is the workspace-
        // awareness helper the main process spawns per session (as an MCP
        // server for Claude, as `panda-peers` for everything else). It ships in
        // the same bundle so it is always present next to index.js, and it runs
        // under ELECTRON_RUN_AS_NODE — it must never import electron.
        input: {
          index: resolve("src/main/index.ts"),
          "peers-entry": resolve("src/main/peers-entry.ts"),
        },
      },
    },
    // Bake the relay URL into the packaged bundle: a Finder-launched app does not
    // inherit the shell env, so process.env.PANDA_CODE_RELAY_URL would be empty.
    // Set PANDA_CODE_RELAY_URL before building, or run the relay from this
    // checkout and let `resolveRelayUrl` read your own gitignored
    // convex-relay/.env.local.
    //
    // DEFAULTS TO EMPTY, DELIBERATELY. An unconfigured build is a fully local,
    // single-machine app: the relay bridge no-ops when it has no URL (see
    // `RelayBridge.start`), so nothing is registered, no account exists, and no
    // request leaves the machine for a relay. Phone pairing is opt-in, and
    // opting in means pointing at a deployment YOU own. Never hardcode a URL
    // here — that would silently aim every third-party build, CI run and
    // `pnpm dev` at whatever deployment is named. Reading the operator's own
    // local env file is the opposite: it resolves to empty everywhere else.
    define: {
      "process.env.PANDA_CODE_RELAY_URL": JSON.stringify(relay.url),
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    resolve: {
      alias: {
        "@renderer": resolve("src/renderer/src"),
      },
    },
    plugins: [react()],
  },
});
