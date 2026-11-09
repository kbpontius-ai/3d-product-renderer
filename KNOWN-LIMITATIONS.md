# Known limitations

What this release does not do, or does not yet do safely. Each entry names its tracking ID in
[docs/01-features.md](docs/01-features.md). The work planned first after the release is in
[docs/38-first-work-after-release.md](docs/38-first-work-after-release.md).

## Accounts and access

- **Staff accounts sign in with a password only.** There is no two-factor authentication yet. Staff
  can see every organisation and are the only people who can import CAD, so keep staff accounts
  few and give each a strong, unique password. Two-factor for staff is the first feature planned
  after this release (`F-AUTH-09`).
- **The first organisation is always called "Demo Organisation"** and can't be renamed. The first
  account is created with a development script run inside the web container
  ([QUICKSTART](QUICKSTART.md), step 4). A proper setup command is planned (`F-SHIP-11`).
- **Without email, only the first account can sign in.** Outside development the admin console
  never shows invitation links; they are only emailed. With no Resend settings, nobody else can be
  invited and nobody can reset a password (`F-SHIP-12`).
- **Email from a Compose deployment hasn't been tested yet.** The settings are passed to the app,
  but no message has been delivered from a server install (`F-SHIP-12`). A Resend key set without
  `MAIL_FROM` logs one warning and then sends nothing.
- **No CAPTCHA, no single sign-on.** Sign-in is protected by rate limits and lockout. The rate
  limits are kept in memory, so they reset when the web container restarts.
- `/design/demo` and `/api/fixtures/*` need no sign-in. In a production image they serve nothing
  but errors, because the image contains no fixtures (`F-HARD-12`).

## CAD import

- **The `cad` profile is uncertified.** It is off by default, and only staff can use it. Turn it
  on only for files from suppliers you trust.
- The CAD parser runs with no network, no credentials and its own process namespace, but it can
  still read the storage volume, which holds every organisation's files (`F-HARD-03`).
- The CAD worker's image has never been built or started outside development (`F-HARD-07`).
- Uploaded STEP files are kept indefinitely, with no way to delete them (`F-HARD-04`).

## Data

- **Backups for a Compose install are a manual procedure, not yet tested.** Stop the stack and copy
  the `pgdata` and `storage` volumes together ([docs/27](docs/27-deployment.md), section 5).
  `scripts/backup.sh` and `restore.sh` are for running from source, not for Compose.
- An organisation's data can't be exported or deleted in one step (`F-PLAT-06`).
- The `storage` volume only grows. Nothing removes old renders or artwork.
- Migrations only go forward. Going back to an earlier release means restoring a backup taken
  before the upgrade.
- The render worker doesn't check that an artwork file is unchanged since the render was queued
  (`F-HARD-15`). This matters only if something other than the app can write to storage.

## Scale and performance

- **One server only.** Files live on a local disk shared by the web app and the render worker, so
  there can be only one of each (`F-SHIP-08`).
- **Renders run on the CPU** and take minutes (`F-SHIP-09`).
- Upgrades restart the web container, with a few seconds of downtime.

## Installation and testing

- **The quickstart hasn't been run end to end on a clean server.** CI builds and boots the images,
  but the full install, email, backup and restore haven't been tried from the documents yet
  (`F-SHIP-13`).
- Dependencies aren't pinned by hash, and no software bill of materials is published (`F-HARD-05`).
- Some security tests are still to be written: the admin and organisation route checks, connection
  reuse, and the database role check (`F-HARD-11`, `F-HARD-13`, `F-HARD-14`). The behaviour they
  would cover was reviewed by hand for this release.
- Accessibility conformance is not claimed (`F-PLAT-08`).
