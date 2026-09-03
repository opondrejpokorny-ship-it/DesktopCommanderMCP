# Skills usage audit

Date: 2026-09-03
Branch: `feat/skills-usage-audit`
Baseline: `prototype/free-pro-team` at `3e9de0022c1173ae91c07f9b630df0da7f63f3f5`

## What a Desktop Commander skill is

Skills are agent-side procedural guidance. They tell a compatible AI client when and how to combine Desktop Commander tools. They are not MCP tool implementations and they are not a security boundary.

The canonical source-tree skill set currently contains seven skills:

- `ai-tools-setup`
- `computer-health-check`
- `desktop-commander-overview`
- `knowledge-base`
- `obsidian-vault`
- `software-project-workflow`
- `terminal`

The actual filesystem/process side effects still flow through Desktop Commander tools and all normal upstream validation plus the prototype policy/approval layer.

## Client/distribution behavior

- Gemini CLI extension: discovers the root `skills/` directory bundled with the extension.
- Claude Code plugin: discovers `plugins/claude/skills/`.
- Cursor plugin: discovers `plugins/cursor/skills/` and also has its always-on Desktop Commander rule.
- Plain MCP/Remote MCP tool use does not automatically transmit these repository `SKILL.md` files to a remote client. A client must support/install the skill/plugin separately, or the workflow must be represented through a client-supported skill/plugin surface.
- The npm package itself currently publishes only the paths listed by `package.json#files` (`dist`, `logo.png`, `testemonials`), so installing/running the MCP package alone is not equivalent to installing its client-side skills.

This distinction matters for ChatGPT: the Remote MCP connection exposes Desktop Commander actions/tools, while a separate plugin/skill distribution path is needed if we want ChatGPT itself to receive these workflow instructions automatically. Policy enforcement must therefore never depend on skill compliance.

## Findings

### Fixed: Cursor missed the prototype workflow skill

Before this audit, the canonical and Claude sets contained `software-project-workflow`, but the Cursor plugin did not. This created unintended client-dependent behavior.

Fix:
- mirrored `software-project-workflow` into the Cursor plugin,
- documented it in both Claude and Cursor plugin READMEs,
- added `test/test-skill-distribution.js` so future canonical/client drift fails CI.

### Improved: skill guidance cannot be treated as authorization

`software-project-workflow` now explicitly states that a skill, checkpoint, saved plan, or earlier approval is not authorization for a new side effect. Policy decisions, exact-action approvals, allowed-directory checks, blocked-command checks, and upstream handlers remain authoritative.
### Verified: tool references are current

The principal Desktop Commander tool identifiers referenced by the canonical skills were compared with the current RDC tool surface. No stale/nonexistent tool name was found.

### Follow-up: Agent Skills frontmatter portability

The canonical/upstream skill files currently use top-level `version` and `audience` fields. The current open Agent Skills specification allows `name`, `description`, `license`, `compatibility`, `metadata`, and experimental `allowed-tools`; version-like metadata belongs under `metadata:`. The strict reference validator rejects unexpected top-level fields. Cursor/Gemini currently tolerate or consume the existing files, so this is a portability/validation risk rather than a demonstrated runtime break in our supported clients.

Do not bulk-rewrite the six upstream-owned skills in the prototype without first validating Claude, Cursor and Gemini discovery. Prefer an upstream-compatible migration or upstream contribution, with a client matrix test.

### Follow-up: root portable plugin manifest is legacy

The root `plugin.json` uses an older manifest shape with top-level `skills` and `mcpServers`. The current Agent Plugins 1.0 specification requires a `$schema` field and fixed discovery locations (`skills/` and `mcp.json`).

This audit does not rewrite that upstream-owned packaging contract because compatibility with legacy consumers should be tested first. A future isolated interoperability change should:
1. validate current legacy consumers,
2. add/validate Agent Plugins 1.0 packaging,
3. prove skills and MCP server discovery in each supported client,
4. avoid changing the clean upstream `main` mirror.

## Recommended next improvement

For our Free/Pro/Team showcase, the highest-value follow-up is to make skill availability explicit across the client surfaces we demonstrate. In particular, if ChatGPT is a primary demo surface, package/publish the workflow as a ChatGPT-compatible skill/plugin or add an explicitly read-only skill-catalog bridge that cannot mutate policy or grant approvals.

Do not use a skill as an entitlement or security mechanism. Free/Pro/Team enforcement remains server-side.
