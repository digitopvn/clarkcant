# Release signing: maintainer setup

> English (default) · [Tiếng Việt](release-signing.vi.md)

What a maintainer prepares so ClarkCant releases can be signed on Windows, macOS and Linux. **No signing stage exists in
CI yet.** `.github/workflows/release.yml` only plans and verifies ([releases](releases.md)). This guide records what the
signing stages will need, so credentials can be enrolled and tested before those stages land.

Every value below is a placeholder written as `<LIKE_THIS>`. Never paste a real credential into an issue, a pull
request, a commit, a log or a chat. Store credentials only as GitHub environment secrets.

## GitHub: variables, secrets, environments

| Kind | Holds | Visible in logs? | Examples |
|---|---|---|---|
| Variable (`vars.*`) | identifiers that are not sensitive | yes | Apple team ID, App Store Connect key ID and issuer ID, GPG key fingerprint, signing mode `sandbox`/`product` |
| Secret (`secrets.*`) | anything that grants signing power | masked, never printed | SSL.com password and TOTP secret, `.p12` and its password, `.p8` API key, GPG private key and passphrase |

Put signing secrets in **environments**, not at repository level:

- `release-test`: TEST and sandbox credentials. It may run on `dev` and on manual runs.
- `release-prod`: production credentials. Deployment branches are limited to `main` and `dev`, and a required
  reviewer must approve each run.

A secret reaches only the one step that signs, through `env:`. Signing tools read it from the environment; never put it
on a command line that a log could echo. Build and test steps never see a signing secret.

## TEST before PROD

Every signer is wired twice. Run the TEST path end to end and check the verification below before anyone enrolls
production credentials in `release-prod`:

- SSL.com: eSigner sandbox (`-mode sandbox`). Its signatures are not trusted by end users. The point is to prove the
  pipeline.
- Apple: sign with the Developer ID certificate, and submit a build from a test branch for notarization.
- Linux: sign with a throwaway GPG key, and verify against that key only.

## Windows: Authenticode with SSL.com eSigner

Prerequisites:

1. An SSL.com code-signing certificate (OV or EV) issued to the publisher name Clark ships under, enrolled in eSigner.
2. eSigner automation set up for the signing account, which yields the TOTP secret. Without it, signing times out
   waiting for a code.
3. If the account holds several certificates, the credential ID of the one to use.

| Name | Kind | Value |
|---|---|---|
| `SSL_COM_MODE` | variable | `sandbox` in `release-test`, `product` in `release-prod` |
| `SSL_COM_USERNAME` | secret | `<SSL_COM_USERNAME>` |
| `SSL_COM_PASSWORD` | secret | `<SSL_COM_PASSWORD>` |
| `SSL_COM_TOTP_SECRET` | secret | `<SSL_COM_TOTP_SECRET>` |
| `SSL_COM_CREDENTIAL_ID` | secret, optional | `<SSL_COM_CREDENTIAL_ID>` |

The preferred path is eSigner CKA (Cloud Key Adapter) with Microsoft `signtool`, on `windows-latest`, in one job:

```powershell
# install eSigner CKA for the current user, silently, into $env:CKA_DIR
& "$env:CKA_DIR\eSignerCKATool.exe" config -mode "$env:SSL_COM_MODE" -user "$env:SSL_COM_USERNAME" `
  -pass "$env:SSL_COM_PASSWORD" -totp "$env:SSL_COM_TOTP_SECRET" -key "$env:RUNNER_TEMP\master.key" -r
& "$env:CKA_DIR\eSignerCKATool.exe" unload
& "$env:CKA_DIR\eSignerCKATool.exe" load
# read the loaded certificate's thumbprint from Cert:\CurrentUser\My, then:
signtool sign /fd sha256 /tr http://ts.ssl.com /td sha256 /sha1 <THUMBPRINT> <FILE>
```

- Run `config`, `unload` and `load` in that order, in the same job.
- Sign every executable Clark ships, then the installer or package.
- Use SHA-256 and an RFC 3161 timestamp (`/tr` with `/td sha256`). The timestamp keeps the signature valid after the
  certificate expires.
- On failure, upload the CKA logs as an artifact only after removing anything that looks like a credential.

## macOS: Developer ID and notarization

Prerequisites:

1. An Apple Developer Program membership.
2. A **Developer ID Application** certificate, exported with its private key as a `.p12`.
3. An **App Store Connect API key** (`.p8`) with access to notarization. This is the preferred path. An app-specific
   password for an Apple ID is the fallback only.

| Name | Kind | Value |
|---|---|---|
| `APPLE_TEAM_ID` | variable | `<APPLE_TEAM_ID>` |
| `APPLE_API_KEY_ID` | variable | `<APPLE_API_KEY_ID>` |
| `APPLE_API_ISSUER_ID` | variable | `<APPLE_API_ISSUER_ID>` |
| `APPLE_DEVELOPER_ID_P12_BASE64` | secret | base64 of `<developer-id.p12>` |
| `APPLE_DEVELOPER_ID_P12_PASSWORD` | secret | `<P12_PASSWORD>` |
| `APPLE_API_KEY_P8_BASE64` | secret | base64 of `<AuthKey_XXXX.p8>` |

In the job:

1. Import the `.p12` into an **ephemeral keychain**. Create it in the job's temporary directory, unlock it, and delete
   it at the end of the job, even on failure.
2. Sign the app and all nested code with the hardened runtime and only the entitlements Clark needs.
3. Notarize: `xcrun notarytool submit <APP.zip> --key <AuthKey.p8> --key-id <APPLE_API_KEY_ID> --issuer <APPLE_API_ISSUER_ID> --wait`.
4. Staple the ticket: `xcrun stapler staple <Clark.app>`.

## Linux and Omarchy: GPG and integrity

Prerequisites:

1. A dedicated ClarkCant release GPG key, used for nothing else. Keep the primary key offline and sign with a signing
   subkey.
2. The public key and fingerprint published where users and packagers can check them.

| Name | Kind | Value |
|---|---|---|
| `RELEASE_GPG_FINGERPRINT` | variable | `<FINGERPRINT>` |
| `RELEASE_GPG_PRIVATE_KEY` | secret | ASCII-armoured signing subkey, `<…>` |
| `RELEASE_GPG_PASSPHRASE` | secret | `<PASSPHRASE>` |

How each package type is signed depends on where it is published:

- **Clark-owned pacman repository:** sign each `.pkg.tar.zst` with a detached binary signature
  (`gpg --detach-sign --no-armor`, which gives `.sig`). Sign the repository database with `repo-add --sign`. Omarchy's
  pacman policy requires package signatures.
- **AUR `clarkcant-bin`:** the PKGBUILD pins immutable release assets with exact `sha256sums`, and lists the release key
  in `validpgpkeys`. The AUR distributes the recipe, not Clark's binaries.
- **Omarchy package repository:** if Clark is accepted there, follow that repository's signing and promotion instead of
  adding a second updater.
- **AppImage and portable archives:** publish the immutable artifact, a `SHA256SUMS` file and a detached signature of
  that file.

Which of these ships first is decided with #193.

## Verification checklist

Run on the produced artifacts, in CI and once by hand on a clean machine:

- [ ] Windows: `signtool verify /pa /all /v <FILE>` passes for the installer and every shipped executable. The
      signature names the expected publisher and carries an RFC 3161 timestamp.
- [ ] macOS: `codesign --verify --deep --strict --verbose=2 <Clark.app>` passes.
- [ ] macOS: `xcrun stapler validate <Clark.app>` passes.
- [ ] macOS: `spctl --assess --type execute --verbose <Clark.app>` reports `source=Notarized Developer ID`.
- [ ] Linux: `gpg --verify <file>.sig <file>` passes against the published fingerprint.
- [ ] Linux: `pacman-key --verify` passes for each package.
- [ ] Linux: `sha256sum -c SHA256SUMS` matches.
- [ ] Each artifact's SHA-256 matches the release metadata.
- [ ] No published asset is ever replaced.
- [ ] The TEST path passed before PROD credentials were enrolled.
- [ ] No log, artifact or summary contains a credential.

## What missing credentials block

Missing credentials block **only signed publishing**: the build and sign matrix, and verifying production signatures.
They do not block:

- the release contract;
- the plan and quality-gate workflow;
- release notes;
- the changelog;
- packaging spikes;
- implementation of the update service.

| Missing | Blocks |
|---|---|
| SSL.com eSigner enrollment and TOTP secret | signed Windows artifacts |
| Apple Developer ID certificate and API key | signed and notarized macOS artifacts |
| Release GPG key; the pacman repository vs AUR vs Omarchy repository choice (#193) | signed Linux artifacts and repository metadata |
| Real Windows, macOS and Omarchy machines | installed-platform smoke (#508, step 8) |
