#!/usr/bin/env node

// Validate the installed Codex CLI's generated app-server contract against the
// methods Panda actually uses. Generated schemas are version-specific, so this
// cheap check belongs beside the live behavioral probe rather than as a copied,
// quickly-stale schema tree in the repository.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const output = mkdtempSync(join(tmpdir(), "panda-codex-schema-"));

const required = {
  "ClientRequest.ts": [
    "initialize",
    "thread/start",
    "thread/resume",
    "thread/unsubscribe",
    "turn/start",
    "turn/steer",
    "turn/interrupt",
    "model/list",
    "account/rateLimits/read",
  ],
  "ServerRequest.ts": [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/tool/requestUserInput",
  ],
  "ServerNotification.ts": [
    "thread/started",
    "turn/started",
    "turn/completed",
    "item/started",
    "item/completed",
    "item/agentMessage/delta",
    "thread/tokenUsage/updated",
    "serverRequest/resolved",
  ],
};

const optional = {
  "ServerRequest.ts": ["item/permissions/requestApproval", "mcpServer/elicitation/request"],
  "ServerNotification.ts": ["warning", "deprecationNotice", "configWarning"],
};

try {
  const version = execFileSync("codex", ["--version"], { encoding: "utf8" }).trim();
  execFileSync("codex", ["app-server", "generate-ts", "--out", output], { stdio: "inherit" });

  const missing = [];
  for (const [file, methods] of Object.entries(required)) {
    const source = readFileSync(join(output, file), "utf8");
    for (const method of methods) {
      if (!source.includes(`\"method\": \"${method}\"`)) missing.push(`${file}: ${method}`);
    }
  }
  if (missing.length > 0) {
    console.error(`FAIL ${version}: Panda requires missing app-server methods:\n- ${missing.join("\n- ")}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS ${version}: Panda's required app-server contract is present.`);
  }

  const unavailable = [];
  for (const [file, methods] of Object.entries(optional)) {
    const source = readFileSync(join(output, file), "utf8");
    for (const method of methods) {
      if (!source.includes(`\"method\": \"${method}\"`)) unavailable.push(method);
    }
  }
  if (unavailable.length > 0) {
    console.log(`INFO optional interactions unavailable on this CLI: ${unavailable.join(", ")}`);
  } else {
    console.log("PASS optional permission, MCP elicitation, and warning contracts are present.");
  }
} catch (error) {
  console.error(`FAIL could not inspect codex app-server: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  rmSync(output, { recursive: true, force: true });
}
