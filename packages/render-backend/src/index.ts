/**
 * The contract a renderer has to satisfy, and a fake that satisfies it.
 *
 * The conformance suite is deliberately not re-exported here: it imports vitest, and this entry
 * point is loaded by the render worker in production, where importing vitest is a crash rather
 * than a nuisance. Test files reach it at `@pr/render-backend/testing`.
 */
export {
  type BackendProbe,
  type BakedMapRef,
  type RenderBackend,
  type RenderFailure,
  type RenderRequest,
  type RenderResult,
} from './backend.js';
export { fakeBackend, type FakeBackendOptions } from './fake.js';
