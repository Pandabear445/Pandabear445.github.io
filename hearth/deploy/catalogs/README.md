# App store templates

Staging copies of Hearth's entries for the app stores built into home-server systems and self-hosting panels.
Each one runs the published image, `ghcr.io/pandabear445/hearth:<version>` (linux/amd64 and linux/arm64), made by
`.github/workflows/hearth-image.yml` from a `hearth-v<version>` tag. None of them builds anything from source.

| Store | Files here | Where it goes |
|---|---|---|
| Unraid Community Apps | `unraid/hearth.xml`, `unraid/ca_profile.xml` | This public repository, registered at ca.unraid.net/submit |
| CasaOS / ZimaOS | `casaos/docker-compose.yml` | `Apps/Hearth/docker-compose.yml` in IceWhaleTech/CasaOS-AppStore |
| Umbrel | `umbrel/hearth/` | `hearth/` in getumbrel/umbrel-apps |
| Dokploy | `dokploy/hearth/` | `blueprints/hearth/` in Dokploy/templates |
| Coolify | `coolify/hearth.yaml` | `templates/compose/hearth.yaml` in coollabsio/coolify (the logo goes in `public/svgs/hearth.svg`) |

They all keep the protections of `docker-compose.yml` that the platform allows: Hearth runs as uid 1000 on a
read-only filesystem with no Linux capabilities, can't gain any, and has a capped process count. Unraid's template
can't run a second container, so Hearth starts there as root only long enough to hand `/data` to uid 1000, then
drops to that user for good with nothing left (`deploy/docker-entrypoint.sh`); it gets exactly the four
capabilities that takes (CHOWN, DAC_READ_SEARCH, SETUID, SETGID).

## Three things every operator has to know

1. **Hearth needs https.** Browsers only allow its in-browser encryption and the microphone on a secure page, so
   plain `http://<lan-ip>:<port>` doesn't work. Either keep Hearth's own HTTPS on (the default: a certificate it
   makes itself, so browsers warn once and you click through), or use the platform's https address and set
   `HTTPS=false`. The templates already pick the right one:
   - Unraid and CasaOS: Hearth's own HTTPS on port 3000 (`https://<server>:3000`). Put the server's LAN address
     or name in `PUBLIC_HOSTS` so the certificate names it.
   - Umbrel: `requiresHttps: true`, so Umbrel opens it over https (umbrelOS 2.0 or newer); Hearth speaks plain
     http on the private app network.
   - Dokploy and Coolify: their proxy serves https. Give the service your own domain with a certificate (Let's
     Encrypt). The generated `traefik.me` or `sslip.io` addresses are plain http and won't work.
2. **Friends outside your home network need a way in.** A domain pointed at a VPS, or a tunnel: Cloudflare
   Tunnel or Tailscale Funnel both give an https address without opening ports. Behind any proxy or tunnel, set
   `HTTPS=false` and `TRUST_PROXY` to the proxy's address or subnet, so everyone keeps their own address for bans
   and sign-in limits (never a number, unless nothing can reach Hearth's port except through the proxy). The
   README's [VPS and domain section](../../README.md#on-a-vps-with-a-domain-recommended-for-always-on) has the
   whole setup. On Umbrel, turn off "Require Umbrel login" for Hearth (its settings) once your own account exists,
   or friends can't get past Umbrel's sign-in.
3. **The first account to sign up becomes the owner.** Open it and sign up right after installing, before you
   share the address. Then decide who else may sign up (Admin → Registration & Terms: open, a code, or closed).
   Dokploy and Coolify put Hearth straight onto a public domain, and a new certificate shows up in public
   certificate logs within minutes, where bots look for fresh sites. So those two templates make a random
   registration code at install (`REGISTRATION_CODE`; Dokploy: the service's Environment tab; Coolify:
   `SERVICE_PASSWORD_REGISTRATION` under Environment Variables): sign up with it, and nobody without it can sign up
   first. To reserve ownership for a name of your choice instead, also set `ADMIN_USERS` (README, settings table).
   On a VPS with `deploy/compose.image.yml`, put `REGISTRATION_CODE=<something>` in `.env` before the first
   `docker compose up -d` for the same reason.

Calls go directly between people, or through a TURN relay when a network blocks that, so they don't need extra
ports for most people. If some friends can join voice but nobody hears them, they need a relay: README, "Calls not
connecting for some people?". Group video works best with up to about 4 to 6 cameras.

## Submitting

Test-install each one on the real platform first (Umbrel on an arm64 device too): install, open it in a browser,
sign up, send a message and an image, join a voice channel from a second device, restart the app, and check that
everything is still there.

- **Unraid Community Apps.** CA reads templates from a public repository: the maintainer profile has to be
  `ca_profile.xml` with a non-empty `<Profile>`. If the submission form wants the templates at the root of a
  repository, use a small separate repository (for example `hearth-unraid`) holding these two files. Validate and
  scan it at https://ca.unraid.net/submit. The repository must carry an OSI-approved license (it's MIT: `LICENSE`).
- **CasaOS / ZimaOS.** Fork IceWhaleTech/CasaOS-AppStore, copy `casaos/docker-compose.yml` to
  `Apps/Hearth/docker-compose.yml`, add `icon.png` and a screenshot or two as their docs ask (docs/quick-start,
  docs/specs), run `./scripts/build_dist.sh` and open a pull request.
- **Umbrel.** Fork getumbrel/umbrel-apps and copy `umbrel/hearth/` (with its empty `data/.gitkeep`) to `hearth/`.
  Follow their `AGENTS.md` and `.agents/skills/umbrel-package-app`: pin the image with its multi-arch digest
  (`ghcr.io/pandabear445/hearth:<version>@sha256:<digest>`, from `docker buildx imagetools inspect`), check the
  manifest `port` (3297) isn't taken, run `npm run lint:apps -- hearth --check-images`, test through
  `umbrel-test-app`, open the pull request, then set `submission:` to its address. Keep `gallery: []` and no icon:
  screenshots and the logo go in the pull request description, and Umbrel's team hosts them.
- **Dokploy.** Fork Dokploy/templates, copy `dokploy/hearth/` to `blueprints/hearth/`, run
  `node build-scripts/generate-meta.js --check`, and test it from the pull request's preview (Base64 import into a
  Compose service).
- **Coolify.** Fork coollabsio/coolify, copy `coolify/hearth.yaml` to `templates/compose/hearth.yaml` and
  `../../public/favicon.svg` to `public/svgs/hearth.svg`, test it as a Docker Compose resource, and open the pull
  request against their default branch.
- **PikaPods** (hosted, revenue sharing with some authors): once these work, email them the image name and this
  folder.

## On every release

1. Tag `hearth-v<version>` (the version in `package.json`). The image workflow checks they match, scans the image
   and publishes `<version>`, `<major.minor>` and `latest`.
2. Change `1.29.0` to the new version in every file in this folder, in `deploy/compose.image.yml`, and in
   Umbrel's digest. `test/catalogs.test.js` fails until they all agree with `package.json`.
3. Update each store: CasaOS `version` and `update_at`, Umbrel `version` and `releaseNotes`, Dokploy `version`.
   Unraid reads the template from this repository, so pushing it is enough. Open the update pull requests.
