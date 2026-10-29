# pi-code

Claude Code **skills** and **hooks** compatibility for [Pi](https://pi.dev).

This fork intentionally includes two Pi extensions:

- `extensions/skills.ts` discovers Claude-format skills under `.claude/skills`, expands arguments, `@file` references and optional shell spans, and activates skill hooks **only on explicit `/skill:name` input**. Hooks can also come from any skill Pi has loaded, including Pi packages and additional skill paths.
- `extensions/hooks/index.ts` executes Claude Code lifecycle hooks from `.claude/settings.json`, `.claude/settings.local.json`, user settings, managed settings and explicitly invoked skill frontmatter. It handles blocking, feedback, timeouts and Stop continuation through `agent_before_settle`.

**Skill hooks expire at `agent_settled`**, after all Stop continuations in the current agent run. Ordinary settings hooks remain configured across runs.

This package does not implement commands, MCP servers, Claude plugins, subagents, plan mode, goals, todo management, questions, web tools, environment injection, extra context-file imports, rules, a separate project-trust dialog or settings CLI flags. Those should be provided by Pi, BB or separate packages.

Project-scoped skill and hook resources use Pi's native project trust. The process must be trusted by Pi before project-controlled executable configuration is loaded. In RPC mode, dialogs and notifications depend on the hosting client.

## Install

```sh
pi install git:github.com/inarmar/pi-code
```

Or install a local checkout:

```sh
pi install ./pi-code
```

See [Skills](docs/skills.md) and [Hooks](docs/hooks.md).

## Development

```sh
npm ci
npm run check
bash scripts/e2e-smoke.sh
```

Requires Node >=22.19 and a compatible Pi installation.

MIT license.
