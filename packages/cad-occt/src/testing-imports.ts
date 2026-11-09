/**
 * Test-only re-exports.
 *
 * `@pr/cad/testing` carries the conformance suite and therefore imports vitest, which must never be
 * reachable from this package's entry point — the CAD worker loads that in production. Gathering
 * both here keeps the test file's imports honest about which half is which.
 */
export { describeCadImporter } from '@pr/cad/testing';
export { DEFAULT_BUDGETS, draftPack, slotKeysFor, validateImportResult } from '@pr/cad';
