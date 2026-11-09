# Inter, vendored

`Inter` variable (weights 100–900), latin and latin-ext subsets, taken from the Google Fonts
`v20` build. Redistributed under the SIL Open Font License 1.1 — see `OFL.txt`, which is the
licence's own requirement and the reason it sits beside the files.

## Why the files are here rather than fetched

`next/font/google` downloads at build time. `deploy/web/Dockerfile` runs the Next build inside the
image, so that would make `docker compose up --build` depend on Google's CDN being reachable — the
same shape as the corepack problem fixed in `F-SHIP-10`, one layer up. The repository already pins
Blender to a series and OCCT to a version for the same reason: a build that reaches out is a build
that can fail for a reason nobody changed.

Vendored, the bytes are fixed forever, the build is one host less fragile, and `font-src 'self'`
needs no exception.

## Replacing them

Fetch the two `woff2` files named in the `latin` and `latin-ext` blocks of
`https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap` — request it with a
browser user-agent or Google serves the older `ttf` format — and update the `unicode-range`
declarations in `globals.css` if the subsets have moved.
