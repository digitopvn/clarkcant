# feat(runtime): one resource and capability graph over local, package, peer and runtime capabilities

Labels: `enhancement` · Parent: #507 (Phase 2)

## Summary

Give the Main agent one way to ask "what could help with capability X?" over every source Clark already knows,
returning `CapabilityCandidate` records (`packages/contracts/src/capability-discovery.ts`) with provenance and
readiness, instead of one provider-specific search tool per source.

## Dependencies

- Phase 0 contracts (#507).
- Read-only inventory may proceed in parallel with #402.
- Runtime-provided plugins/skills/MCP inventories depend on Phase 1 adapters (`extension-inventory`, `skill-inventory`,
  `mcp-inventory` traits).
- Reuses #264 (peer capability summary) and the existing capability registry / package generations.
- Uses #433 Context Planner for progressive tool disclosure; does not dump inventories into every turn.

## Scope

- `CapabilityProvider` implementations for: granted capabilities, installed packages/capabilities, projects/host
  resources within approved roots, Pi skills/extensions, peer summaries, and (after Phase 1) runtime inventories.
- Relationships: resource provides capability, runtime hosts extension, capability requires connection, candidate
  requires reach, node owns resource, package generation serves capability. SQLite + typed indexes, no graph database.
- Local CLI discovery only inside host scope the person already approved.
- One host tool/capability for the Main agent to query the graph, bounded by `DiscoveryBudget`.

## Acceptance criteria

- [ ] Main Clark answers "what can help with X?" from local, package, peer (and runtime, once Phase 1 lands) sources
      through one query path.
- [ ] Every candidate carries provenance and readiness; none grants, enables or installs anything.
- [ ] A peer never learns more than its owner allowed (#264 boundary preserved).
- [ ] Discovery is bounded by budget and never scans outside approved roots.
- [ ] Voice, chat and slash command reach the same capability query.
- [ ] Focused tests plus `pnpm verify`; docs EN/VI updated.

## Non-goals

- External/Internet discovery (Phase 4).
- Acquiring or enabling candidates (Phase 3).
- A graph database or a second capability registry.
