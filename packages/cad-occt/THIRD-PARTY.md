# Third-party notices — `@pr/cad-occt`

This package contains no third-party code. It drives **Open CASCADE Technology (OCCT)** as a
separate process, through whichever Python bindings the configured interpreter provides.

| Component | Licence | How it is used |
|---|---|---|
| Open CASCADE Technology | LGPL-2.1 with the Open CASCADE exception | Unmodified, in its own process, through its published Python bindings. Not linked into anything this repository ships. |
| `cadquery-ocp` (OCP bindings) | Apache-2.0 | Optional; one of two supported ways to reach OCCT. |
| `pythonocc-core` | LGPL-3.0 | Optional; the other. |

Obligations, and where they are met:

- **Ship the licence text with the runtime.** The container image that carries OCCT is where this
  belongs — the kernel is installed there, not here. Nothing in this repository redistributes it.
- **Keep it unmodified and replaceable.** `occt_import.py` is our own file calling a published API.
  No OCCT source is vendored or patched. Replacing the kernel with a different build is an image
  change, not a code change.
- **Record which build made a mesh.** `probe()` reports the bindings' version and the queue stores
  it on every job, so any pack can be traced back to the kernel that produced it. That is a
  determinism requirement first and a provenance one second, but it serves both.

If a commercial kernel is ever needed — most likely for native Parasolid or JT — the `CadImporter`
registry is the seam it plugs into, and nothing above it changes. Vendoring a *modified* OCCT into
the application image is the one arrangement to avoid; that is a legal question before it is an
engineering one.
