import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolveRelayUrl } from "./scripts/relay-url";

const relay = resolveRelayUrl();
// Say it out loud at build time. This is only a first-run seed now; Settings is
// authoritative after launch.
console.log(
  relay.url
    ? `[relay] seeding ${relay.url} (from ${relay.source})`
    : "[relay] no relay URL seed — new installs start local-only",
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
          "transcript-index-worker": resolve("src/main/transcript-index-worker.ts"),
        },
      },
    },
    // Seed the first-run relay preference for local development. A Finder-
    // launched app does not inherit the shell env, so this keeps the old dev
    // workflow working without making the URL a build-time requirement.
    //
    // DEFAULTS TO EMPTY, DELIBERATELY. An unconfigured build is a fully local,
    // single-machine app: the relay bridge no-ops when it has no URL (see
    // `RelayBridge.start`), so nothing is registered, no account exists, and no
    // request leaves the machine for a relay. Phone pairing is opt-in, and the
    // user can point Settings at a deployment they own. Never hardcode a URL
    // here — that would silently aim third-party first runs at whatever
    // deployment is named. Reading the operator's own local env file is the
    // opposite: it resolves to empty everywhere else.
    define: {
      "process.env.PANDA_CODE_RELAY_URL": JSON.stringify(relay.url),
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    // Sandboxed preloads execute plain CommonJS, not Node's ESM loader.
    build: { rollupOptions: { output: { format: "cjs", entryFileNames: "index.cjs" } } },
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
