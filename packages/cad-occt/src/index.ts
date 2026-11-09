/**
 * The OCCT importer: a kernel behind the `CadImporter` contract.
 *
 * Nothing above this package names OCCT. A worker asks the registry for something that reads STEP
 * and gets this, or gets the reference importer when no kernel is installed — the conformance suite
 * is what says the two are interchangeable.
 */
export { DEFAULT_PYTHON, occtLocal, type OcctOptions } from './occt.js';
export { readPartBuffer, weld, writeMesh, type PartBlock, type WriteMeshOptions } from './mesh.js';
export {
  DEFAULT_LIMITS as DEFAULT_SANDBOX_LIMITS,
  DEFAULT_POLICY as DEFAULT_SANDBOX_POLICY,
  probeSandbox,
  resolveSandbox,
  sandboxCommand,
  sandboxEnv,
  sandboxPolicy,
  type SandboxLimits,
  type SandboxMode,
  type SandboxPolicy,
  type SandboxProbe,
} from './sandbox.js';
