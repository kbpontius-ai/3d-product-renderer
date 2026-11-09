import { describe, expect, it } from 'vitest';
import { isPermanentFailure, type CadFailureCode } from './contract.js';
import {
  AUDIENCE_SUMMARY,
  failureAudience,
  hasOpaqueMessage,
  issueAudience,
  operatorMessage,
} from './reporting.js';

describe('operatorMessage', () => {
  it('never leads with the text of a crash', () => {
    // The message a real operator was shown. It is a one-line binding bug in our own Python, and
    // printed as-is it reads as a broken product and sends somebody to re-export a fine file.
    const raw =
      'TypeError: GetReferredShape_s(): incompatible function arguments. The following argument ' +
      'types are supported: 1. (L: OCP.OCP.TDF.TDF_Label, Label: OCP.OCP.TDF.TDF_Label) -> bool';
    const shown = operatorMessage({ code: 'importer_crash', message: raw });

    expect(shown).not.toContain('TypeError');
    expect(shown).not.toContain('GetReferredShape_s');
    expect(shown).toContain('our side');
  });

  it('passes through a message that really is about the file', () => {
    const message = 'the file could not be read as STEP (IFSelect_RetFail)';
    expect(operatorMessage({ code: 'corrupt_file', message })).toBe(message);
    expect(hasOpaqueMessage('corrupt_file')).toBe(false);
  });

  it('agrees with itself about which codes are opaque', () => {
    // The console decides whether to offer the raw text as detail by asking `hasOpaqueMessage`. If
    // the two disagreed, an operator would get a "technical detail" disclosure holding the same
    // sentence they had just read, or none where the real cause was hidden.
    for (const code of ['importer_crash', 'internal', 'importer_unavailable'] as const) {
      expect(hasOpaqueMessage(code)).toBe(true);
      expect(operatorMessage({ code, message: 'raw' })).not.toBe('raw');
    }
  });
});

/** Every code in the vocabulary, so a new one cannot be added without an audience. */
const ALL_CODES: readonly CadFailureCode[] = [
  'unsupported_format',
  'unsupported_schema',
  'corrupt_file',
  'no_solids',
  'too_complex',
  'too_large',
  'source_missing',
  'invalid_result',
  'timeout',
  'canceled',
  'oom',
  'importer_crash',
  'importer_unavailable',
  'internal',
];

describe('audiences', () => {
  it('sends every crash-shaped failure to us and no file-shaped one', () => {
    expect(failureAudience('importer_crash')).toBe('us');
    expect(failureAudience('internal')).toBe('us');
    expect(failureAudience('corrupt_file')).toBe('file');
    expect(failureAudience('no_solids')).toBe('file');
  });

  it('calls a ceiling a ceiling rather than a fault', () => {
    // `too_complex` and `oom` describe a real file meeting a real limit. Filing them under "ours"
    // would tell an operator to wait for a fix that is not coming; filing them under "the file"
    // would tell them to re-export something that is not wrong.
    for (const code of ['too_complex', 'too_large', 'timeout', 'oom'] as const) {
      expect(failureAudience(code)).toBe('limits');
    }
    expect(issueAudience('budget_exceeded')).toBe('limits');
  });

  it('routes the findings this pipeline actually produces', () => {
    expect(issueAudience('part_empty')).toBe('file');
    expect(issueAudience('bbox_implausible')).toBe('file');
    expect(issueAudience('unit_unresolved')).toBe('file');
    // The importer contradicting itself. No export changes a digest that disagrees with its bytes.
    expect(issueAudience('mesh_digest_mismatch')).toBe('us');
    expect(issueAudience('part_tree_broken')).toBe('us');
  });

  it('says whether uploading the same file again could help', () => {
    // The one question an operator actually has, and one `isPermanentFailure` has been able to
    // answer since the queue was written without ever reaching a screen.
    expect(AUDIENCE_SUMMARY.file).toContain('same file again will fail the same way');
    expect(AUDIENCE_SUMMARY.us).toContain('Nothing about the file needs changing');

    // Anything we describe as the file's problem must genuinely be final: telling somebody to
    // re-export when a retry would have worked wastes their afternoon.
    for (const code of ALL_CODES.filter((c) => failureAudience(c) === 'file')) {
      expect(isPermanentFailure(code)).toBe(true);
    }
  });

  it('only suppresses a message it is also claiming as ours', () => {
    // Hiding the text of a failure that is the operator's to fix would leave them with a sentence
    // that says nothing and a cause they cannot see.
    for (const code of ALL_CODES.filter(hasOpaqueMessage)) {
      expect(failureAudience(code)).toBe('us');
    }
  });
});
