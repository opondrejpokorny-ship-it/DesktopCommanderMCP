# Graphify development integration

Graphify is an optional local **code-discovery and navigation aid** for the DC2
Free / Pro / Team prototype. It is not a product runtime dependency and it is
not an authority for security, policy, approvals, tier behavior, Git history,
or implemented behavior.

## Authority

For prototype development:

1. Drive/project decisions and the Active Work Registry provide coordination
   context.
2. `prototype/free-pro-team` is the authoritative DC2 prototype branch.
3. `main` remains a clean upstream mirror.
4. Current source plus tests/runtime prove actual behavior.

Graphify findings are orientation only. Confirm material findings in source and,
when behavior matters, in tests/runtime before editing or reporting them.

Never create or merge `prototype/free-pro-team -> main` as part of Graphify
usage.

## Privacy boundary

DC2 deliberately uses Graphify in **AST/code-only mode**.

The repository wrapper:

- performs code-only extraction;
- does not configure an OpenAI, Anthropic, Gemini, DeepSeek, Kimi, Azure,
  Bedrock, or other semantic backend;
- disables Graphify query logging for wrapper-launched commands;
- does not install Graphify assistant hooks or strict mode;
- stores the generated graph only under ignored `graphify-out/`;
- stores an optional local Python runtime only under ignored `.tools/`.

The wrapper's `update` action intentionally performs a fresh
`extract --code-only --force` rather than Graphify's generic semantic update
path. That keeps DC2 source analysis local even if documentation or other
non-code files changed.

Do not add API keys to this repository for Graphify.

## Local installation on WIN-A0OFGC4ORFI

Recommended project-local setup:

```powershell
cd C:\DesktopCommanderTierPrototype
py -3.12 -m venv .tools\graphify
.tools\graphify\Scripts\python.exe -m pip install --upgrade pip
.tools\graphify\Scripts\python.exe -m pip install graphifyy==0.9.53
```

The wrapper also accepts a `graphify` executable already present on PATH, but
the project-local runtime is preferred for reproducibility.

Do not run `graphify install --strict` for DC2. The repository wrapper, source
inspection, tests, and project workflow remain authoritative.

## Commands

From the repository root:

```powershell
.\scripts\graphify-local.cmd build
.\scripts\graphify-local.cmd update
.\scripts\graphify-local.cmd query "where is tier access enforced?"
.\scripts\graphify-local.cmd path "Node A" "Node B"
.\scripts\graphify-local.cmd explain "Node"
.\scripts\graphify-local.cmd god-nodes
```

Every command runs the Git preflight first.

For query/path/explain/god-nodes, the wrapper refreshes the graph before the
query only when the recorded graph state no longer matches the current
repository state. Freshness includes:

- branch;
- HEAD;
- current `origin/prototype/free-pro-team`;
- a fingerprint of tracked/untracked working-tree changes.

That lets a dirty feature branch be mapped accurately without rebuilding again
for every unchanged query.

## Git preflight rules

The preflight fetches `origin` and `upstream` when those remotes exist.

### prototype/free-pro-team

If local prototype is clean, only behind
`origin/prototype/free-pro-team`, and not diverged, the only automatic branch
mutation allowed is:

```text
git merge --ff-only origin/prototype/free-pro-team
```

After the fast-forward the graph is stale and must be refreshed.

If prototype is dirty while origin advanced, ahead of origin, or diverged, the
preflight fails closed. It never stashes, rebases, resets, creates a merge
commit, or overwrites local work.

### Feature/task branches

Feature branches are never automatically synchronized with prototype.

The preflight only fetches refs, reports whether the authoritative prototype
baseline has advanced, and leaves the branch untouched. Dirty/uncommitted
feature work is included in the graph freshness fingerprint so Graphify can map
the actual local work in progress.

### main

`main` is observational only. The preflight compares local main,
`origin/main`, and `upstream/main` and reports drift. It never updates main.

Upstream-mirror synchronization remains a separate repository-maintenance
operation.

## Generated state

Generated files remain local:

```text
graphify-out/
  graph.json
  .graphify-state.json
```

Freshness state records only repository/tooling metadata such as branch, commit,
prototype baseline, working-tree fingerprint, and generation time. It contains
no file contents or command output.

## Testing

The deterministic contract test is:

```powershell
node --test test/test-graphify-git-preflight.js
```

It uses temporary Git repositories and does not require Graphify or Python. It
covers:

- clean prototype behind origin -> fast-forward only;
- dirty prototype behind -> fail closed and preserve bytes;
- prototype ahead -> fail closed;
- diverged prototype -> fail closed;
- dirty and clean feature branches -> no automatic synchronization;
- main/upstream drift -> warning only, no mutation;
- graph freshness metadata;
- Windows canonical/8.3 path equivalence;
- code-only wrapper and ignored local artifacts.

The real Graphify CLI smoke is local-only and should include at least:

```powershell
.\scripts\graphify-local.cmd god-nodes
.\scripts\graphify-local.cmd query "where is tier access enforced?"
```

Confirm the resulting Graphify findings directly in source before using them as
implementation or security evidence.

## Rule for AI agents

For broad or cross-cutting codebase questions, use the local Graphify graph when
available. Before relying on the graph, use the repository Graphify wrapper,
which verifies Git freshness and refreshes stale graph data automatically.
Graphify is a local navigation aid only; confirm material findings in source and
tests before editing or reporting behavior.

For DC2 prototype development, `prototype/free-pro-team` is the authoritative
prototype branch. `main` remains a clean upstream mirror and must not receive
prototype changes without explicit approval.
