/**
 * The pipeline's vocabulary, in the words of the person reading it (docs/23-cad-ingestion.md).
 *
 * Everything else in this package is written for the pipeline. This file is written for whoever is
 * looking at a failed ingestion wondering what they are supposed to do about it, and it exists
 * because the answer to that question is not derivable from a failure code alone: `too_complex` and
 * `importer_crash` both read as "it didn't work", and only one of them is anybody's to fix.
 *
 * Kept out of the React component on purpose. A rule about what may be shown to a person is worth
 * having in one testable place — the component is not the only thing that will ever render a
 * failure, and "never print a stack trace at an operator" is not a rule to re-derive per caller.
 */

import type { CadFailureCode } from './contract.js';
import type { CadIssueCode } from './validate.js';

/**
 * Who can do something about this.
 *
 * The three answers lead to three different next actions, and an operator sorting one list of
 * findings into "mine" and "not mine" in their head is doing work the code already knows how to do.
 */
export type FailureAudience =
  /** The file. Re-export it differently and it will import. */
  | 'file'
  /** The file is fine and simply asks for more than the catalog allows. A judgement call. */
  | 'limits'
  /** Ours. Nothing about the file will change the outcome. */
  | 'us';

export function failureAudience(code: CadFailureCode): FailureAudience {
  switch (code) {
    case 'unsupported_format':
    case 'unsupported_schema':
    case 'corrupt_file':
    case 'no_solids':
      return 'file';
    case 'too_complex':
    case 'too_large':
    case 'timeout':
    case 'oom':
      // Deliberately not 'us'. These are real ceilings a real file ran into, and the operator is
      // the one who decides whether the part is simplified or the ceiling is raised.
      return 'limits';
    default:
      return 'us';
  }
}

export function issueAudience(code: CadIssueCode): FailureAudience {
  switch (code) {
    case 'part_empty':
    case 'bbox_implausible':
    case 'unit_unresolved':
    case 'no_parts':
      return 'file';
    case 'budget_exceeded':
      return 'limits';
    default:
      // Everything else is the importer contradicting itself — a digest that does not match its
      // bytes, a parent index pointing nowhere. A supplier cannot cause those by exporting badly.
      return 'us';
  }
}

/** One line under the findings saying whether uploading the same file again could ever help. */
export const AUDIENCE_SUMMARY: Readonly<Record<FailureAudience, string>> = {
  file: 'This file will not import as it is. Changing the export is the way forward — uploading the same file again will fail the same way.',
  limits: 'This file imported, but asks for more than the catalog currently allows. Simplifying the model or raising the limit are both decisions somebody has to make.',
  us: 'This is ours to fix, not yours. It has been logged. Nothing about the file needs changing.',
};

/**
 * Failures whose message is about our code rather than the operator's file.
 *
 * `CadImportFailure.message` is documented as safe to show an operator — "says what is wrong with
 * the file, never where it sat on disk" — and for every code but these it is. A crash's message is
 * whatever exception the sidecar happened to raise, which is never about the file: a real one that
 * reached a real operator read `TypeError: GetReferredShape_s(): incompatible function arguments`,
 * and it made a one-line binding bug look like a broken product.
 *
 * The raw text is not thrown away. It stays on the job row and in the log, and the console offers
 * it as detail somebody can hand an engineer — which is a different thing from leading with it.
 */
const OPAQUE: Readonly<Partial<Record<CadFailureCode, string>>> = {
  importer_crash:
    'The importer stopped without producing a result. That is a fault on our side rather than a ' +
    'problem with this file, and it has been logged.',
  internal:
    'Something failed on our side while this file was being handled. It has been logged.',
  importer_unavailable:
    'The CAD importer is not running. Nothing is wrong with this file — it can be uploaded again ' +
    'once the importer is back.',
};

/** True when the stored message is internal detail rather than something to lead with. */
export const hasOpaqueMessage = (code: CadFailureCode): boolean => code in OPAQUE;

/** What to actually put in front of a person. */
export function operatorMessage(failure: { code: CadFailureCode; message: string }): string {
  return OPAQUE[failure.code] ?? failure.message;
}
