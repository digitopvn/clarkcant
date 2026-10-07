# ADR-004 — Desktop packaging for signed releases (proposal)

> English (default) · [Tiếng Việt](adr-004-desktop-packaging.vi.md)

**Status: proposed, not decided.** This note scopes the packaging spike in #508 step 1. Nothing here is built. The
spike's measurements decide; this note says what to measure and what we would choose if the measurements come out as
expected. Coordinate Linux and Omarchy with #193.

## Context

- The desktop app (`apps/desktop`) is an unpackaged, thin Electron shell. `main.mjs` sets the icon at runtime "because
  nothing packages this app yet".
- The runtime is a separate Node process. It runs TypeScript directly through Node type stripping
  ([installation](../installation.md)). It owns background work, so closing the window must not stop it.
- Today the only update path is `git pull` plus setup. There are no tags, releases or self-updater ([releases](../releases.md)).
- #508 requires these properties of a release:
  - side-by-side, immutable versioned payloads: running Clark never overwrites its live tree;
  - a per-user install by default, not per-machine or admin;
  - signed artifacts;
  - activation at a safe boundary, never by killing useful work.

Every packaging format below has to carry two things: the Electron shell, and the runtime with a Node that can run it.

## Windows: MSIX + App Installer, or Squirrel.Windows

**MSIX with App Installer** (preferred if it keeps every Clark capability):

- Its strengths:
  - OS-managed install, update and uninstall;
  - per-user;
  - differential updates;
  - update settings in the `.appinstaller` file (check on launch, background checks, prompting);
  - a signed package identity that IT policy (AppLocker, Intune) understands.
- Its risks, which the spike must measure:
  1. **Background runtime lifetime.** Does the runtime keep running after the window closes and at sign-in? How does
     an App Installer update treat a running package: deferral, or forced shutdown? A forced shutdown of live work
     would break the activation invariant.
  2. **File system and registry virtualization.** Writes under `AppData` may be redirected into the package's private
     store. The Clark data directory, Pi's configuration, and files shared with WSL, Docker or Podman must land where
     other tools can see them.
  3. **Child processes.** Shells, `git`, Docker, Podman and browser drivers that Clark starts inherit the package
     identity and container rules. Each must still work.
  4. **A command-line entry point.** An app execution alias for `clark`.
  5. **Signing.** The manifest's `Publisher` must match the SSL.com certificate subject exactly.

**Squirrel.Windows** (fallback):

- Its strengths:
  - per-user install under `%LocalAppData%`;
  - side-by-side `app-<version>` directories, which match the side-by-side invariant;
  - Electron's built-in `autoUpdater` on Windows;
  - no container, so no virtualization surprises.
- Its costs:
  - an older installer experience;
  - updates applied on the next start, by the updater;
  - Clark owns more of the update and rollback logic;
  - arm64 support must be confirmed in the spike.

**Proposal:** run the five MSIX checks above on x64 and arm64. Choose MSIX if none is a hard break. Choose Squirrel
per-user if any of them is. Per-machine or admin installation is not a default in either case.

## macOS: app bundle, Developer ID, notarization

- Ship a `Clark.app` bundle:
  - in a `.dmg` for first install;
  - in a `.zip` for updates, which is what Electron's Squirrel.Mac-based `autoUpdater` consumes.
- Signing:
  - sign with Developer ID and the hardened runtime;
  - sign nested code, including the Node binary the runtime uses;
  - notarize with `notarytool`, then staple ([release signing](../release-signing.md)).
- The runtime runs as a per-user LaunchAgent, so closing the window does not stop work. The spike must confirm how a
  bundle update replaces the payload while the LaunchAgent still points at the old version. The update must stage
  beside it, and activation must switch generations only at a safe boundary.

**Proposal:** a `.dmg` and a `.zip`, signed and notarized. Updates are applied by the UpdateService (#508 step 3) using
native primitives, never by an Electron-only code path.

## Linux and Omarchy

Electron has no built-in Linux updater, so updates follow how Clark was installed. These are the candidates; #193
decides which ships first:

- **pacman package** in a Clark-owned, GPG-signed repository. This matches Omarchy's
  `SigLevel = Required DatabaseOptional`. The runtime is a `systemd --user` service, and pacman owns updates.
- **AUR `clarkcant-bin`**: a recipe that points at immutable, checksummed release assets.
- **Omarchy package repository**: if Clark is accepted there, its own signing and promotion apply.
- **AppImage or portable archive** for other distributions: immutable artifact, `SHA256SUMS` and a detached GPG
  signature. Updates are staged by the UpdateService.

**Proposal:** ship an AppImage first (portable, no repository needed) and a signed pacman package. Add the AUR recipe
once release assets are stable. Defer to #193 on the Omarchy repository and on the `systemd --user` layout.

## Build tooling

Candidates are Electron Forge (makers for MSIX, Squirrel, DMG, ZIP and others) and electron-builder. The spike should
pick the one that:

- produces every target above from one configuration;
- signs through the commands in [release signing](../release-signing.md) rather than its own credential handling;
- passes the repository's supply-chain policy (exact pins, release age).

## Open questions

1. How should the runtime's Node be shipped: a pinned Node runtime bundled beside Electron, or Electron's Node through
   `ELECTRON_RUN_AS_NODE`? Does the Electron in use support the type stripping the runtime relies on?
2. Under MSIX, can the runtime outlive the window and survive an update without being force-closed?
3. Which data directory does each format use, and does a packaged install migrate an existing source install's data?
4. Which arm64 targets are in scope for the first signed release: Windows arm64, Linux arm64?
5. Is there one signed release-metadata file per channel, and which key signs it: GPG, or a separate key?
6. Which format provides the Omarchy notification identity that #340 needs?

## Decision

None yet. The spike records its measurements here and moves this note from **proposed** to **accepted** with the
chosen formats. Until then, docs describe these formats as planned, not shipped.
