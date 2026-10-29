# Claude Code hooks

The Hooks extension translates Claude Code hook declarations from user, managed and **Pi-trusted** project `.claude/settings.json` (including local overrides), and from `hooks` frontmatter in explicitly invoked Pi skills.

Hook types: shell command, HTTP POST and model-evaluated prompt. Unsupported `mcp_tool` and `agent` hook entries are ignored. This package does **not** connect MCP servers or launch subagents.

The integration covers `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`, `Stop`, `SessionStart`, `SessionEnd`, `PreCompact`, `PostCompact`, `Notification` and `PostModelSwitch`, subject to available Pi events. `InstructionsLoaded` requires a separate instructions extension and is not emitted by this package.

A blocking `Stop` hook runs on `agent_before_settle`, appends model-visible feedback and returns `continue: true` to continue the **same run**. A consecutive-block cap prevents infinite loops.

**Lifetime:** hooks from ordinary settings remain available until settings change/session end. Skill-frontmatter hooks start on explicit `/skill:name` and are removed at `agent_settled`, not at `turn_end`. The hook set is preserved through multiple model turns and Stop continuations.

`/hooks` displays the resolved configuration; in an RPC host like BB, `ctx.ui.notify` may not be visible, even though hook execution still works.

Project hooks can execute code in the Pi process's permissions. Use Pi's trust controls and the host's process/container isolation.

Source: [hooks/index.ts](../extensions/hooks/index.ts).
