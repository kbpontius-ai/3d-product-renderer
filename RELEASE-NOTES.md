# Release notes

Versions are `YYYY.MM.PATCH`. The number says when a release was made, not how risky upgrading to
it is. Each release lists any action an operator must take.

## 2026.11.0 (2026-11-08)

The first public release.

A product customiser: pick a 3D product, place vector artwork on it in a 2D face view, preview it
live, and export a photorealistic render. It runs on one Ubuntu 24.04 server with Docker Compose:
a web app, a render worker, PostgreSQL and Caddy for TLS.

**Installing:** follow [QUICKSTART.md](QUICKSTART.md).

**Operator actions:** none. There is no earlier release to upgrade from.

**Included**

- Invite-only accounts with three roles: staff, owner and member. Each organisation's data is kept
  apart by checks in the app and by row-level security in the database.
- Product Packs: upload, review, orientation and zone setup, publishing, and catalog images.
- Artwork: SVG upload with sanitising and preparation, a gallery, editing and an archive.
- The editor: 2D placement, a live 3D preview, autosave and viewer snapshots.
- Photorealistic renders in Blender Cycles through a job queue, with quotas and email when done.
- An admin console for organisations, people, limits, the render queue, materials and the audit
  trail, plus an owner's area for managing their own organisation.
- Optional CAD import from STEP files, behind the `cad` profile. **Uncertified** in this release.

**Known limitations:** [KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md). The ones to read before
installing:

- Staff sign in with a password only. Two-factor is the first feature planned after this release.
- The `cad` profile is uncertified. Import only files from suppliers you trust.
- Without Resend email settings, nobody beyond the first account can be invited.
- The install path hasn't been run end to end on a clean server yet.

**Licence and support:** MIT. No support is offered: issues are open, but replies aren't promised.
Report security problems as described in [SECURITY.md](SECURITY.md).
