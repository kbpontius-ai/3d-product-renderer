import { describe, expect, it } from 'vitest';
import { parseStepHeader, schemaSupported } from './step-header.js';

/** What a real exporter writes, down to the line breaks inside an argument list. */
const REAL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('/home/eng/parts/closure-38.step','2026-03-11T09:14:22+01:00',
  ('R. Okonkwo'),('Northfield Tooling'),
  'Open CASCADE STEP processor 7.7','FreeCAD','');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));
ENDSEC;
DATA;
#1=CARTESIAN_POINT('FILE_NAME(''fake'')',(0.,0.,0.));
ENDSEC;
END-ISO-10303-21;
`;

describe('parseStepHeader', () => {
  it('reads the provenance an ingestion record wants', () => {
    const header = parseStepHeader(REAL);

    expect(header.name).toBe('/home/eng/parts/closure-38.step');
    expect(header.timeStamp).toBe('2026-03-11T09:14:22+01:00');
    expect(header.author).toEqual(['R. Okonkwo']);
    expect(header.organization).toEqual(['Northfield Tooling']);
    expect(header.originatingSystem).toBe('FreeCAD');
    expect(header.schemas).toEqual(['AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }']);
  });

  it('stops at DATA, so geometry cannot impersonate a header', () => {
    // The first entity in the DATA section carries a string containing `FILE_NAME('fake')`. A
    // parser that scanned the whole file would read the supplier's name out of a point label.
    expect(parseStepHeader(REAL).name).not.toBe('fake');
  });

  it('ignores comments, wherever they are', () => {
    const commented = REAL.replace("FILE_SCHEMA((", "/* FILE_SCHEMA(('AP203')); */ FILE_SCHEMA((");
    expect(parseStepHeader(commented).schemas).toEqual(['AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }']);
  });

  it('undoes the doubled-quote escape', () => {
    const quoted = REAL.replace("('R. Okonkwo')", "('O''Brien & Co')");
    expect(parseStepHeader(quoted).author).toEqual(["O'Brien & Co"]);
  });

  it('reads $ as not supplied rather than as a name', () => {
    const missing = REAL.replace("'FreeCAD'", '$');
    expect(parseStepHeader(missing).originatingSystem).toBeNull();
  });

  it('does not split an argument list on a comma inside a string', () => {
    const commas = REAL.replace("('Northfield Tooling')", "('Northfield Tooling, Ltd','Second, Inc')");
    expect(parseStepHeader(commas).organization).toEqual(['Northfield Tooling, Ltd', 'Second, Inc']);
  });

  it('returns empty fields rather than throwing on a header that is not one', () => {
    // Everything upstream of this treats an empty schema list as a refusal, so garbage in has to
    // mean nothing out, not an exception out of a parser reading hostile input.
    expect(parseStepHeader('ISO-10303-21;\nHEADER;\n\x00\x01garbage(((').schemas).toEqual([]);
    expect(parseStepHeader('').name).toBeNull();
  });

  it('does not read past the header limit of a file with no DATA section', () => {
    // A file that is all header is a denial-of-service shape, not a CAD file. The cap is what makes
    // sniffing cheap enough to do before anything else.
    const huge = `ISO-10303-21;\nHEADER;\n${'/* pad */ '.repeat(20_000)}FILE_SCHEMA(('AP242'));\n`;
    expect(parseStepHeader(huge).schemas).toEqual([]);
  });
});

describe('schemaSupported', () => {
  it('accepts the protocols that carry solids, suffixes and all', () => {
    for (const schema of [
      'AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }',
      'CONFIG_CONTROL_DESIGN',
      'AP203_CONFIGURATION_CONTROLLED_3D_DESIGN_OF_MECHANICAL_PARTS_AND_ASSEMBLIES',
      'AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF { 1 0 10303 442 3 1 4 }',
    ]) {
      expect(schemaSupported({ ...empty, schemas: [schema] })).toBe(true);
    }
  });

  it('refuses a protocol that is not solid geometry', () => {
    // AP210 is electronics and AP238 is machining. Both are STEP; neither has a shape to tessellate,
    // and finding that out in milliseconds beats finding it out after a minute in the kernel.
    expect(schemaSupported({ ...empty, schemas: ['ELECTRONIC_ASSEMBLY_INTERCONNECT_AND_PACKAGING_DESIGN'] })).toBe(false);
    expect(schemaSupported({ ...empty, schemas: [] })).toBe(false);
  });
});

const empty = {
  description: [],
  name: null,
  timeStamp: null,
  author: [],
  organization: [],
  originatingSystem: null,
  schemas: [],
};
