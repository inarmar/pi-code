#!/usr/bin/env python3
"""Gate only main commits, reviewing the staged tree rather than working files."""

import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def git(*args, cwd=None, env=None):
    return subprocess.run(
        ['git', *args], cwd=cwd, env=env, check=True,
        text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    ).stdout.strip()


def check():
    branch = subprocess.run(
        ['git', 'symbolic-ref', '--quiet', '--short', 'HEAD'],
        text=True, stdout=subprocess.PIPE, check=False,
    )
    if branch.returncode or branch.stdout.strip() != 'main':
        return 0
    root = Path(git('rev-parse', '--show-toplevel'))
    base = git('rev-parse', 'HEAD')
    tree = git('write-tree')
    if tree == git('rev-parse', 'HEAD^{tree}'):
        return 0
    binary = shutil.which('ast-metrics') or str(Path.home() / '.local/bin/ast-metrics')
    if not Path(binary).is_file():
        raise RuntimeError('AST Metrics is required for commits to main. See docs/architecture-checks.md.')

    # Git supplies a temporary index for partial commits; never reuse it in the snapshot.
    env = {key: value for key, value in os.environ.items() if key not in git('rev-parse', '--local-env-vars').splitlines()}
    scratch = Path('/tmp/agents-tmp')
    scratch.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='architecture-', dir=scratch) as temporary:
        snapshot = Path(temporary) / 'index'
        env['TMPDIR'] = temporary
        git('worktree', 'add', '--quiet', '--detach', str(snapshot), base, cwd=root, env=env)
        try:
            git('read-tree', '--reset', '-u', tree, cwd=snapshot, env=env)
            print('AST Metrics: reviewing staged changes on main against HEAD.', flush=True)
            result = subprocess.run(
                [binary, 'review', '--base', base, '--fail-on', 'any', '--max-findings', '20', '.'],
                cwd=snapshot, env=env, check=False,
            )
            return result.returncode
        finally:
            git('worktree', 'remove', '--force', str(snapshot), cwd=root, env=env)


if __name__ == '__main__':
    try:
        sys.exit(check())
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f'Architecture check failed: {error}', file=sys.stderr)
        sys.exit(1)
