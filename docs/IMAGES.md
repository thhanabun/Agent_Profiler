# Build, share and run harness images

All interaction is through the CLI/TUI. Images use an OCI artifact manifest, a config containing the resolved profile/runtime requirements, and a `.agentpack` source layer. They are not Docker containers and cannot be launched with `docker run`.

## Build and run locally

Install/authenticate the native harness first. Images currently require the exact installed harness version, adapter SDK version, OS and architecture recorded at build time. No global harness installation is replaced. Native user/project configuration remains active.

Run `opencode models` to find an actual provider/model ID. Replace `provider/model` below; image builds require an explicit model reference. Claude profiles can use a native alias such as `sonnet`. Remote aliases may change behind the same reference.

```sh
node bin/subharness.mjs build implement --tag myname/builder:1.0.0 --model provider/model
node bin/subharness.mjs images
node bin/subharness.mjs inspect myname/builder:1.0.0
node bin/subharness.mjs run myname/builder:1.0.0 --cwd /path/to/project
```

`run <image>` opens a direct chat with that image, without an extra planner. Follow-ups reuse its native session. `run` without an image retains the original orchestrated local profile workflow. Use `team run` for an orchestrated image team.

The store defaults to `~/.subharness/images`; set `SUBHARNESS_IMAGE_STORE` or `--store <directory>` to relocate it. Mutable conversation state remains under the project's `.subharness` or `--state-dir`.

Builds are deterministic for the same source and recorded runtime/model references. Local tags cannot be overwritten with different content. Digests address exact manifests, and all metadata/source blobs are checked before use. Runtime or model environment overrides that conflict with a locked image are rejected; use an editable fork and rebuild instead.

## Derive a new image

```sh
node bin/subharness.mjs fork myname/builder:1.0.0 --to ./brand-builder --id brand-builder
# Edit profile.json, instructions and skill/plugin sources with your editor.
node bin/subharness.mjs build ./brand-builder --tag myname/brand-builder:1.0.0
node bin/subharness.mjs diff myname/builder:1.0.0 myname/brand-builder:1.0.0
```

The fork is a full editable copy. `image.parent.json` records the base digest, which is carried into the derived OCI metadata. Keep this sidecar and the base image in the store when rebuilding. A child must keep the parent's harness; model/instructions/skills/plugins can be changed. This first implementation flattens the resulting source into one layer, rather than merging filesystem layers at runtime.

The lock covers embedded source bytes. External package resolution is not implemented: bundled `package.json` files declaring runtime/optional dependencies are rejected. Dynamic imports, system tools, native hooks/project configuration and external services are outside this source lock. Prefer self-contained plugins and declare required local setup. Known private paths, credentials and runtime state are excluded, but authored ordinary source is not a general-purpose secret scanner.

## Push and pull through a registry

Install [ORAS CLI 1.3+](https://oras.land/docs/installation/) on PATH, or set `SUBHARNESS_ORAS_BIN` to its native executable. The app uses [ORAS copy](https://oras.land/docs/commands/oras_cp/) for OCI transport and its native registry credentials; it does not collect model/provider credentials.

Authenticate with the destination using ORAS's native prompt:

```sh
oras login ghcr.io
node bin/subharness.mjs push myname/brand-builder:1.0.0 --to ghcr.io/myname/brand-builder:1.0.0

# On the receiving machine, after installing this CLI and native prerequisites:
node bin/subharness.mjs pull ghcr.io/myname/brand-builder:1.0.0
node bin/subharness.mjs inspect ghcr.io/myname/brand-builder:1.0.0
node bin/subharness.mjs run ghcr.io/myname/brand-builder:1.0.0 --cwd /path/to/project
```

Names without a registry host default to `registry-1.docker.io`. For an existing custom credential config, pass `--registry-config <file>`. This revision was tested against an official local Distribution registry, not a hosted GHCR/Docker Hub account.

Pull resolves a remote tag once and downloads by digest, validates the permitted manifest/blob sizes and source archive, then exposes the image locally. It does not execute the downloaded image. First execution requires trust in the image digest. A digest identifies content; it is not proof of author identity or code safety.

Push refuses an already-existing remote tag with different content. Concurrent writers can race this check; configure registry-side immutable tags for that guarantee. Existing downloaded images remain accessible by digest. This does not undo project edits or migrate live conversations to another image version.

`--plain-http` is available only for loopback development registries. TLS verification is not bypassed for remote registries.

## Share a team

Build and push one orchestrator and one or more worker images. Give each profile a unique ID. Copy [the example](../examples/team.json), replacing every reference with your published images:

```json
{
  "schemaVersion": 1,
  "name": "My implementation team",
  "orchestrator": "ghcr.io/myname/conductor:1.0.0",
  "workers": ["ghcr.io/myname/brand-builder:1.0.0"]
}
```

```sh
node bin/subharness.mjs build orchestrator --tag ghcr.io/myname/conductor:1.0.0 --model provider/model
node bin/subharness.mjs push ghcr.io/myname/conductor:1.0.0
node bin/subharness.mjs team lock ./team.json

# Share team.json AND the generated team.lock.json.
# Recipient downloads the exact locked digests, then opens the same team:
node bin/subharness.mjs team pull ./team.json
node bin/subharness.mjs team run ./team.json --cwd /path/to/project
```

The orchestrator chooses among the locked workers itself and hands work back through the shared conversation. The receiver uses their own native account logins. Changing the team manifest requires an explicit `team lock` after reviewing the new images. `team pull` never replans or silently advances versions. Bare digests without repository names work locally but cannot tell another machine where to download the image.

Resume restores the saved selection and exact digests from the local store:

```sh
node bin/subharness.mjs run --cwd /path/to/project --resume latest
```

A resumed conversation must use the same image digests/direct profile ID. Start a new conversation after changing the team/image. The offline `demo` command simulates selected local profiles; `team run` uses actual locked images. Session roles override the old profile role hint. See [architecture](ARCHITECTURE.md) for selecting both roles directly with CLI flags.

## Hub discovery from the terminal

```sh
node bin/subharness.mjs catalog --out ./catalog.json
node bin/subharness.mjs search "frontend" --catalog ./catalog.json
node bin/subharness.mjs search "frontend" --catalog https://example.org/catalog.json
```

Without `--catalog` (or `SUBHARNESS_CATALOG`), search includes installed images and local profiles. Catalogs are bounded, validated metadata files. You can share a file or host it over HTTPS; no web frontend is needed. Catalog descriptions are author claims, not verified runtime results. Pull and inspect the referenced artifact before use. The app does not automatically publish a catalog or create a hosted public directory.

Legacy `export`/`import` still move editable source profile `.agentpack` files. Those are not locked OCI images; use image push/pull for the full image identity/runtime definition.

## Current verification

See [TESTING.md](TESTING.md) for automated checks and real registry/model results. Cross-platform portability, hosted/private registry auth and Claude live execution still need verification; the local registry tests used separate stores on one Windows machine.
