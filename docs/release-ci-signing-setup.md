# Release CI signing setup for maintainers

> English (default) · [Tiếng Việt](release-ci-signing-setup.vi.md)
>
> Status: preparation guide for issue #508. This file contains names and placeholders only. **Never commit real credentials, certificate private keys, TOTP seeds, passwords, or recovery codes.**

This guide lists what a human maintainer must prepare before ClarkCant can publish signed stable releases from **main** and signed beta prereleases from **dev**.

The target workflow is intentionally small:

    push/merge to main -> SemVer stable release
    push/merge to dev  -> SemVer beta prerelease
                         -> build per platform
                         -> sign/notarize
                         -> verify
                         -> publish immutable GitHub Release

The implementation belongs to #508. This document is the provisioning checklist.

## Security rules

- Sensitive values belong in GitHub Actions encrypted secrets, never repository variables, workflow YAML, issues, shell history, or committed files.
- Prefer dedicated automation credentials.
- Prefer workflow-scoped GITHUB_TOKEN for tags/releases unless implementation proves a separate token is needed.
- Test signing in sandbox/test mode before production.
- Verify signatures after signing; command success alone is insufficient.
- Never expose signing secrets to untrusted pull-request code.
- Keep public identity information such as certificate subject, fingerprint, Team ID, and bundle ID as non-secret variables when useful.
- Rotation/revocation must not require application-code changes.

## GitHub preparation

When #508 is ready:

- create protected **dev** from **main**;
- keep the normal repository verification gates on both branches;
- create a protected GitHub Environment, suggested name **release-signing**;
- restrict production secrets to the intended release workflow/branches.

Suggested non-secret variables:

| Variable | Purpose |
| --- | --- |
| CLARK_RELEASE_STABLE_BRANCH = main | Stable channel |
| CLARK_RELEASE_BETA_BRANCH = dev | Beta channel |
| WINDOWS_SIGNING_EXPECTED_SUBJECT | Verify Authenticode publisher |
| MACOS_TEAM_ID | Apple signing/notarization identity |
| MACOS_BUNDLE_ID | Packaged app identity |
| LINUX_RELEASE_GPG_FINGERPRINT | Verify release signing key |
| SSL_COM_ESIGNER_ENVIRONMENT = TEST or PROD | eSigner environment; TEST first |

## Windows — SSL.com eSigner / Authenticode

### Human prerequisites

Prepare an SSL.com code-signing certificate that supports eSigner:

1. active SSL.com account;
2. organization/identity validation complete;
3. certificate enrolled in eSigner;
4. eSigner Authenticator configured and automation TOTP secret obtained;
5. pipeline tested against SSL.com **TEST** first;
6. production switched to **PROD** only after end-to-end sign + verify succeeds.

#508 currently prefers **eSigner CKA + signtool.exe** because CKA exposes the cloud key through Windows CNG/KSP and fits native Authenticode tooling. CodeSignTool remains a fallback if implementation evidence favors it.

### GitHub encrypted secrets

| Secret | Required | Notes |
| --- | --- | --- |
| SSL_COM_ESIGNER_USERNAME | yes | Prefer dedicated automation/service account |
| SSL_COM_ESIGNER_PASSWORD | yes | eSigner password |
| SSL_COM_ESIGNER_TOTP_SECRET | yes | Automation TOTP seed |
| SSL_COM_ESIGNER_CREDENTIAL_ID | conditional | Mainly for CodeSignTool when cert selection is ambiguous |

Do not persist generated CKA master.key or certificate-store exports as long-lived secrets unless the final integration explicitly requires it.

Record outside secrets:

- certificate subject/publisher name;
- serial number;
- SHA-256 thumbprint if appropriate to pin;
- expiry/renewal date;
- responsible maintainer;
- approved RFC3161 timestamp endpoint.

CI must verify final artifacts with Windows tools such as **Get-AuthenticodeSignature** and **signtool verify /pa /v**, including expected publisher identity and timestamp.

## macOS — Developer ID + notarization

Prepare:

1. active Apple Developer Program membership;
2. Developer ID Application certificate + private key;
3. Developer ID Installer only if Clark later ships a PKG;
4. Apple Team ID;
5. a **Team App Store Connect API key** usable by notarytool;
6. API key ID, issuer ID, and private P8;
7. final bundle identifier.

Use a Team API key for notarization. Apple documents that Individual App Store Connect API keys cannot use notaryTool.

Recommended encrypted secrets:

| Secret | Required |
| --- | --- |
| APPLE_DEVELOPER_ID_P12_BASE64 | yes |
| APPLE_DEVELOPER_ID_P12_PASSWORD | yes |
| APPLE_NOTARY_API_KEY_ID | yes |
| APPLE_NOTARY_API_ISSUER_ID | yes |
| APPLE_NOTARY_API_PRIVATE_KEY_P8_BASE64 | yes |
| APPLE_DEVELOPER_ID_INSTALLER_P12_BASE64 | only if shipping PKG |
| APPLE_DEVELOPER_ID_INSTALLER_P12_PASSWORD | only if shipping PKG |

Keep MACOS_TEAM_ID and MACOS_BUNDLE_ID as non-secret variables.

The CI keychain must be ephemeral. Version entitlements/hardened-runtime/package configuration in Git, not as secrets.

Verification must include codesign verification, Gatekeeper assessment, notarization acceptance, and stapler validation. Fail closed on any notarization/stapling failure.

## Linux / Omarchy / Arch

Linux has no single universal signing system equivalent to Authenticode or Apple Developer ID. Trust depends on distribution.

For ClarkCant, **Linux does not need signing** is the wrong assumption.

Omarchy is Arch/pacman-based. Its current pacman configuration requires trusted repository package signatures with **SigLevel = Required DatabaseOptional**, and the Omarchy package repository builds and signs packages.

If Clark owns a pacman binary repository:

1. create a dedicated OpenPGP release-signing key hierarchy;
2. keep the primary key offline;
3. give CI a dedicated limited signing subkey;
4. publish/verify the public fingerprint through an authenticated Clark channel;
5. sign each .pkg.tar.zst and publish detached .sig files;
6. sign repository metadata according to the repository design chosen in #193;
7. document key rotation.

If Clark is accepted into the official Omarchy package repository, use **their** build/sign/promote system instead of placing Clark's private signing key there.

For AUR clarkcant-bin, AUR distributes a PKGBUILD recipe; it should consume immutable Clark release assets and exact checksums. AUR is not itself Clark's binary signing system.

Conditional Clark-owned Linux secrets:

| Secret | Notes |
| --- | --- |
| LINUX_RELEASE_GPG_PRIVATE_KEY_BASE64 | Dedicated CI signing subkey only |
| LINUX_RELEASE_GPG_PASSPHRASE | Passphrase for that subkey |

Non-secret: LINUX_RELEASE_GPG_FINGERPRINT, public-key location, expiry/rotation date.

Portable/AppImage artifacts should ship immutable bytes, SHA256SUMS, and a detached signature over release/checksum metadata. UpdateService verifies them before activation.

## Cross-platform release metadata

Besides OS-native signatures, #508 proposes signed cross-platform release metadata.

A simple first design:

- reuse the dedicated Clark OpenPGP release-signing subkey;
- sign release.json and/or SHA256SUMS;
- pin the expected public fingerprint in the trusted updater path;
- rotate via an explicit signed trust transition.

Do not use only the Windows or Apple identity as the cross-platform trust root.

## Version/channel preparation

Before automatic publishing:

1. choose the first canonical public Clark version;
2. make every target derive from that one version source;
3. create/protect dev;
4. confirm Conventional Commit release rules in #508;
5. configure dev as a SemVer prerelease line producing x.y.z-beta.N;
6. no release-worthy commit means no release;
7. never reuse a published version/tag.

## First signing dry run

Before push-triggered publishing:

**Windows**
- use eSigner TEST;
- build and sign one representative artifact;
- verify publisher identity;
- retain no production credential material.

**macOS**
- sign with Developer ID;
- notarize using the Team API key;
- staple and validate;
- test Gatekeeper on a clean machine.

**Linux/Omarchy**
- use a test signing subkey/repository or isolated signing fixture;
- verify signatures;
- install on a disposable target with signature checking enabled.

**Aggregate**
- generate the future release manifest/checksums;
- sign them;
- download artifacts in a separate verification job/machine;
- verify everything from scratch.

Only after these pass should the main/dev production workflow receive production signing secrets.

## What the maintainer must provide later

Provide through the agreed secure channel, **not in GitHub issues or public chat**.

### SSL.com

- eSigner automation username;
- password;
- TOTP secret;
- optional Credential ID if chosen integration needs it;
- confirmation enrollment/validation is complete;
- expected publisher subject;
- TEST or PROD decision.

### Apple

- Developer ID Application P12 + password;
- Team ID;
- Team App Store Connect API key ID;
- issuer ID;
- private P8;
- bundle ID;
- optional Developer ID Installer P12/password if shipping PKG.

### Linux

Depending on distribution:

- dedicated CI release-signing subkey + passphrase;
- expected full fingerprint;
- public-key publication location;
- or confirmation that Omarchy/another downstream repository will build/sign from immutable Clark release sources and Clark should not hold a pacman signing key.

## Rotation / compromise

If a signing credential is lost or suspected compromised:

1. pause releases;
2. revoke/disable the vendor credential or subkey;
3. rotate the corresponding GitHub secret;
4. record affected signer/release range;
5. create replacement material outside the repo;
6. update expected public identity/fingerprint and updater trust transition;
7. repeat sandbox/sign/verify before production.

Never publish unsigned stable artifacts as a temporary workaround.

## Official references

- SSL.com eSigner CI/CD: https://www.ssl.com/how-to/integrating-esigner-with-ci-cd-pipelines-a-complete-setup-and-configuration-guide/
- Apple App Store Connect API keys: https://developer.apple.com/documentation/AppStoreConnectAPI/creating-api-keys-for-app-store-connect-api
- Apple notarytool authentication: https://developer.apple.com/documentation/technotes/tn3147-migrating-to-the-latest-notarization-tool
- Arch package signing: https://wiki.archlinux.org/title/Pacman/Package_signing
- Omarchy package repository: https://github.com/omacom/omarchy-pkgs
- semantic-release configuration: https://semantic-release.gitbook.io/semantic-release/usage/configuration
