import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The default glob scans the whole repo, including agent worktrees checked out
    // under .claude/, which would run a second copy of the suite.
    include: ['tests/**/*.test.ts'],
    // Host-env quarantine + per-test env snapshot: the suite runs inside
    // Claude Code / pi subagents whose env carries variables the source reads.
    setupFiles: ['tests/setup.ts'],
    // A hang detector, not a budget: tests spawn real git and shell processes,
    // and a loaded Windows runner has pushed an 88ms-local test past the 5s default.
    testTimeout: 20_000,
    // Mock hygiene is enforced globally so no test depends on a neighbor's spies
    // or stubbed env surviving; shuffle probes order-independence with a fresh
    // seed on every run.
    restoreMocks: true,
    mockReset: true,
    unstubEnvs: true,
    sequence: { shuffle: true },
    coverage: {
      provider: 'v8',
      // lcov feeds SonarQube (see .github/workflows/pr-check.yaml); text is for local runs.
      reporter: ['text', 'lcov'],
      include: ['extensions/**/*.ts'],
      exclude: ['tests/**'],
      // Baseline for the slim skills/hooks-only test suite (measured 95.44/89.72/96.26/97.49).
      // Keep a close floor rather than disabling coverage checks.
      thresholds: { statements: 95, branches: 89, functions: 96, lines: 97 },
    },
  },
})
