# feat(discovery): Marketplace, directory, MCP/API and Internet discovery providers with verified acquisition

Labels: `enhancement` · Parent: #507 (Phase 4)

## Summary

Add external `CapabilityProvider`s whose candidates are untrusted metadata, resolved only into verifiable
`AcquisitionSource` forms (exact package, git commit over https, digested artifact, known MCP/WebMCP endpoint, OpenAPI
document, exact CLI package) and acquired only through the Phase 3 reach gate.

## Dependencies

- Phase 2 (graph) and Phase 3 (reach gate).
- **#194** owns the remote Marketplace DirectoryProvider/API; this issue wraps it as a provider, it does not build
  another catalog or installer.
- **#451** proves the public npm → Marketplace → install journey; reuse its evidence.

## Scope

- Marketplace provider over #194's API; configured private directories.
- MCP/WebMCP endpoint discovery; API/OpenAPI and CLI package discovery.
- Internet candidate discovery with provenance (`trust: unverified`), bounded by `DiscoveryBudget`.
- Resolution of web results into verifiable acquisition forms; anything that cannot be resolved stays an unverified
  suggestion and never an executable plan. Providers resolve git tags and branches to a full commit id and version
  ranges or `latest` to an exact version before offering a candidate; the contract refuses the unresolved forms.

## Acceptance criteria

- [ ] Untrusted discovery data can never directly become executable authority (e.g. `curl … | sudo bash` is refused).
- [ ] Every external candidate shows its origin and trust level.
- [ ] Acquisition runs through the existing install/connection/policy paths with digest/integrity verification.
- [ ] Discovery stops on a satisfactory candidate or a budget bound; no background crawling without a standing intent.
- [ ] Tests with fake registry/directory fixtures; live checks named as external gates; docs EN/VI.

## Non-goals

- A Clark-hosted artifact registry.
- Marketplace metadata as authority.
- Permanent Internet crawling.
