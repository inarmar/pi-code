# Claude Code skills

Pi loads skills natively; this extension contributes `.claude/skills/<name>/SKILL.md` from user and trusted project scopes and the configured managed-skills directory.

- A skill is activated only through an explicit `/skill:name` invocation (including a single skill selected in BB's composer and converted to that command by BB's Pi provider).
- On that invocation the extension reads the resolved skill's frontmatter and publishes `hooks` to the Hooks extension. The resolved skill can come from any source Pi sees: `.pi/skills`, `.agents/skills`, additional `--skill` paths, or packages.
- Hook activation does **not** happen merely because the model reads `SKILL.md` or Pi discovers a skill.
- Hooks expire at `agent_settled`, after automatic retries, Stop continuations and the complete current agent run. A later run requires a new explicit invocation.
- Pi-native skills use Pi's own body expansion. For Claude-contributed skills, this extension supports arguments, `@file` and shell substitutions. `disableSkillShellExecution` from Claude settings suppresses shell substitutions.
- A skill with `context: fork` cannot run because this package does not include subagents.

The extension consults Pi's project trust; it does not implement a second trust prompt. In a headless untrusted project, project-controlled skills are not loaded.

Source: [skills.ts](../extensions/skills.ts).
