import { describe, expect, it, vi } from "vitest";
const { showMessageBox } = vi.hoisted(() => ({ showMessageBox: vi.fn() }));
vi.mock("electron", () => ({ dialog: { showMessageBox } }));
import { browserUrlAllowed, externalUrlAllowed, configureBrowserPermissions } from "./browserSecurity";
import type { Session } from "electron";
describe("website security", () => {
 it("rejects file, script, privileged schemes and embedded credentials", () => {
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,hello", "panda://open", "https://user:secret@example.com"]) expect(browserUrlAllowed(url)).toBe(false);
  expect(browserUrlAllowed("https://example.com")).toBe(true);
  expect(externalUrlAllowed("mailto:person@example.com")).toBe(true);
 });
 it("denies background and third-party requests and rechecks origin after consent", async () => {
  const session = { setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn(), setDevicePermissionHandler: vi.fn() };
  configureBrowserPermissions(session as unknown as Session);
  const request = session.setPermissionRequestHandler.mock.calls[0]![0];
  const check = session.setPermissionCheckHandler.mock.calls[0]![0];
  let url = "https://example.com"; let focused = false;
  const contents = {id:1, isDestroyed:()=>false, getURL:()=>url, isFocused:()=>focused};
  const cb = vi.fn();
  request(contents, "media", cb, {requestingUrl:url}); expect(cb).toHaveBeenLastCalledWith(false);
  focused = true;
  request(contents, "media", cb, {requestingUrl:"https://evil.example"}); expect(cb).toHaveBeenLastCalledWith(false);
  expect(showMessageBox).not.toHaveBeenCalled();
  showMessageBox.mockResolvedValueOnce({response:1});
  request(contents, "media", cb, {requestingUrl:url}); url = "https://other.example";
  await Promise.resolve(); expect(cb).toHaveBeenLastCalledWith(false);
  expect(check(contents,"media",url)).toBe(false);
  showMessageBox.mockResolvedValueOnce({response:1});
  request(contents,"media",cb,{requestingUrl:url}); await Promise.resolve();
  expect(cb).toHaveBeenLastCalledWith(true); expect(check(contents,"media",url)).toBe(true);
  expect(session.setDevicePermissionHandler.mock.calls[0]![0]()).toBe(false);
 });
});
