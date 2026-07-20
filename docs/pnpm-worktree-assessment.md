# pnpm worktree setup assessment

Assessed on 2026-07-20 with Node.js 24.18.0, npm 11.16.0, and pnpm 11.13.1.

## Conclusion

pnpm reduces dependency installation time and disk use when separate Git worktrees install the same Node.js dependency graph. It does not reduce the time spent by Bro's current `prepareJobWorktree` implementation, because that path only runs `git worktree add` and does not install dependencies.

Use pnpm for projects where dependency installation is part of preparing each worktree. Do not migrate this application solely to optimize `prepareJobWorktree`; that would change the application's package manager without changing coordinator setup time.

## Measurements

The benchmark used this repository's production and development dependency graph. npm received an isolated cache, pnpm received an isolated content-addressable store, and install scripts were disabled for both package managers. Cold measurements started with an empty cache or store. Warm measurements installed into newly extracted project directories, modeling additional worktrees.

| Scenario | npm `ci` | pnpm `install --frozen-lockfile` |
| --- | ---: | ---: |
| Cold cache/store | 4.26 s | 3.39 s |
| First additional worktree | 2.52 s | 2.19 s |
| Second additional worktree | 2.57 s | 1.42 s |

Across three installed worktrees, npm allocated approximately 309 MiB for `node_modules`. The three pnpm layouts plus their shared store allocated approximately 109 MiB, about 65% less. pnpm can reuse package files through hard links when the worktrees and store are on the same filesystem.

The full test suite passed from the pnpm-installed layout: 12 test files and 47 tests.

These are small local samples rather than a general package-manager benchmark. Network latency, dependency lifecycle scripts, filesystem boundaries, and dependency graph shape can change the result. A future migration should commit `pnpm-lock.yaml`, declare the pnpm version in `package.json`, update Docker build commands, and explicitly allow required dependency build scripts such as esbuild's.
