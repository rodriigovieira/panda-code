# Unified model selector verification

Verified September 4, 2026.

## Changes

The session header, global quick-start dialog, and Settings use the same searchable
model browser. Provider defaults are organized into tabs. Models have descriptions,
selection marks, keyboard navigation, and a custom-ID entry. The popover height is
limited to available space below its trigger.

Codex model names and reasoning capabilities come from the local CLI. Astra has a
documented manual entry when it is absent from that catalog; live metadata takes
precedence. The catalog refreshes when the application regains focus. Claude's
current aliases are available alongside existing version pins. Groq uses the same
browser and no longer filters its options through Claude's model list.

References consulted:

- https://learn.chatgpt.com/docs/models
- https://developers.openai.com/api/docs/models/gpt-6-astra
- https://code.claude.com/docs/en/model-config
- https://code.claude.com/docs/en/setup
- https://prod.cursor.com/help/models-and-usage/available-models

## Actual validation output

`pnpm --dir apps/desktop test`

```text
 Test Files  53 passed | 1 skipped (54)
      Tests  877 passed | 1 skipped (878)
```

The three new model-catalog tests cover the manual Astra entry, live metadata
precedence without duplicates, and preservation of future/custom models.

`pnpm --dir apps/desktop check:codex-protocol`

```text
PASS codex-cli 0.153.2: Panda's required app-server contract is present.
PASS optional permission, MCP elicitation, and warning contracts are present.
```

Installed CLI versions after updating:

```text
codex-cli 0.153.2
2.1.261 (Claude Code)
```

The initial Homebrew cache offered Codex 0.150.1, which failed the Astra smoke test
with a request to upgrade. Refreshing Homebrew and upgrading to 0.153.2 resolved
that failure. The subsequent live `model/list` returned `gpt-6-astra` with
`low`, `medium`, `high`, `xhigh`, `max`, and `ultra` reasoning efforts.

`codex exec --json --skip-git-repo-check --sandbox read-only -C /tmp -m gpt-6-astra 'Reply exactly OK. Do not use tools or access files.' < /dev/null`

Relevant actual output, exit code 0:

```json
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}
{"type":"turn.completed","usage":{"input_tokens":17001,"cached_input_tokens":12928,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}
```

`pnpm --dir apps/desktop package:mac` completed with exit code 0, including its
TypeScript check and production builds. Build output included:

```text
[relay] no relay URL seed — new installs start local-only
  • skipped macOS code signing  reason=identity explicitly is set to null
```

`pnpm --dir apps/desktop sync:mac` completed with exit code 0.

Shipped bundle checks:

```sh
grep -ac 'gpt-6-astra' '/Applications/Panda Code.app/Contents/Resources/app.asar'
# 2
grep -ac 'model-settings-tabs' '/Applications/Panda Code.app/Contents/Resources/app.asar'
# 5
```

## Visual checks and limits

The real renderer was opened in a local browser preview. Screenshots were captured
in the task for the session picker and Settings. Verified Astra selection,
reasoning selection with the End key, provider tabs, model search, and ArrowDown
navigation into filtered results. The browser preview has no Electron bridge, so
it shows the documented Astra entry; CLI discovery was checked separately above.

The installed running instance was not closed or relaunched. Its new Electron
chrome and the operating-system global-shortcut interaction have not been tested
after relaunch. The quick-start dialog uses the same picker component. No live
Claude/Groq request, relay deployment, or mobile changes were tested for this work.
