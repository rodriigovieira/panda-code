# Security boundaries and local data

The optional relay is designed to carry encrypted content. Its URL is public
configuration. Transport credentials and the pairing encryption key have separate
roles; see [the protocol](protocol.md#authenticated-commands-and-revocation-command-protocol-v2).
Anyone with the QR code can obtain the key, so treat it like an access credential.
The relay operator sees routing metadata, timing, sizes, device names and push
tokens. Hosting your own relay does not make its cloud provider invisible.

An authorized phone can read workspace files and ask agents to act. Remote full
access is disabled by default; enabling it on the Mac can extend the impact of a
lost phone to the files and accounts available to the local user. Revoking phone
access rotates the shared key and disconnects all phones. Already downloaded data
cannot be recalled. Keep the OS, browser runtime and model CLIs updated.

The desktop re-evaluates agent authority at each remote delivery. Claude uses the
more permissive possibility from its saved selector and parsed launcher flags,
including legacy requests where an older launcher may have appended both. Missing
or unresolved effective permissions—including Codex with no known sandbox—
are not assumed read-only and cannot be controlled from the phone. Full-access
delivery and granting a phone approval require the Mac-side opt-in; denials do not.

Desktop remote file operations check both lexical paths and resolved symlinks,
open regular files without following a final symlink, verify the opened inode,
and bound reads/writes. This protects against workspace links escaping the root.
It is not isolation from hostile processes running as your own OS user, which can
change files or read application memory. Agent permissions remain a separate
boundary. Panda Peers section IDs route requests; they do not authenticate or
isolate same-user agents from each other.

Browser pages run sandboxed with Node disabled. App IPC accepts only the main
frame of an application window at the trusted application URL. Browser navigation
is restricted to HTTP(S); external links additionally permit mailto. Device
permissions are denied and supported website permissions require a foreground,
first-party consent prompt. Grants expire with the process. This reduces attack
surface; it does not guarantee protection from every Chromium vulnerability.

## Model providers

The built-in Groq runtime sends prompts, workspace listings, selected metadata and
requested files to Groq. Its file tools exclude hidden paths, common credential
filenames, `.gitignore` and `.pandaignore` matches, and files outside the canonical
workspace. Put additional sensitive paths in `.pandaignore` before using it. A
filename filter cannot discover every secret embedded in otherwise normal code.
External Claude/Codex CLIs have their own provider and context policies.

## Local retention

Conversations, prompt history, searchable transcript caches and workspace metadata
remain local and can contain private content. They are not encrypted individually
by Panda Code; protect the OS account and disk with FileVault or equivalent.
New transcript cache files use owner-only permissions. Desktop relay credentials
are encrypted using Electron safeStorage (OS-backed storage) and never passed as
secret command-line arguments. This is not a hardware-isolated key vault.

Browser audit logs keep approximately 2,000 actions; typed input, URL query values,
fragments and credentials are omitted. Existing browser logs are scrubbed when
opened. Debug logging redacts content and credential fields, but older debug logs,
conversation exports, provider CLI logs and backups can still contain material
written by previous versions. Review support bundles and exports before sharing.
The app does not silently delete your original conversations or old backups.

Mobile app locking removes hidden routes from hit testing, focus and accessibility
while displaying the lock/privacy cover. This is UI protection, not encryption of
already loaded process memory. Biometric protection still depends on the device OS.

## Publishing

Publish a scrubbed snapshot with the repository's export procedure, never private
Git history. The export checks names, paths, environment values and secrets,
including exact environment values embedded in binary or large files. Changed
images and binaries require human review; the first publication requires review
of the complete binary/image inventory. Remote-history lookup and fetch errors
fail closed. No automated scan proves that an arbitrary screenshot or document
is safe to share.
