import { dialog, type Session, type WebContents } from "electron";

export function browserUrlAllowed(value: string): boolean {
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}
export function externalUrlAllowed(value: string): boolean {
  try { const url = new URL(value); return ["https:", "http:", "mailto:"].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}
function origin(value: string): string | undefined {
  try { const url = new URL(value); return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) ? url.origin : undefined; }
  catch { return undefined; }
}
const configured = new WeakSet<Session>();
/** Grants last only for this process and this origin; embedded third parties
 * and background tabs cannot acquire privileges through a hidden prompt. */
export function configureBrowserPermissions(session: Session): void {
  if (configured.has(session)) return;
  configured.add(session);
  const grants = new Set<string>();
  const pending = new Set<string>();
  const key = (contents: WebContents | null, permission: string, requesting: string): string | undefined => {
    if (!contents || contents.isDestroyed()) return undefined;
    const top = origin(contents.getURL());
    if (!top || origin(requesting) !== top) return undefined;
    return `${contents.id}:${top}:${permission}`;
  };
  session.setPermissionCheckHandler((contents, permission, requestingOrigin) => {
    const grant = key(contents, permission, requestingOrigin);
    return grant !== undefined && grants.has(grant);
  });
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    const grant = key(contents, permission, details.requestingUrl);
    if (!grant || !contents.isFocused() || !["media", "geolocation", "notifications", "clipboard-read"].includes(permission) || pending.has(grant)) { callback(false); return; }
    if (grants.has(grant)) { callback(true); return; }
    pending.add(grant);
    const requestingOrigin = origin(details.requestingUrl)!;
    void dialog.showMessageBox({
      type: "question", title: "Website permission", buttons: ["Deny", "Allow for this tab"], defaultId: 0, cancelId: 0,
      message: `${requestingOrigin} wants ${permission === "media" ? "camera or microphone access" : permission}.`,
      detail: "Allow only if you trust this website. Permission expires when Panda Code closes.",
    }).then(({ response }) => {
      const allowed = response === 1 && !contents.isDestroyed() && origin(contents.getURL()) === requestingOrigin;
      if (allowed) grants.add(grant);
      callback(allowed);
    }, () => callback(false)).finally(() => pending.delete(grant));
  });
  session.setDevicePermissionHandler(() => false);
}
