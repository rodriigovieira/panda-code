import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, safeStorage } from "electron";

const execFileAsync = promisify(execFile);
const KEYCHAIN_SERVICE = "com.pandapdv.pandacode.relay";
function vaultPath(): string { return join(app.getPath("userData"), "relay-credentials.enc"); }
function readVault(): Record<string, string> {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("OS-protected credential storage is unavailable. Phone pairing is disabled.");
  if (!existsSync(vaultPath())) return {};
  const value: unknown = JSON.parse(safeStorage.decryptString(readFileSync(vaultPath())));
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.values(value).some(entry => typeof entry !== "string")) throw new Error("Phone credential storage is unreadable.");
  return value as Record<string, string>;
}
export async function readKeychainSecret(account: string): Promise<string | null> {
  const vault = readVault();
  if (Object.hasOwn(vault, account)) return vault[account]!;
  // Migration only: reading the old Keychain item never puts its value in argv.
  let value: string;
  try {
    const { stdout } = await execFileAsync("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"], { encoding: "utf8" });
    value = stdout.trim();
  } catch { return null; }
  await writeKeychainSecret(account, value);
  return value;
}
export async function writeKeychainSecret(account: string, value: string): Promise<void> {
  const vault = readVault();
  vault[account] = value;
  mkdirSync(app.getPath("userData"), { recursive: true, mode: 0o700 });
  const path = vaultPath();
  const temp = `${path}.tmp`;
  const encrypted = safeStorage.encryptString(JSON.stringify(vault));
  const fd = openSync(temp, "w", 0o600);
  try { writeFileSync(fd, encrypted); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
  const directory = openSync(app.getPath("userData"), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
