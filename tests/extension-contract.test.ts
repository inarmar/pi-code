import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('minimal Pi package contract', () => {
  it('loads only skills and hooks', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as {
      pi: { extensions: string[] }
    }
    expect(pkg.pi.extensions).toEqual(['./extensions/hooks/index.ts', './extensions/skills.ts'])
  })
})
