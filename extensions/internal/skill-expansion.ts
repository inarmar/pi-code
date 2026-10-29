/** Dynamic content expansion for Claude skills. This is not a slash-command extension. */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { type ParsedCommand, substituteArgsDetailed, substituteVars } from './command-file.ts'
import { type CommandExec, expandDynamicContent, resolvePowershellBinary, spanExec } from './command-spans.ts'
import { claudeEffortLevel } from './effort.ts'
import { readManagedSettings } from './managed-settings.ts'
import { checkoutRoot } from './project-root.ts'
import { claudeSettingsChain } from './settings-chain.ts'

const BASH_TIMEOUT_MS = 120_000
export const SHELL_DISABLED_PLACEHOLDER = '[shell command execution disabled by policy]'

/** User or administrator can disable shell substitutions in skills. */
export function shellExecutionDisabled(cwd: string, home: string, trusted: boolean): boolean {
  if (readManagedSettings().disableSkillShellExecution === true) return true
  return claudeSettingsChain(cwd, home, trusted).some((file) => {
    try {
      return (JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>).disableSkillShellExecution === true
    } catch {
      return false
    }
  })
}

/** The ${CLAUDE_*} substitution sources for one command invocation. */
function commandVars(ctx: { cwd: string }, filePath: string): Record<string, string | undefined> {
  const varCtx = ctx as unknown as { sessionManager?: { getSessionId(): string }; thinkingLevel?: ExtensionContext['thinkingLevel'] }
  return {
    CLAUDE_SESSION_ID: varCtx.sessionManager?.getSessionId?.(),
    // Claude vocabulary only, and unset when thinking is off: the variable promises
    // low|medium|high|xhigh|max, and an unset one stays literal in the body.
    CLAUDE_EFFORT: claudeEffortLevel(varCtx.thinkingLevel),
    CLAUDE_SKILL_DIR: path.dirname(filePath),
    CLAUDE_PROJECT_DIR: checkoutRoot(ctx.cwd),
  }
}

/** The exec seam expandCommand runs spans through; pi itself satisfies it. */
interface SpanRunner {
  exec(command: string, args: string[], options?: { cwd?: string; timeout?: number }): Promise<{ stdout: string; stderr: string; code: number; killed?: boolean }>
}

/**
 * A command body expanded to the text a turn (or a tool result) carries:
 * argument and named substitution, ${CLAUDE_*} and plugin variables, `!` spans
 * and `@file` inlining, plus Claude's `ARGUMENTS:` append when the body never
 * read what was passed. Throws when an injected span fails, so a caller never
 * sees a half-expanded body. With `allowShell: false` no span executes at all;
 * each is replaced by SHELL_DISABLED_PLACEHOLDER, which is how both the model
 * path and the disableSkillShellExecution setting keep repo-authored shell
 * from running.
 */
export async function expandCommand(runner: SpanRunner, parsed: ParsedCommand, args: string, ctx: { cwd: string }, filePath: string, options?: { allowShell?: boolean }): Promise<string> {
  const projectRoot = checkoutRoot(ctx.cwd)
  const vars = commandVars(ctx, filePath)
  const { text: withArgs, consumed } = substituteArgsDetailed(parsed.body, args, parsed.argumentNames ?? [])
  // `${user_config.KEY}` is a plugin-command variable only; leave it literal in an
  // ordinary command so a body that happens to contain the syntax is not stripped.
  const substituted = substituteVars(withArgs, vars)
  const withVars = substituted

  const exec: CommandExec =
    (options?.allowShell ?? true)
      ? async (script) => {
          // Hooks get CLAUDE_PROJECT_DIR, and a command's shell span is the same kind of
          // project-scoped script. pi.exec takes no env, so it is set in the script.
          // stderr merges into stdout, as the Bash tool runs these for Claude. The
          // resolver is passed by its imported binding so tests can stub the lookup.
          const run = spanExec(parsed.shell, projectRoot, script, resolvePowershellBinary)
          const result = await runner.exec(run.command, run.args, { cwd: ctx.cwd, timeout: BASH_TIMEOUT_MS })
          // pwsh cannot merge a native command's stderr in-script (spanExec sets
          // mergeStreams), so it is appended here; the sh script merges via 2>&1.
          const stdout = run.mergeStreams ? result.stdout + result.stderr : result.stdout
          return { stdout, stderr: result.stderr, code: result.code, killed: result.killed }
        }
      : () => Promise.resolve({ stdout: SHELL_DISABLED_PLACEHOLDER, stderr: '', code: 0 })
  let expanded = await expandDynamicContent(withVars, ctx.cwd, exec, parsed.shell === 'powershell' ? 'powershell' : 'bash')

  // Claude appends the raw arguments when the command never read them, so what
  // the user typed still reaches the model.
  if (args.trim().length > 0 && !consumed) expanded += `\n\nARGUMENTS: ${args.trim()}`
  return expanded
}
