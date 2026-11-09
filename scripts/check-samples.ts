import { readFileSync } from 'node:fs';
import { prepareArtwork } from '@pr/svg';
import { choosePitchMm, coverageFraction, rasterizeArtwork } from '@pr/raster';

for (const name of ['wordmark', 'text-not-outlined', 'hostile']) {
  const source = readFileSync(`fixtures/artwork/samples/${name}.svg`, 'utf8');
  const result = prepareArtwork(source);
  const line = [
    name.padEnd(20),
    result.status.padEnd(9),
    (result.report.errors.map((e) => e.code).join(',') || '-').padEnd(24),
    result.report.warnings.map((w) => w.code).join(',') || '-',
  ];
  if (result.artwork) {
    const raster = rasterizeArtwork(result.artwork, { mmPerPx: choosePitchMm(60) })!;
    line.push(`${raster.mask.width}x${raster.mask.height}`, `coverage=${coverageFraction(raster.mask).toFixed(3)}`);
  }
  console.log(line.join(' | '));
}
