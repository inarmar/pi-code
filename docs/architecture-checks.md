# Architecture checks

Install the standalone AST Metrics 0.43.1 binary on PATH (or at
`~/.local/bin/ast-metrics`) and Python 3. No upstream source checkout is required.
Enable the hook in every new or existing checkout:

```sh
git config --local core.hooksPath .githooks
```

Commits on `main` run `ast-metrics review --base HEAD --fail-on any`.
Other branches and detached HEAD skip the check. The gate compares an isolated
snapshot of staged files against HEAD, preserves unstaged changes and removes
its temporary worktree on success or failure. Temporary files stay under
`/tmp/agents-tmp/`. Missing tools, analysis errors and reported regressions block
the commit. Keep normal hooks enabled; resolve failures before completing work.

The native review checks complexity, maintainability, outgoing coupling and
Halstead estimated bugs. Existing debt alone does not block commits. Dependencies,
generated output and audit references are excluded; tests are included. No AI
classifier or external source upload is enabled. This is a local hook, not
server-side branch protection. It does not test runtime compatibility with BB,
Pi or other repositories.

The system component inventory and cross-component validation map are maintained
in the sibling `bb-native-projects` checkout, in `deploy/components.json` and
`docs/system-checks.md`. This hook is self-contained and does not depend on that
checkout being present.
