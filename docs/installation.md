# Installing and onboarding ClarkCant

> English (default) · [Tiếng Việt](installation.vi.md)

This document explains how to install a ClarkCant node on macOS, Linux or Windows, running directly
on Node.js or in Docker, including on a VPS with a domain name and HTTPS. Every path goes through
the same interactive onboarding step: `tools/setup.mjs`.

> This is still a bootstrap build, not a release. What works and what does not yet work is
> recorded in the [README](../README.md) and the [conformance table](conformance-traceability.md).

## Requirements

| Component | Running locally | Running with Docker | Notes |
|---|---|---|---|
| Node.js 22.19+ (24 recommended) | required | needed to run onboarding | The runtime runs TypeScript directly |
| pnpm 12 via Corepack | required | no | The installer runs `corepack enable` itself |
| git | needed to clone | needed to clone | |
| Docker + Compose plugin 2.24+ | no | required | |

How to install Node.js per platform (the installer does not install Node or Docker itself, because
that is the machine owner's decision):

- **macOS:** `brew install node@24`, or fnm/nvm, or the installer from nodejs.org.
- **Linux:** `curl -fsSL https://fnm.vercel.app/install | bash && fnm install 24`, or your distribution's Node 24 package.
- **Windows:** `winget install OpenJS.NodeJS.LTS`, then open a new terminal.

## Quick install with one command

macOS / Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/digitopvn/clarkcant/main/tools/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/digitopvn/clarkcant/main/tools/install.ps1 | iex
```

The installer checks git and the Node version, clones the repository into `./clarkcant` (change it
with the `CLARKCANT_DIR` variable, pick a branch/tag with `CLARKCANT_REF`), enables pnpm through
Corepack and then hands over to onboarding. If you run the installer inside an existing checkout,
it uses that checkout.

It is best to read the script before running it: download it, read it, then run `sh install.sh`.

## From an existing checkout

```sh
git clone https://github.com/digitopvn/clarkcant
cd clarkcant
node tools/setup.mjs          # or: pnpm onboard (once pnpm is available)
```

## Onboarding steps

Onboarding has five steps and writes nothing until the summary step; press `Ctrl+C` anywhere to
leave the machine exactly as it was.

1. **How to run the node**: `local` (Node.js on this machine), `docker` (Docker, loopback only) or
   `docker-public` (Docker behind Caddy with automatic HTTPS, for a VPS with a domain name).
2. **Machine check**: Node, pnpm/Corepack, git, Docker Compose. If a component required for the
   chosen run mode is missing, it stops and changes nothing.
3. **Model that answers the conversation**: DeepSeek, Google Gemini, OpenAI, OpenRouter or "no
   model yet". Provider and model must go together; the node does not pick a model on your behalf.
   The API key is entered hidden and is never shown again anywhere; leave it blank to keep the
   existing key or add one later.
4. **Identity and storage**: node label, gateway port (not asked in docker-public because Caddy
   takes 80/443), data directory (local) or domain name (docker-public).
5. **Summary**: confirm, then write `.env` (mode `600` on macOS/Linux), then optionally install
   dependencies and the web client (`pnpm install`, `pnpm run build`) or build the Docker image.
   Finally it prints the exact command to start the node.

Re-running onboarding is safe: values in the existing `.env` are used as defaults, and the other
lines and comments in the file are kept as they are.

### Non-interactive (CI, VPS bootstrap scripts)

```sh
DEEPSEEK_API_KEY=... node tools/setup.mjs --yes --mode docker \
  --provider deepseek --model deepseek-v4-flash --label "vps clark"
```

With `--yes`, the key is read from the provider's environment variable so it never has to appear
on the command line. `node tools/setup.mjs --help` lists every option; `--dry-run` only prints the
summary.

## Running locally

```sh
node apps/runtime/src/main.ts --data-dir ./.data --label "my clark" --port 8765
```

The node only serves the gateway (`/health`, the API, the widget runtime); it does not serve the
interface. Check it with `curl http://127.0.0.1:8765/health`, then open the web client in another
terminal:

```sh
pnpm dev:web    # opens http://127.0.0.1:5173/?gateway=http://127.0.0.1:8765
```

The bearer token is in `./.data/identity.json` (the `localToken` field). By default the node binds
only to loopback and refuses to bind a public address without `--allow-public-bind`.

To work on the desktop shell, one command starts the node, the Vite dev server and Electron
together, and the window reloads when the renderer changes:

```sh
pnpm dev:desktop --data-dir ./.data [--env-file <path>]
```

Stop it with Ctrl+C; it stops all three.

## Running with Docker

Templates: [`docker-compose.yml`](../docker-compose.yml),
[`docker/compose.public.yml`](../docker/compose.public.yml), [`docker/Caddyfile`](../docker/Caddyfile).

```sh
node tools/setup.mjs --mode docker
docker compose up -d
docker compose exec clarkcant cat /data/identity.json   # bearer token
docker compose logs -f clarkcant
```

- The port is only published on `127.0.0.1`. The node inside the container binds `0.0.0.0` because
  the container's loopback is not reachable from the host; it is the publish address that keeps
  the node private.
- `.env` is read at run time through `env_file` and never ends up in the image (`.dockerignore`
  excludes it).
- Data (identity, database, blobs, transcripts) lives in the `clarkcant-data` volume. Losing the
  volume means losing the node's identity; back it up before deleting or moving it.

### VPS with a domain name and HTTPS

1. Point the domain's DNS record at the server's IP; open ports 80 and 443.
2. Run `node tools/setup.mjs --mode docker-public` (asks for the domain name and stores it in
   `CLARKCANT_DOMAIN`).
3. Start:

   ```sh
   docker compose -f docker-compose.yml -f docker/compose.public.yml up -d
   ```

This overlay removes the node's port from the host and only allows access through Caddy (TLS
issued and renewed automatically). Every route except `/health` still requires the bearer token;
TLS protects the token in transit.

## Updating

```sh
git pull
node tools/setup.mjs            # keeps .env, reinstalls dependencies or rebuilds the image
docker compose up -d --build    # with Docker
```

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `corepack` not found | Node.js 25+ no longer bundles Corepack: `npm install -g corepack`. |
| `corepack enable` fails | It needs write access to the Node directory: run it with `sudo` (macOS/Linux) or an administrator PowerShell. |
| `pnpm install` refuses a new package | The `minimumReleaseAge` policy (24 hours) in `pnpm-workspace.yaml`, not a network error. |
| The node reports the model is not reachable | The provider's key is missing from `.env`; re-run onboarding and enter the key. |
| `Refusing to bind ...` | The node is running directly with a public `--host`. Use Docker/Caddy, or put your own TLS in front and add `--allow-public-bind`. |
| Port 8765 is already in use | Find the old process (`lsof -i :8765`, `ss -ltnp`, `netstat -ano` on Windows) and stop it, or change the port during onboarding. |
| Caddy cannot obtain a certificate | DNS does not point to the right place yet, or ports 80/443 are blocked; see `docker compose logs caddy`. |
| Windows blocks running scripts | `powershell -ExecutionPolicy Bypass -File tools\install.ps1`. |
