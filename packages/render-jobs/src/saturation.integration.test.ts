import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  hasDatabase,
  seedOrganizations,
  withStaff,
  type Sql,
  type TestDatabase,
} from '@pr/db';
import { importPack, listProducts } from '@pr/catalog';
import { createDesign } from '@pr/designs';
import type { RenderSpec } from '@pr/design-schema';
import { buildRenderSpec } from '@pr/render-spec';
import { claimJob, completeJob, submitRender, QueueError } from './queue.js';

/**
 * Queue saturation (docs/20-testing-ci.md: "API + queue saturation, 100 concurrent renders").
 *
 * The queue's correctness is easy to demonstrate one job at a time and is not worth much there: a
 * `for update skip locked` queue is exactly the kind of thing that behaves perfectly in a test with
 * two workers and hands the same job to three of them the first afternoon it is busy.
 *
 * So this saturates it — a hundred submissions arriving together, a pool of workers all reaching
 * for the same rows — and checks the properties that would actually cost money or trust if they
 * broke: no job runs twice, no job is silently dropped, and the quota that says how much an
 * organisation may spend holds under a burst rather than merely under a sequence.
 *
 * It is a load test in the sense that matters here — concurrency, not throughput. A number of
 * requests per second measured on whatever machine CI allocated is not a fact about this system.
 */

const DIGEST = 'a'.repeat(64);
const CONCURRENT_SUBMISSIONS = 100;
const WORKERS = 8;

describe.skipIf(!hasDatabase)('queue under saturation', () => {
  let db: TestDatabase;
  let sql: Sql;
  let orgId: string;
  let designVersionId: string;
  let document: RenderSpec['document'];

  const ctx = () => ({ orgId, userId: null });

  /** A spec per seed, so every submission is genuinely different work rather than a dedupe hit. */
  const spec = (seed: number): RenderSpec =>
    buildRenderSpec({
      document,
      resolved: {
        meshKey: 'packs/cap-basic/1.0.0/meshes/cap-flat/38mm/render.glb',
        meshDigest: DIGEST,
        bboxMm: [
          [-19, 0, -19],
          [19, 18, 19],
        ],
        zones: [],
        artwork: [],
        materials: [],
        environment: {
          key: 'studio-softbox',
          hdriKey: 'env/studio-softbox/softbox.hdr',
          rotationDeg: 0,
          exposureEv: 0,
        },
      },
      outputs: [
        {
          kind: 'image',
          widthPx: 1024,
          heightPx: 1024,
          format: 'png16',
          camera: { kind: 'preset', presetKey: 'three-quarter' },
        },
      ],
      preset: 'draft',
      renderer: { id: 'cycles', version: '4.0.2' },
      seed,
    });

  beforeAll(async () => {
    db = await createTestDatabase('pr_saturation');
    sql = db.sql;
    orgId = (await seedOrganizations(sql)).alpha;

    const manifest = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../../fixtures/packs/cap-basic/manifest.json', import.meta.url)),
        'utf8',
      ),
    ) as unknown;
    await importPack(sql, manifest, { publish: true });

    const products = await listProducts(sql, ctx());
    const variantId = products.find((p) => p.productKey === 'cap-flat')!.variants[0]!.variantId;
    const design = await createDesign(sql, ctx(), { variantId });
    document = design.document;

    const [version] = await withStaff(sql, (tx) =>
      tx`select id from design_versions where design_id = ${design.id}`,
    );
    designVersionId = version!['id'] as string;

    // Room to actually saturate: the point of this test is the queue's behaviour, and the quota
    // refusing the burst on submission twelve would test the quota instead. The quota gets its own
    // case at the bottom, where it is the subject rather than the obstacle.
    await withStaff(sql, (tx) =>
      tx`insert into org_quotas (org_id, renders_per_day, max_concurrent_jobs, max_resolution_px)
         values (${orgId}, 100000, 100000, 8192)
         on conflict (org_id) do update set renders_per_day = 100000, max_concurrent_jobs = 100000`,
    );
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  });

  it(
    'hands each of a hundred jobs to exactly one worker, and loses none',
    async () => {
      await withStaff(sql, (tx) => tx`delete from render_jobs`);

      const submittedAt = Date.now();
      const submissions = await Promise.all(
        Array.from({ length: CONCURRENT_SUBMISSIONS }, (_, i) =>
          submitRender(sql, ctx(), { designVersionId, spec: spec(i + 1) }),
        ),
      );
      const submitMs = Date.now() - submittedAt;

      const queued = submissions.filter((r) => !r.deduped).map((r) => r.job.id);
      expect(queued).toHaveLength(CONCURRENT_SUBMISSIONS);

      // Workers race for the same rows, exactly as they do in production.
      const claimedAt = Date.now();
      const claims = await Promise.all(
        Array.from({ length: WORKERS }, async (_, w) => {
          const mine: string[] = [];
          for (;;) {
            const claim = await claimJob(sql, `saturation-worker-${w}`);
            if (!claim) return mine;
            mine.push(claim.jobId);
          }
        }),
      );
      const claimMs = Date.now() - claimedAt;

      const all = claims.flat();
      const unique = new Set(all);

      // The property that matters most: a job handed to two workers is rendered twice, billed
      // twice, and may be uploaded twice under the same key.
      expect(unique.size, 'a job was claimed by more than one worker').toBe(all.length);
      // And the one that matters next: a job nobody claims is a customer waiting forever.
      expect(unique.size, 'jobs went missing between submission and claiming').toBe(queued.length);
      expect([...unique].sort()).toEqual([...queued].sort());

      // Every worker did some of the work, which is what `skip locked` is for; if one worker took
      // all hundred while the others blocked, the queue would be serialising rather than sharing.
      expect(claims.filter((c) => c.length > 0).length).toBeGreaterThan(1);

      console.log(
        `saturation: ${CONCURRENT_SUBMISSIONS} submissions in ${submitMs} ms, ` +
          `claimed by ${WORKERS} workers in ${claimMs} ms ` +
          `(${claims.map((c) => c.length).join('/')})`,
      );
    },
    120_000,
  );

  it(
    'refuses the part of a burst that is over quota, rather than accepting it and failing later',
    async () => {
      await withStaff(sql, (tx) => tx`delete from render_jobs`);
      const limit = 10;
      await withStaff(sql, (tx) =>
        tx`update org_quotas set max_concurrent_jobs = ${limit} where org_id = ${orgId}`,
      );

      try {
        // Fifty at once against a limit of ten. Under a sequence this is trivially right; under a
        // burst it is only right if the check and the insert cannot interleave.
        const results = await Promise.allSettled(
          Array.from({ length: 50 }, (_, i) =>
            submitRender(sql, ctx(), { designVersionId, spec: spec(1000 + i) }),
          ),
        );

        const accepted = results.filter((r) => r.status === 'fulfilled').length;
        const refused = results.filter(
          (r) => r.status === 'rejected' && r.reason instanceof QueueError,
        ).length;

        expect(accepted + refused, 'something failed for a reason other than the quota').toBe(50);
        expect(accepted).toBeLessThanOrEqual(limit);
        expect(accepted).toBeGreaterThan(0);

        const [stored] = await withStaff(sql, (tx) =>
          tx`select count(*)::int as count from render_jobs where org_id = ${orgId}`,
        );
        expect(Number(stored!['count']), 'more jobs were stored than the quota allows').toBeLessThanOrEqual(
          limit,
        );

        console.log(`saturation: ${accepted} accepted, ${refused} refused against a limit of ${limit}`);
      } finally {
        await withStaff(sql, (tx) =>
          tx`update org_quotas set max_concurrent_jobs = 100000 where org_id = ${orgId}`,
        );
      }
    },
    120_000,
  );

  it(
    'stays consistent when workers finish while others are still claiming',
    async () => {
      await withStaff(sql, (tx) => tx`delete from render_jobs`);
      const count = 40;
      await Promise.all(
        Array.from({ length: count }, (_, i) =>
          submitRender(sql, ctx(), { designVersionId, spec: spec(2000 + i) }),
        ),
      );

      // Claim and complete concurrently, which is the shape of a real worker pool: nobody waits for
      // the others to finish before taking the next job.
      const done = await Promise.all(
        Array.from({ length: WORKERS }, async (_, w) => {
          const workerId = `mixed-worker-${w}`;
          let finished = 0;
          for (;;) {
            const claim = await claimJob(sql, workerId);
            if (!claim) return finished;
            await completeJob(sql, claim.jobId, workerId, {
              outputs: [{ kind: 'image', storageKey: `renders/x/${claim.jobId}/0.png`, bytes: 1 }],
              gpuSeconds: 0.1,
              provenance: {},
            });
            finished++;
          }
        }),
      );

      expect(done.reduce((a, b) => a + b, 0)).toBe(count);

      const [row] = await withStaff(sql, (tx) =>
        tx`select
             count(*) filter (where status = 'succeeded')::int as succeeded,
             count(*) filter (where status <> 'succeeded')::int as other
           from render_jobs where org_id = ${orgId}`,
      );
      expect(Number(row!['succeeded'])).toBe(count);
      expect(Number(row!['other']), 'a job was left in a non-terminal state').toBe(0);
    },
    120_000,
  );
});
