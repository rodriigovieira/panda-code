import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const KEYCHAIN_SERVICE = "com.pandapdv.pandacode.relay";

async function runSecurity(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("/usr/bin/security", args, { encoding: "utf8" });
  return stdout.trim();
}

export async function readKeychainSecret(account: string): Promise<string | null> {
  try {
    return await runSecurity(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"]);
  } catch {
    return null;
  }
}

export async function writeKeychainSecret(account: string, value: string): Promise<void> {
  // `-U` updates an existing generic password and creates it when absent.
  await runSecurity(["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", account, "-w", value]);
}
