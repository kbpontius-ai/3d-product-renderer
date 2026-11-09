/**
 * Generates the fixture packs' meshes.
 *
 * Real packs are tessellated from CAD by the ingestion pipeline (docs/04-tech-stack.md §3, W-11).
 * These parametric stand-ins let the whole chain — zones, 2D placement, 3D preview, render spec —
 * run today, and they keep CI free of large binary assets and licensing questions.
 *
 * Usage: pnpm fixtures:meshes
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBottle, buildCap, buildCarton, encodeGlb, type MeshData } from '@pr/gltf';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** UV islands, shared by the mesh and the pack manifest's uv-space zones. */
const CAP_UV = {
  top: { u0: 0.02, v0: 0.52, u1: 0.48, v1: 0.98 },
  skirt: { u0: 0.52, v0: 0.02, u1: 0.98, v1: 0.98 },
};

const BOTTLE_UV = {
  body: { u0: 0.02, v0: 0.02, u1: 0.98, v1: 0.98 },
};

const CARTON_UV = {
  front: { u0: 0.02, v0: 0.02, u1: 0.4, v1: 0.62 },
  back: { u0: 0.02, v0: 0.64, u1: 0.4, v1: 0.98 },
  side: { u0: 0.42, v0: 0.02, u1: 0.61, v1: 0.62 },
  top: { u0: 0.63, v0: 0.02, u1: 0.98, v1: 0.3 },
};

function write(packKey: string, relative: string, mesh: MeshData, materialName: string): void {
  const path = join(ROOT, 'fixtures', 'packs', packKey, 'meshes', relative);
  mkdirSync(dirname(path), { recursive: true });
  const glb = encodeGlb([mesh], [{ name: materialName, roughnessFactor: 0.5 }]);
  writeFileSync(path, glb);
  console.log(`  ${relative}  ${(glb.length / 1024).toFixed(1)} kB  ${mesh.indices.length / 3} tris`);
}

console.log('cap-basic');
for (const [file, segments] of [
  ['cap-flat/38mm/lod0.glb', 96],
  ['cap-flat/38mm/lod1.glb', 192],
  ['cap-flat/38mm/render.glb', 512],
] as const) {
  write(
    'cap-basic',
    file,
    buildCap({
      radiusMm: 19,
      heightMm: 18,
      filletMm: 1.2,
      segments,
      topUvRect: CAP_UV.top,
      skirtUvRect: CAP_UV.skirt,
      material: 0,
    }),
    'cap-body',
  );
}

console.log('bottle-oval');
for (const [file, segments] of [
  ['bottle-oval/500ml/lod0.glb', 96],
  ['bottle-oval/500ml/lod1.glb', 160],
  ['bottle-oval/500ml/render.glb', 256],
] as const) {
  write(
    'bottle-oval',
    file,
    buildBottle({
      radiusXMm: 30,
      radiusZMm: 20,
      heightMm: 110,
      neckScale: 0.3,
      segments,
      bodyUvRect: BOTTLE_UV.body,
      material: 0,
    }),
    'bottle-body',
  );
}

console.log('box-basic');
const carton = buildCarton({
  widthMm: 80,
  heightMm: 120,
  depthMm: 40,
  panelUv: CARTON_UV,
  material: 0,
});
write('box-basic', 'carton-tuck/std/lod0.glb', carton, 'board');
write('box-basic', 'carton-tuck/std/render.glb', carton, 'board');

console.log('done');
