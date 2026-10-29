/**
 * Claude Skills Extension
 *
 * Bridges Claude Code's skills into pi. On resources_discover it hands pi the
 * existing `.claude/skills` directories (user then project) as skill paths, so
 * pi discovers Claude Code skills the same way it loads its own `.pi/skills`.
 * pi implements the Agent Skills standard, so `SKILL.md` directories work
 * unchanged and register as `/skill:name`. For skills pi discovers via
 * any other source, the input handler reads hooks from pi's resolved skill path
 * but leaves expansion to pi; hooks register only on explicit invocation.
 *
 * Claude documents that a command file and a skill "work the same way", so a
 * SKILL.md body carries the dynamic features command bodies do: `` !`cmd` ``
 * spans, `@file` references, `$ARGUMENTS`/positional substitution and
 * `${CLAUDE_*}` variables. pi's loader delivers the raw text, so this extension
 * intercepts `/skill:name` input for the skills it contributed, expands the body
 * through the shared command pipeline, and hands pi the already-expanded content
 * in pi's own skill-block format (pi emits the input event before its own
 * expansion, and skips text that no longer starts with `/`).
 *
 * Docs: https://code.claude.com/docs/en/skills.md, https://agentskills.io
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { parseCommandFile } from './internal/command-file.ts'
import { claudeConfigDir } from './internal/config-dir.ts'
import { parseClaudeFrontmatter } from './internal/frontmatter.ts'
import { managedSettingsFile } from './internal/managed-settings.ts'
import { ancestorDirs } from './internal/project-root.ts'
import { claudeSettingsChain, readSettingsChain } from './internal/settings-chain.ts'
import { expandCommand, shellExecutionDisabled } from './internal/skill-expansion.ts'
import { SKILL_HOOKS_CHANNEL } from './internal/skill-hooks.ts'
import { errorMessage, isDirectory, isRecord } from './internal/values.ts'

/** Existing `.claude/skills` directories, user first then project. The project
 * directory is included only for approved projects: pi's loader surfaces every skill's
 * name and description to the model, so an untrusted repository would otherwise get
 * text into the prompt without the user ever agreeing to load its config. */
export function skillDirs(cwd: string, home: string, trusted: boolean): string[] {
  // Claude's precedence: enterprise (the skills directory beside the managed
  // settings file) overrides personal, and personal overrides project; discovery
  // here is first-match, so higher precedence goes first.
  // Claude: "Set to 1 to skip loading skills from the system-wide managed skills
  // directory. Useful for container or CI sessions that should not load
  // operator-provisioned skills." The enterprise dir beside managed-settings.json is
  // that directory here; personal and project skills are unaffected.
  const enterprise = process.env.CLAUDE_CODE_DISABLE_POLICY_SKILLS === '1' ? [] : [path.join(path.dirname(managedSettingsFile()), '.claude', 'skills')]
  const candidates = [...enterprise, path.join(claudeConfigDir(home), 'skills')]
  // Claude loads skills from every .claude/skills between cwd and the repository
  // root; the list goes nearest-first so findClaudeSkill's first match is the
  // closest definition (pi's loader receives the same order).
  if (trusted) candidates.push(...ancestorDirs(cwd, path.join('.claude', 'skills')))
  const dirs: string[] = []
  for (const dir of candidates) {
    if (!dirs.includes(dir) && isDirectory(dir)) dirs.push(dir)
  }
  return dirs
}

interface FoundSkill {
  filePath: string
  baseDir: string
}

/** The skill a directory entry holds, named as pi's loader names it (frontmatter
 * `name`, else the directory name); undefined without a readable SKILL.md. */
function skillAt(root: string, dirName: string): { name: string; filePath: string } | undefined {
  const filePath = path.join(root, dirName, 'SKILL.md')
  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf-8')
  } catch {
    return undefined
  }
  let name = dirName
  try {
    const declared = parseClaudeFrontmatter<Record<string, unknown>>(content).frontmatter.name
    if (typeof declared === 'string' && declared.trim()) name = declared.trim()
  } catch {
    // Malformed frontmatter: pi's loader falls back to the directory name too.
  }
  return { name, filePath }
}

/** A Claude-contributed skill by the name pi's loader gives it. One directory
 * level, the standard layout. */
function findClaudeSkill(name: string, roots: string[]): FoundSkill | undefined {
  for (const root of roots) {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      // A link counts: pi's loader follows it, and skillAt already turns a link that
      // leads to no SKILL.md (dangling, or to a plain file) into undefined.
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const skill = skillAt(root, entry.name)
      if (skill?.name === name) return { filePath: skill.filePath, baseDir: path.dirname(skill.filePath) }
    }
  }
  return undefined
}

export default function skillsExtension(pi: ExtensionAPI) {
  pi.on('resources_discover', (_event, ctx) => {
    // resources_discover fires after session_start, so the approval is already
    // resolved; reading it silently keeps a second trust dialog off the screen.
    const skillPaths = skillDirs(ctx.cwd, os.homedir(), ctx.isProjectTrusted?.() === true)
    return skillPaths.length > 0 ? { skillPaths } : undefined
  })

  // The dynamic-content shim: only for skills this extension contributed; pi's own
  // `.pi/skills` (or an unknown name) pass through to pi's plain expansion.
  pi.on('input', async (event, ctx) => {
    if (event.source === 'extension') return
    return expandSkillInvocation(pi, event.text, ctx)
  })
}

/** Claude's `skillOverrides` value for one skill from the settings chain, later
 * files winning: "off" hides the skill entirely, "name-only" trims its listing
 * (a pi-loader surface, noted in docs). */
function skillOverrideFor(name: string, cwd: string, trusted: boolean): string | undefined {
  let value: string | undefined
  for (const settings of readSettingsChain(claudeSettingsChain(cwd, os.homedir(), trusted))) {
    const overrides = settings.skillOverrides
    if (isRecord(overrides) && typeof overrides[name] === 'string') value = overrides[name]
  }
  return value
}

/** Claude's skillOverrides "off": the skill is hidden and does not run; the
 * invocation is swallowed with a notice. Undefined lets the invocation proceed. */
function refusedByOverride(name: string, ctx: ExtensionContext, trusted: boolean): { action: 'handled' } | undefined {
  if (skillOverrideFor(name, ctx.cwd, trusted) !== 'off') return undefined
  if (ctx.hasUI) ctx.ui.notify(`Skill "${name}" is turned off by skillOverrides in settings.`, 'info')
  return { action: 'handled' }
}

/** A `/skill:name args` invocation into its expanded skill block, or undefined to
 * pass the input through to pi untouched. The expanded body is wrapped in pi's
 * skill-block format so downstream behavior (the baseDir note for relative
 * references) matches an untouched invocation. */
/** Whether pi resolved this skill name to another file: pi loads its own skill directories
 * ahead of the ones this extension adds and the first name wins, so its listing then
 * shows that skill, and the invocation is left to pi's own expansion of it. */
function shadowedByPi(pi: ExtensionAPI, name: string, filePath: string): boolean {
  const loaded = pi.getCommands?.().find((command) => command.source === 'skill' && command.name === `skill:${name}`)
  if (loaded === undefined) return false
  const real = (target: string): string => {
    try {
      return fs.realpathSync(target)
    } catch {
      return path.resolve(target)
    }
  }
  return real(loaded.sourceInfo.path) !== real(filePath)
}

/** The skill name and arguments of a `/skill:<name> <args>` input, or undefined. */
function parseSkillInvocation(rawText: string): { name: string; args: string } | undefined {
  const text = rawText.trimStart()
  if (!text.startsWith('/skill:')) return undefined
  const space = text.indexOf(' ')
  const name = (space === -1 ? text.slice(7) : text.slice(7, space)).trim()
  if (!name) return undefined
  return { name, args: space === -1 ? '' : text.slice(space + 1).trim() }
}

/** Publish only explicitly invoked skills' declared hooks. The actual hook
 * lifecycle belongs to hooks/index.ts; discovery alone must not register them. */
function publishSkillHooks(pi: ExtensionAPI, name: string, frontmatter: Record<string, unknown>): void {
  const declaredHooks = frontmatter.hooks
  if (isRecord(declaredHooks)) pi.events?.emit(SKILL_HOOKS_CHANNEL, { skillName: name, hooks: declaredHooks })
}

/** pi-native skills keep their native body expansion. Read only the resolved file's
 * frontmatter, including for skills supplied by packages or custom search paths. */
function publishSkillHooksFromFile(pi: ExtensionAPI, name: string, filePath: string): void {
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    publishSkillHooks(pi, name, parseClaudeFrontmatter<Record<string, unknown>>(content).frontmatter)
  } catch {
    // pi owns expansion and its own diagnostics. Bad YAML or an unreadable file
    // must not prevent the invocation from reaching pi unchanged.
  }
}

async function expandSkillInvocation(pi: ExtensionAPI, rawText: string, ctx: ExtensionContext): Promise<{ action: 'transform'; text: string } | { action: 'handled' } | undefined> {
  const invocation = parseSkillInvocation(rawText)
  if (!invocation) return
  const { name, args } = invocation
  const trusted = ctx.isProjectTrusted?.() === true
  const found = findClaudeSkill(name, skillDirs(ctx.cwd, os.homedir(), trusted))
  // Only pi knows the complete set of loaded skills: built-in paths, .agents,
  // installed packages, custom skillPaths and the paths contributed above.
  // A non-Claude skill still uses pi's native expansion; we only register its
  // frontmatter hooks when the user explicitly invokes /skill:name.
  if (!found || shadowedByPi(pi, name, found.filePath)) {
    const loaded = pi.getCommands?.().find((command) => command.source === 'skill' && command.name === `skill:${name}`)
    if (loaded) publishSkillHooksFromFile(pi, name, loaded.sourceInfo.path)
    return
  }
  const refused = refusedByOverride(name, ctx, trusted)
  if (refused) return refused
  let parsed: ReturnType<typeof parseCommandFile>
  let content: string
  try {
    content = fs.readFileSync(found.filePath, 'utf-8')
    parsed = parseCommandFile(content)
  } catch {
    // Unreadable, or malformed frontmatter: pass through to pi's plain expansion
    // (the loader registered the skill and delivers the raw body), rather than
    // failing the invocation over the dynamic features it cannot have.
    return
  }
  // Hooks activate only on explicit invocation, and expire when the run settles.
  // so the declaration is announced over the shared bus.
  const frontmatter = parseClaudeFrontmatter<Record<string, unknown>>(content).frontmatter
  const contextMode = String(frontmatter.context ?? '')
    .trim()
    .toLowerCase()
  if (contextMode === 'fork') {
    ctx.ui.notify(`Skill ${name} requires context: fork, which is unavailable without subagents.`, 'warning')
    return { action: 'handled' }
  }
  publishSkillHooks(pi, name, frontmatter)
  let expanded: string
  try {
    expanded = await expandCommand(pi, parsed, args, { cwd: ctx.cwd }, found.filePath, { allowShell: !shellExecutionDisabled(ctx.cwd, os.homedir(), trusted) })
  } catch (error) {
    // A failed injected command aborts the invocation, as it does for a command: pi logs a
    // throwing input handler and continues with the raw text, which would send the body
    // unexpanded. The notify carries the failure message.
    ctx.ui.notify(errorMessage(error), 'error')
    return { action: 'handled' }
  }
  return { action: 'transform', text: `<skill name="${name}" location="${found.filePath}">\nReferences are relative to ${found.baseDir}.\n\n${expanded}\n</skill>` }
}
