import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    // Bake the relay URL into the packaged bundle: a Finder-launched app does not
    // inherit the shell env, so process.env.PANDA_CODE_RELAY_URL would be empty.
    // Set PANDA_CODE_RELAY_URL before building to bake in a relay.
    //
    // DEFAULTS TO EMPTY, DELIBERATELY. An unconfigured build is a fully local,
    // single-machine app: the relay bridge no-ops when it has no URL (see
    // `RelayBridge.start`), so nothing is registered, no account exists, and no
    // request leaves the machine for a relay. Phone pairing is opt-in, and
    // opting in means pointing at a deployment YOU own. Never reintroduce a
    // fallback here — it would silently aim every third-party build, CI run and
    // `pnpm dev` at whatever deployment is named.
    define: {
      "process.env.PANDA_CODE_RELAY_URL": JSON.stringify(
        process.env.PANDA_CODE_RELAY_URL ?? "",
      ),
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
