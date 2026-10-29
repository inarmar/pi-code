# Claude Code hooks

The Hooks extension translates Claude Code hook declarations from user, managed and **Pi-trusted** project settings, and from `hooks` frontmatter in explicitly invoked Pi skills.

Settings sources, in merge order:

- User: `~/.claude/settings.json` (or `CLAUDE_CONFIG_DIR`), `~/.pi/agent/settings.json` (or `PI_CODING_AGENT_DIR/settings.json`), `~/.agents/settings.json`.
- Trusted project: existing `.claude/settings.json` and `.claude/settings.local.json` locations, then `<cwd>/.pi/settings.json`, `<cwd>/.pi/settings.local.json`, `<cwd>/.agents/settings.json`, `<cwd>/.agents/settings.local.json`.

All sources use the same `{"hooks": {"PreToolUse": [...]}}` JSON format. Hooks merge additively; identical handlers are deduplicated. Project files are excluded until Pi trusts the project, including during live reload. `disableAllHooks`, HTTP allowlists and managed-only policy apply to the new sources too. Files created or edited during a session are picked up automatically. Claude retains its existing local-settings placement rules; `.pi` and `.agents` project settings stay in the current working directory, including in worktrees. Only hook-related settings are read from the additional sources; other Pi settings are left to Pi.

Hook types: shell command, HTTP POST and model-evaluated prompt. Unsupported `mcp_tool` and `agent` hook entries are ignored. This package does **not** connect MCP servers or launch subagents.

The integration covers `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`, `Stop`, `SessionStart`, `SessionEnd`, `PreCompact`, `PostCompact`, `Notification` and `PostModelSwitch`, subject to available Pi events. `InstructionsLoaded` requires a separate instructions extension and is not emitted by this package.

A blocking `Stop` hook runs on `agent_before_settle`, appends model-visible feedback and returns `continue: true` to continue the **same run**. A consecutive-block cap prevents infinite loops.

**Lifetime:** hooks from ordinary settings remain available until settings change/session end. Skill-frontmatter hooks start on explicit `/skill:name` and are removed at `agent_settled`, not at `turn_end`. The hook set is preserved through multiple model turns and Stop continuations.

`/hooks` displays the resolved configuration; in an RPC host like BB, `ctx.ui.notify` may not be visible, even though hook execution still works.

Project hooks can execute code in the Pi process's permissions. Use Pi's trust controls and the host's process/container isolation.

Source: [hooks/index.ts](../extensions/hooks/index.ts).
