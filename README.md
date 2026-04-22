# content-reuse-strategy-releases

Release asset repository for the Option 2 proof of concept.

## Contents

- `release-19.9-assets/`: manifests, TOC, and release metadata for 19.9
- `release-20.0-assets/`: manifests, TOC, and release metadata for 20.0

## Notes

- This repo contains release packaging only.
- Canonical topics do not live here.
- Canonical source content is stored in the companion repo: `content-reuse-strategy-content`.

## Local Build Workflow

This repo can assemble release-specific outputs by reading canonical topics from a local checkout of `content-reuse-strategy-content`.

Expected local layout:

```text
workspace/
  content-reuse-strategy-content/
  content-reuse-strategy-releases/
```

Run the build from this repo:

```bash
node scripts/build-release-output.js ../content-reuse-strategy-content
```

Generated output is written to:

```text
dist/<release>/
```

## What the build does

The script:

- loads canonical topics from `../content-reuse-strategy-content/main/topics/`
- loads release manifests, TOCs, and release metadata from this repo
- validates that every `topic_id` referenced by the release assets exists in the content repo
- filters topics by `lifecycle.applies_to`
- renders version blocks for the target release
- writes release-specific Markdown output

## Example

This repo currently includes two release asset sets:

- `release-19.9-assets/`
- `release-20.0-assets/`

The VLAN topic is referenced by both release books, but it is only rendered for `20.0` because the canonical topic metadata says it applies only to `20.0`.
