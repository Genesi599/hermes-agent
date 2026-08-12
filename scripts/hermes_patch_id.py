# -*- coding: utf-8 -*-
"""Compute git patch-id for a commit using byte-safe subprocess pipes.

Why: Windows PowerShell 5.1 pipes decode native output as GBK and convert CRLF,
which corrupts `git show --binary` output and yields wrong patch-ids in
Verify-HermesCustomFeatures.ps1. python subprocess pipes are byte-exact, so
patch-ids computed here match `git patch-id` run in bash/cmd.
"""
import subprocess
import sys


def main() -> int:
    commit = sys.argv[1] if len(sys.argv) > 1 else ''
    if not commit:
        return 1
    show = subprocess.run(
        ['git', 'show', '--format=', '--binary', '--no-ext-diff', '--no-renames', commit],
        capture_output=True,
    )
    if show.returncode != 0:
        return 1
    pid = subprocess.run(['git', 'patch-id', '--stable'], input=show.stdout, capture_output=True)
    out = pid.stdout.decode('utf-8', errors='replace').split()
    if not out:
        return 1
    print(out[0])
    return 0


if __name__ == '__main__':
    sys.exit(main())
