/** Shared memory-index settings used only by subagents. The standalone
 * /memory command and automatic parent memory injection have been removed. */
import { readManagedSettings } from './managed-settings.ts'
import { claudeSettingsChain, readSettingsChain } from './settings-chain.ts'

export const INDEX_MAX_LINES = 200

/** The index's lines: the text after a final newline is not a line of its own, and the
 * index is always written with one. */
function indexLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}
export const INDEX_MAX_BYTES = 25_000

export function autoMemoryEnabled(setting: unknown, env: NodeJS.ProcessEnv): boolean {
  const disable = (env.CLAUDE_CODE_DISABLE_AUTO_MEMORY ?? '').trim().toLowerCase()
  if (disable === '1' || disable === 'true') return false
  // Claude: "Set to 0 to force auto memory on even when --bare mode or
  // autoMemoryEnabled: false would otherwise disable it."
  if (disable === '0' || disable === 'false') return true
  return setting !== false
}

/** Length of the line break `text` starts with: CRLF, LF, or none. */
function leadingLineBreak(text: string): number {
  if (text.startsWith('\r\n')) return 2
  return text.startsWith('\n') ? 1 : 0
}

/** Drop every `<!-- ... -->` (and the line break after it) in one pass. A regex strip
 * can rebuild a comment from one nested in another: `<!-<!-- x -->-- y -->` loses the
 * inner comment and becomes `<!--- y -->`. After a removal the scan resumes three
 * characters back, so a comment assembled across the cut is removed too; an opener
 * that never closes stays as text. */
function removeComments(text: string): string {
  let out = text
  let cursor = 0
  while (cursor < out.length) {
    const open = out.indexOf('<!--', cursor)
    const close = open === -1 ? -1 : out.indexOf('-->', open + 4)
    if (close === -1) return out
    const tail = out.slice(close + 3)
    out = out.slice(0, open) + tail.slice(leadingLineBreak(tail))
    cursor = Math.max(0, open - 3)
  }
  return out
}

/** The index content that actually loads: YAML frontmatter and block-level HTML
 * comments are stripped, so they neither show in the prompt nor count toward the
 * 200-line / 25KB read limits, matching Claude Code. */
export function stripNonLoaded(text: string): string {
  return removeComments(text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ''))
}

/** The index as injected into the prompt, bounded like Claude's startup load. */
export function capIndexForPrompt(index: string): string {
  const loaded = stripNonLoaded(index)
  const all = indexLines(loaded)
  const withinLines = all.slice(0, INDEX_MAX_LINES)
  let dropped = all.length - withinLines.length
  let text = withinLines.join('\n')
  while (Buffer.byteLength(text, 'utf-8') > INDEX_MAX_BYTES && withinLines.length > 1) {
    withinLines.pop()
    dropped++
    text = withinLines.join('\n')
  }
  if (dropped <= 0) return loaded
  return `${text}\n(${dropped} more memories not shown; use the memory tool with action "list")`
}

/** The settings chain that decides `autoMemoryEnabled` and `autoMemoryDirectory`:
 * user settings always, then project settings (nearest at or above cwd) only when
 * approved, since a project's `autoMemoryDirectory` is honored under the same trust
 * rule as hooks in settings files. Later files win. */
export function memorySettingsFiles(cwd: string, home: string, approved: boolean): string[] {
  return claudeSettingsChain(cwd, home, approved)
}

/** Merge the two memory settings across the chain, later files winning per key;
 * managed policy settings win over every file, per Claude's settings precedence. */
export function readMemorySettings(files: string[], managed: Record<string, unknown> = readManagedSettings()): { autoMemoryEnabled?: unknown; autoMemoryDirectory?: unknown } {
  const merged: { autoMemoryEnabled?: unknown; autoMemoryDirectory?: unknown } = {}
  for (const settings of readSettingsChain(files)) {
    if ('autoMemoryEnabled' in settings) merged.autoMemoryEnabled = settings.autoMemoryEnabled
    if ('autoMemoryDirectory' in settings) merged.autoMemoryDirectory = settings.autoMemoryDirectory
  }
  if ('autoMemoryEnabled' in managed) merged.autoMemoryEnabled = managed.autoMemoryEnabled
  if ('autoMemoryDirectory' in managed) merged.autoMemoryDirectory = managed.autoMemoryDirectory
  return merged
}

