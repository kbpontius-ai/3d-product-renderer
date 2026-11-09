# Confining the CAD worker

> **Uncertified in this release.** The `cad` profile is off by default and only staff can use it.
> Two things stop it being certified: the parser can still read the storage volume, which holds
> every organisation's files (`F-HARD-03`), and this image has never been built or started outside
> development (`F-HARD-07`). Import only files from suppliers you trust.

The CAD parser is the most dangerous thing in this product: a large native C++ library, written for
a trusted engineering context, reading files that arrive from outside. The design assumption is that
it *will* be exploited, because the cheapest assumption is that it already has been. So the
interesting question is not whether it can be broken but what an attacker reaches when it is.

## Two layers, and why both

| Layer | Where | Holds when |
|---|---|---|
| **Inner** — namespaces + rlimits per parse | `packages/cad-occt/src/sandbox.ts` | always, including on a laptop, in CI, and in a container somebody misconfigured |
| **Outer** — image, capabilities, seccomp, read-only root, resource ceilings | this directory | the operator set it up as written |

Neither replaces the other, and the split is deliberate. The outer layer is the one an operator
configures and can therefore get wrong — a missing flag, a base image swapped, a `docker run`
somebody typed by hand. The inner layer is code, it is covered by
`packages/cad-occt/src/sandbox.integration.test.ts`, and it holds regardless.

`CAD_SANDBOX=require` in the image is what makes the inner layer non-optional: the worker refuses to
start rather than parse a stranger's file unconfined, which is the one outcome worse than not
starting.

## What the inner sandbox actually does

Every parse runs as `unshare --user --map-root-user --net --ipc --uts --pid --mount --fork
--kill-child --mount-proc prlimit --as=… --cpu=… --fsize=… --core=0 python3 …`, which gives it:

- **no network at all** — an empty network namespace. Not a filtered egress: the pipeline needs
  nothing from the internet, so a successful exploit finds no way to call home. docs/23 calls this
  the single highest-value control here.
- **no view of any other process**, including the supervisor holding the database credentials.
  `--pid` alone is not enough for this and looks exactly like it is — it gives a new PID namespace
  while leaving the host's `/proc` mounted, so the confined process still reads every process on the
  box. `--mount --mount-proc` is what makes it real. A test counting processes is what caught it.
- **hard ceilings on memory, CPU seconds and output size**, applied by `prlimit` before the parser's
  own code runs. The parser lowers them again on itself first thing, which is what holds if it is
  ever invoked some other way.
- **`--kill-child`**, which is correctness rather than hardening and is load-bearing: with `--pid`
  the process the supervisor spawns is `unshare`, so a timeout or a cancellation would otherwise
  kill the wrapper and orphan the parser.

## The compromise in the outer layer

docs/23 asks for a container with no network. This one has network, because the *supervisor* needs
Postgres and object storage. Only the *parser* must be offline, and it is — through the inner
sandbox rather than through the container.

That has a cost, and it is in `seccomp.json`: the namespace syscalls (`unshare`, `clone`, `mount`)
have to stay allowed, where Docker's default profile blocks `unshare` with `CLONE_NEWUSER`. Under
the default profile the nested confinement would fail and the parser would inherit the *container's*
network — the one thing it must never have. So the profile is widened, deliberately, in one place.

**The cleaner arrangement, when there is a control plane to drive it:** a supervisor container with
network, and a *separate* parser container per job with `network_mode: none`, no volumes but the
scratch mount, and a default seccomp profile. Then nothing needs namespace syscalls of its own and
the parser is confined by the runtime rather than by itself. That needs an orchestrator API the
worker can call, which is a bigger piece of work than this; it is the right target and this is the
honest interim.

## Status

**The image and both manifests are unverified.** They were written in an environment with the Docker
CLI but no daemon, so nothing here has been built, started, or scheduled. Treat them as a reviewed
specification. The first real build should be expected to want small corrections — most likely
around VTK's link-time dependencies, which is the fiddliest part of installing the OCCT bindings.

The inner sandbox is the opposite: it is exercised on every test run, and the whole OCCT conformance
suite — including the two-run byte-identical determinism check — runs through it.

## Still open, from docs/23

- **Hash-pinned Python dependencies and an SBOM.** The image pins `cadquery-ocp` by version;
  docs/23 asks for by-hash plus a generated SBOM. `packages/cad-occt/THIRD-PARTY.md` records the
  licence obligations this satisfies and the ones it does not.
- **Worker-class routing.** `cad_jobs.profile` (`wasm`/`standard`/`heavy`) is recorded at upload and
  ignored at claim time, so a heavy assembly can land on a worker sized for closures. The resources
  above are one class; routing needs the claim to filter on it.
- **Source-CAD retention and deletion.** No retention job exists, and `cad-source/` currently goes
  into the same backup as everything else where docs/23 asks for separate retention and a separate
  key.
