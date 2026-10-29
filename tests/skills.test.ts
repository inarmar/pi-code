import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Point os.homedir() at a hermetic temp home so the extension-wiring test never reads the
// developer's real ~/.claude skills. The other suites pass home explicitly and are unaffected.
const hoisted = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => hoisted.home }
})

const { default: skillsExt, skillDirs } = await import('../extensions/skills.ts')

const tempDir = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix))

describe('skills trust gating', () => {
  it('omits the project skills directory until the project is approved', () => {
    const cwd = tempDir('cs-proj-')
    const home = tempDir('cs-home-')
    mkdirSync(join(cwd, '.claude', 'skills'), { recursive: true })
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true })

    // A project skill's name and description reach the model's prompt, so an
    // unapproved repository must not contribute them.
    expect(skillDirs(cwd, home, false)).toEqual([join(home, '.claude', 'skills')])
  })
})

describe('skillDirs', () => {
  it('returns nothing when no .claude/skills directory exists', () => {
    expect(skillDirs(tempDir('cs-proj-'), tempDir('cs-home-'), true)).toEqual([])
  })

  it('returns the project skills directory when it exists', () => {
    const cwd = tempDir('cs-proj-')
    const home = tempDir('cs-home-')
    mkdirSync(join(cwd, '.claude', 'skills'), { recursive: true })
    expect(skillDirs(cwd, home, true)).toEqual([join(cwd, '.claude', 'skills')])
  })

  it('lists user skills before project skills', () => {
    const cwd = tempDir('cs-proj-')
    const home = tempDir('cs-home-')
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
    mkdirSync(join(cwd, '.claude', 'skills'), { recursive: true })
    expect(skillDirs(cwd, home, true)).toEqual([join(home, '.claude', 'skills'), join(cwd, '.claude', 'skills')])
  })

  it('ignores a .claude/skills path that is a file, not a directory', () => {
    const cwd = tempDir('cs-proj-')
    const home = tempDir('cs-home-')
    mkdirSync(join(cwd, '.claude'), { recursive: true })
    writeFileSync(join(cwd, '.claude', 'skills'), 'not a dir')
    expect(skillDirs(cwd, home, true)).toEqual([])
  })

  it('finds project skills at the repository root from a subdirectory session', () => {
    const repo = tempDir('cs-repo-')
    const home = tempDir('cs-home-')
    mkdirSync(join(repo, '.git'))
    mkdirSync(join(repo, '.claude', 'skills'), { recursive: true })
    const sub = join(repo, 'src')
    mkdirSync(sub)
    expect(skillDirs(sub, home, true)).toEqual([join(repo, '.claude', 'skills')])
  })
})

describe('extension wiring', () => {
  // A mocked homedir plus a fresh agent dir make the discovery hermetic: the trust store
  // and the home skills both live in temp dirs, never the developer's real config.
  let savedAgentDir: string | undefined
  beforeEach(() => {
    hoisted.home = tempDir('cs-home-')
    savedAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = tempDir('cs-agent-')
  })
  afterEach(() => {
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir
  })

  it('returns skillPaths from resources_discover when skills exist', async () => {
    const cwd = tempDir('cs-proj-')
    mkdirSync(join(cwd, '.claude', 'skills'), { recursive: true })
    const homeSkills = join(hoisted.home, '.claude', 'skills')
    mkdirSync(homeSkills, { recursive: true })

    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>()
    skillsExt({ on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(name, fn) } as never)
    // A .claude/skills directory is itself claude-shaped config, so a project pi trusts
    // silently but has no stored decision for contributes nothing: only the hermetic home
    // skills survive, and never the project's, trusted or not.
    const trusted = (await handlers.get('resources_discover')?.({ reason: 'startup' }, { cwd, isProjectTrusted: () => true })) as { skillPaths: string[] } | undefined
    expect(trusted).toEqual({ skillPaths: [homeSkills] })

    const untrusted = (await handlers.get('resources_discover')?.({ reason: 'startup' }, { cwd, isProjectTrusted: () => false })) as { skillPaths: string[] } | undefined
    expect(untrusted).toEqual({ skillPaths: [homeSkills] })
  })
})

describe('Claude skill invocation expansion', () => {
  const setup = (cwd: string) => {
    const handlers = new Map<string, (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>>()
    const api = {
      on: (name: string, fn: (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>) => handlers.set(name, fn),
      exec: async () => ({ stdout: 'SPAN-OUT\n', stderr: '', code: 0 }),
    }
    skillsExt(api as never)
    return { input: (text: string) => handlers.get('input')?.({ text, source: 'interactive' }, { cwd }) }
  }

  it('expands dynamic content and arguments in a SKILL.md body, as Claude documents', async () => {
    // Claude: a command file and a skill "work the same way": !`cmd` injection and
    // $ARGUMENTS apply to SKILL.md bodies too. pi's loader delivers the raw text,
    // so the docs' first-skill tutorial (built on !`git diff`) emitted literal text.
    const cwd = tempDir('cs-proj-')
    hoisted.home = tempDir('cs-home-')
    mkdirSync(join(hoisted.home, '.claude', 'skills', 'greet'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'skills', 'greet', 'SKILL.md'), '---\nname: greet\ndescription: greets\n---\nDiff: !`git diff HEAD`\nHello $ARGUMENTS')
    const { input } = setup(cwd)
    const result = (await input('/skill:greet world')) as { action: string; text: string }
    expect(result?.action).toBe('transform')
    expect(result.text).toContain('<skill name="greet"')
    expect(result.text).toContain('SPAN-OUT')
    expect(result.text).toContain('Hello world')
    expect(result.text).not.toContain('$ARGUMENTS')
  })

  it('aborts the invocation when an injected command fails, as a command does', async () => {
    // docs/commands.md: a failed !`cmd` span aborts the invocation and the model never sees
    // a half-expanded body. pi logs a throwing input handler and carries on with the raw
    // text, so an uncaught failure sent SKILL.md unexpanded.
    const cwd = tempDir('cs-proj-')
    hoisted.home = tempDir('cs-home-')
    mkdirSync(join(hoisted.home, '.claude', 'skills', 'greet'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'skills', 'greet', 'SKILL.md'), '---\nname: greet\ndescription: greets\n---\nDiff: !`git diff HEAD`\nHello $ARGUMENTS')
    const handlers = new Map<string, (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>>()
    skillsExt({ on: (name: string, fn: (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>) => handlers.set(name, fn), exec: async () => ({ stdout: '', stderr: 'fatal: bad revision', code: 128 }) } as never)
    const notes: Array<{ message: string; level?: string }> = []
    const result = await handlers.get('input')?.({ text: '/skill:greet world', source: 'interactive' }, { cwd, isProjectTrusted: () => true, ui: { notify: (message: string, level?: string) => notes.push({ message, level }) } })

    expect(result).toEqual({ action: 'handled' })
    expect(notes).toHaveLength(1)
    expect(notes[0].level).toBe('error')
    expect(notes[0].message).toContain('git diff HEAD')
  })

  // pi loads its own skill directories ahead of the ones extensions add, first name wins
  // (pi dist/core/resource-loader, skills): the listing then shows pi's skill, and the
  // invocation must run that one, not the Claude skill of the same name.
  const withPiSkill = (cwd: string, piSkillFile: string) => {
    const handlers = new Map<string, (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>>()
    skillsExt({
      on: (name: string, fn: (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>) => handlers.set(name, fn),
      exec: async () => ({ stdout: '', stderr: '', code: 0 }),
      getCommands: () => [{ name: 'skill:greet', source: 'skill', sourceInfo: { path: piSkillFile } }],
    } as never)
    return (text: string) => handlers.get('input')?.({ text, source: 'interactive' }, { cwd })
  }

  it("leaves a skill pi resolved to its own file to pi's expansion", async () => {
    const cwd = tempDir('cs-proj-')
    hoisted.home = tempDir('cs-home-')
    mkdirSync(join(hoisted.home, '.claude', 'skills', 'greet'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'skills', 'greet', 'SKILL.md'), '---\nname: greet\ndescription: claude\n---\nCLAUDE BODY $ARGUMENTS')
    const piSkill = join(tempDir('pi-skills-'), 'SKILL.md')
    writeFileSync(piSkill, '---\nname: greet\ndescription: pi\n---\nPI BODY')

    expect(await withPiSkill(cwd, piSkill)('/skill:greet world')).toBeUndefined()
  })

  it('expands the Claude skill when it is the one pi loaded', async () => {
    const cwd = tempDir('cs-proj-')
    hoisted.home = tempDir('cs-home-')
    mkdirSync(join(hoisted.home, '.claude', 'skills', 'greet'), { recursive: true })
    const claudeSkill = join(hoisted.home, '.claude', 'skills', 'greet', 'SKILL.md')
    writeFileSync(claudeSkill, '---\nname: greet\ndescription: claude\n---\nCLAUDE BODY $ARGUMENTS')

    const result = (await withPiSkill(cwd, claudeSkill)('/skill:greet world')) as { action: string; text: string }
    expect(result.action).toBe('transform')
    expect(result.text).toContain('CLAUDE BODY world')
  })

  it('expands a skill whose directory is a symlink, as pi loads it', async () => {
    // `npx skills add` installs under .agents/skills and links into .claude/skills, and
    // dotfile managers link the whole tree. pi's loader follows the link and registers the
    // skill; the shim skipped it (a symlink is not a directory to Dirent), so the plain
    // body went out with $ARGUMENTS literal and every dynamic feature off.
    const cwd = tempDir('cs-proj-')
    hoisted.home = tempDir('cs-home-')
    const real = tempDir('cs-real-')
    writeFileSync(join(real, 'SKILL.md'), '---\nname: greet\ndescription: greets\n---\nHello $ARGUMENTS')
    mkdirSync(join(hoisted.home, '.claude', 'skills'), { recursive: true })
    symlinkSync(real, join(hoisted.home, '.claude', 'skills', 'greet'))
    const { input } = setup(cwd)
    const result = (await input('/skill:greet world')) as { action: string; text: string }
    expect(result?.action).toBe('transform')
    expect(result.text).toContain('Hello world')
    expect(result.text).not.toContain('$ARGUMENTS')
  })

  it('leaves a dangling skill link to pi, and a link to a plain file', async () => {
    const cwd = tempDir('cs-proj-')
    hoisted.home = tempDir('cs-home-')
    const skills = join(hoisted.home, '.claude', 'skills')
    mkdirSync(skills, { recursive: true })
    symlinkSync(join(hoisted.home, 'nowhere'), join(skills, 'dangling'))
    writeFileSync(join(hoisted.home, 'plain.md'), 'not a directory')
    symlinkSync(join(hoisted.home, 'plain.md'), join(skills, 'plain'))
    const { input } = setup(cwd)
    expect(await input('/skill:dangling x')).toBeUndefined()
    expect(await input('/skill:plain x')).toBeUndefined()
  })

  it('matches a skill by frontmatter name over its directory name, like pi does', async () => {
    const cwd = tempDir('cs-proj-')
    hoisted.home = tempDir('cs-home-')
    mkdirSync(join(hoisted.home, '.claude', 'skills', 'some-dir'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'skills', 'some-dir', 'SKILL.md'), '---\nname: fancy\ndescription: named\n---\nBody here')
    const { input } = setup(cwd)
    const result = (await input('/skill:fancy')) as { action: string; text: string }
    expect(result?.action).toBe('transform')
    expect(result.text).toContain('Body here')
  })

  it('passes through a /skill: invocation it does not own', async () => {
    const cwd = tempDir('cs-proj-')
    hoisted.home = tempDir('cs-home-')
    const { input } = setup(cwd)
    expect(await input('/skill:not-ours x')).toBeUndefined()
  })

  it('passes through ordinary input untouched', async () => {
    const cwd = tempDir('cs-proj-')
    hoisted.home = tempDir('cs-home-')
    const { input } = setup(cwd)
    expect(await input('just a prompt')).toBeUndefined()
  })
})

describe('Claude skill lookup edge cases', () => {
  it('passes a malformed-frontmatter skill through to pi instead of throwing', async () => {
    // parseCommandFile throws on broken YAML; the invocation must degrade to pi's
    // plain expansion (raw body, no dynamic features), never fail the input.
    const cwd = tempDir('cs-proj-')
    hoisted.home = tempDir('cs-home-')
    mkdirSync(join(hoisted.home, '.claude', 'skills', 'rough'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'skills', 'rough', 'SKILL.md'), '---\nname: [broken yaml\n---\nRough body')
    const handlers = new Map<string, (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>>()
    skillsExt({ on: (name: string, fn: never) => handlers.set(name, fn), exec: async () => ({ stdout: '', stderr: '', code: 0 }) } as never)
    await expect(handlers.get('input')?.({ text: '/skill:rough', source: 'interactive' }, { cwd })).resolves.toBeUndefined()
  })
})

describe('skill frontmatter hooks publication', () => {
  const setupWithBus = (cwd: string) => {
    const handlers = new Map<string, (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>>()
    const emitted: Array<{ channel: string; data: unknown }> = []
    const api = {
      on: (name: string, fn: (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>) => handlers.set(name, fn),
      exec: async () => ({ stdout: '', stderr: '', code: 0 }),
      events: { emit: (channel: string, data: unknown) => emitted.push({ channel, data }), on: () => () => {} },
    }
    skillsExt(api as never)
    return { input: (text: string) => handlers.get('input')?.({ text, source: 'interactive' }, { cwd }), emitted }
  }

  it('publishes frontmatter hooks on the shared bus when a skill is invoked', async () => {
    // Claude registers hooks from skill frontmatter when the skill is invoked and
    // keeps them for the rest of the session; the hooks extension owns the running,
    // so the skill side publishes them over the shared bus.
    const cwd = tempDir('cs-proj-')
    hoisted.home = tempDir('cs-home-')
    mkdirSync(join(hoisted.home, '.claude', 'skills', 'secure-ops'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'skills', 'secure-ops', 'SKILL.md'), '---\nname: secure-ops\ndescription: guarded\nhooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: ./scripts/check.sh\n---\nBody')
    const { input, emitted } = setupWithBus(cwd)
    await input('/skill:secure-ops')

    expect(emitted).toContainEqual({
      channel: 'pi-code:skill-hooks',
      data: { skillName: 'secure-ops', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './scripts/check.sh' }] }] } },
    })
  })

  it('publishes nothing for a skill without frontmatter hooks', async () => {
    const cwd = tempDir('cs-proj-')
    hoisted.home = tempDir('cs-home-')
    mkdirSync(join(hoisted.home, '.claude', 'skills', 'plain'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'skills', 'plain', 'SKILL.md'), '---\nname: plain\ndescription: p\n---\nBody')
    const { input, emitted } = setupWithBus(cwd)
    await input('/skill:plain')

    expect(emitted).toEqual([])
  })
})

describe('hooks from any pi-resolved skill', () => {
  const setupNative = (cwd: string, name: string, filePath: string) => {
    const handlers = new Map<string, (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>>()
    const emitted: Array<{ channel: string; data: unknown }> = []
    skillsExt({
      on: (event: string, fn: (data: Record<string, unknown>, ctx: unknown) => Promise<unknown>) => handlers.set(event, fn),
      getCommands: () => [{ name: `skill:${name}`, source: 'skill', sourceInfo: { path: filePath } }],
      events: { emit: (channel: string, data: unknown) => emitted.push({ channel, data }), on: () => () => {} },
    } as never)
    return {
      emitted,
      input: (text: string, source = 'interactive') => handlers.get('input')?.({ text, source }, { cwd }),
      discover: () => handlers.get('resources_discover')?.({ reason: 'startup' }, { cwd }),
    }
  }

  it.each(['.pi/skills', '.agents/skills', 'extra/package-skills'])('registers hooks from pi-discovered %s only on explicit invocation', async (root) => {
    const cwd = tempDir('native-skills-')
    hoisted.home = tempDir('cs-home-')
    const skillFile = join(cwd, root, 'verify', 'SKILL.md')
    mkdirSync(join(cwd, root, 'verify'), { recursive: true })
    writeFileSync(skillFile, '---\nname: verify\ndescription: run checks\nhooks:\n  Stop:\n    - hooks:\n        - type: command\n          command: ./verify.sh\n---\nNative pi body')
    const { input, discover, emitted } = setupNative(cwd, 'verify', skillFile)

    await discover()
    await input('read the verify skill')
    await input('/skill:other')
    await input('/skill:verify', 'extension')
    expect(emitted).toEqual([])

    // Native pi, not pi-code, expands the command's body.
    expect(await input('/skill:verify tests')).toBeUndefined()
    expect(emitted).toEqual([
      {
        channel: 'pi-code:skill-hooks',
        data: { skillName: 'verify', hooks: { Stop: [{ hooks: [{ type: 'command', command: './verify.sh' }] }] } },
      },
    ])
  })

  it('uses the path pi actually resolved when a native skill shadows a Claude skill', async () => {
    const cwd = tempDir('native-skills-')
    hoisted.home = tempDir('cs-home-')
    const nativeFile = join(cwd, '.pi', 'skills', 'guard', 'SKILL.md')
    const claudeFile = join(hoisted.home, '.claude', 'skills', 'guard', 'SKILL.md')
    mkdirSync(join(cwd, '.pi', 'skills', 'guard'), { recursive: true })
    mkdirSync(join(hoisted.home, '.claude', 'skills', 'guard'), { recursive: true })
    writeFileSync(nativeFile, '---\nname: guard\ndescription: native\nhooks:\n  Stop:\n    - hooks: [{ command: native.sh }]\n---\nNative')
    writeFileSync(claudeFile, '---\nname: guard\ndescription: claude\nhooks:\n  Stop:\n    - hooks: [{ command: claude.sh }]\n---\nClaude')
    const { input, emitted } = setupNative(cwd, 'guard', nativeFile)
    expect(await input('/skill:guard')).toBeUndefined()
    expect(emitted).toEqual([
      {
        channel: 'pi-code:skill-hooks',
        data: { skillName: 'guard', hooks: { Stop: [{ hooks: [{ command: 'native.sh' }] }] } },
      },
    ])
  })

  it('does not block pi expansion for missing or invalid skill files', async () => {
    const cwd = tempDir('native-skills-')
    hoisted.home = tempDir('cs-home-')
    const filePath = join(cwd, 'no-longer-here', 'SKILL.md')
    const { input, emitted } = setupNative(cwd, 'missing', filePath)
    expect(await input('/skill:missing')).toBeUndefined()
    expect(emitted).toEqual([])
  })
})

describe('unsupported fork skills and skillOverrides', () => {
  it('refuses context: fork without invoking agents or activating the skill hooks', async () => {
    const cwd = tempDir('cs-proj-')
    hoisted.home = tempDir('cs-home-')
    mkdirSync(join(hoisted.home, '.claude', 'skills', 'deploy'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: d\ncontext: fork\nhooks:\n  Stop: []\n---\nDeploy now.')
    const handlers = new Map<string, (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>>()
    const emitted: unknown[] = []
    const warnings: string[] = []
    skillsExt({
      on: (name: string, fn: never) => handlers.set(name, fn),
      events: { emit: (_channel: string, data: unknown) => emitted.push(data) },
      exec: async () => ({ stdout: '', stderr: '', code: 0 }),
    } as never)
    const result = await handlers.get('input')?.({ text: '/skill:deploy', source: 'interactive' }, { cwd, ui: { notify: (message: string) => warnings.push(message) } })
    expect(result).toEqual({ action: 'handled' })
    expect(warnings[0]).toContain('unavailable without subagents')
    expect(emitted).toEqual([])
  })

  it('refuses a skill set to off in skillOverrides', async () => {
    const cwd = tempDir('cs-proj-')
    hoisted.home = tempDir('cs-home-')
    mkdirSync(join(hoisted.home, '.claude', 'skills', 'quiet'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'skills', 'quiet', 'SKILL.md'), '---\nname: quiet\ndescription: q\n---\nBody')
    mkdirSync(join(hoisted.home, '.claude'), { recursive: true })
    writeFileSync(join(hoisted.home, '.claude', 'settings.json'), JSON.stringify({ skillOverrides: { quiet: 'off' } }))
    const handlers = new Map<string, (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>>()
    const notes: string[] = []
    skillsExt({ on: (name: string, fn: never) => handlers.set(name, fn), exec: async () => ({ stdout: '', stderr: '', code: 0 }) } as never)
    const result = (await handlers.get('input')?.({ text: '/skill:quiet', source: 'interactive' }, { cwd, hasUI: true, ui: { notify: (m: string) => notes.push(m) } })) as { action: string } | undefined

    expect(result?.action).toBe('handled')
    expect(notes.some((n) => n.includes('skillOverrides'))).toBe(true)
  })

  it('skips the enterprise skills directory when CLAUDE_CODE_DISABLE_POLICY_SKILLS is set', () => {
    // Claude: "Set to 1 to skip loading skills from the system-wide managed skills
    // directory. Useful for container or CI sessions that should not load
    // operator-provisioned skills." The enterprise dir beside managed-settings.json is
    // that directory here; personal and project skills are untouched.
    return (async () => {
      const { setManagedSettingsPath } = await import('../extensions/internal/managed-settings.ts')
      const managedDir = tempDir('cs-managed-')
      setManagedSettingsPath(join(managedDir, 'managed-settings.json'))
      process.env.CLAUDE_CODE_DISABLE_POLICY_SKILLS = '1'
      try {
        const cwd = tempDir('cs-proj-')
        const home = tempDir('cs-home-')
        mkdirSync(join(managedDir, '.claude', 'skills', 'deploy'), { recursive: true })
        writeFileSync(join(managedDir, '.claude', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: e\n---\nENTERPRISE BODY')
        mkdirSync(join(home, '.claude', 'skills'), { recursive: true })

        const dirs = skillDirs(cwd, home, true)
        expect(dirs).toEqual([join(home, '.claude', 'skills')])
      } finally {
        delete process.env.CLAUDE_CODE_DISABLE_POLICY_SKILLS
        setManagedSettingsPath(undefined)
      }
    })()
  })

  it('discovers enterprise skills beside the managed settings file, winning a name clash', async () => {
    const { setManagedSettingsPath } = await import('../extensions/internal/managed-settings.ts')
    const managedDir = tempDir('cs-managed-')
    setManagedSettingsPath(join(managedDir, 'managed-settings.json'))
    try {
      const cwd = tempDir('cs-proj-')
      hoisted.home = tempDir('cs-home-')
      mkdirSync(join(managedDir, '.claude', 'skills', 'deploy'), { recursive: true })
      writeFileSync(join(managedDir, '.claude', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: e\n---\nENTERPRISE BODY')
      mkdirSync(join(hoisted.home, '.claude', 'skills', 'deploy'), { recursive: true })
      writeFileSync(join(hoisted.home, '.claude', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: p\n---\nPERSONAL BODY')

      const dirs = skillDirs(cwd, hoisted.home, true)
      expect(dirs[0]).toBe(join(managedDir, '.claude', 'skills'))

      // The observable outcome, not the directory ordering: invoking the clashing
      // name expands the enterprise body. Directory order alone would still pass
      // if resolution flipped to last-match; the expansion cannot.
      const handlers = new Map<string, (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>>()
      skillsExt({ on: (name: string, fn: never) => handlers.set(name, fn), exec: async () => ({ stdout: '', stderr: '', code: 0 }) } as never)
      const result = (await handlers.get('input')?.({ text: '/skill:deploy', source: 'interactive' }, { cwd })) as { action: string; text: string }
      expect(result?.action).toBe('transform')
      expect(result.text).toContain('ENTERPRISE BODY')
      expect(result.text).not.toContain('PERSONAL BODY')
    } finally {
      setManagedSettingsPath(undefined)
    }
  })
})
