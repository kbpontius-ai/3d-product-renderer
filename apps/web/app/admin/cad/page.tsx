import { KNOWN_EXTENSIONS } from '@pr/cad';
import { listIngestions } from '@pr/cad-jobs';
import { packsByMeshDigest } from '@pr/catalog';
import { getSql } from '@/lib/server/db';
import { requireStaff } from '@/lib/server/admin';
import { PIPELINE_VERSION } from '@/lib/server/cad';
import { CadUpload } from './cad-upload';
import { IngestionRow } from './ingestion-row';

/**
 * CAD ingestion (F-ADM-01, F-GEN-02, docs/23-cad-ingestion.md).
 *
 * The other half of how a product enters the catalog. `/admin/packs` accepts a pack somebody has
 * already built; this is where one gets built, from the file a supplier actually sends.
 *
 * Staff only, like everything under `/admin` — and here that is a security decision rather than a
 * convention, because the endpoint below hands a stranger's file to a native CAD parser.
 */
export const dynamic = 'force-dynamic';

export default async function AdminCadPage() {
  const principal = await requireStaff();
  const jobs = await listIngestions(getSql(), { orgId: principal.orgId, userId: principal.userId }, 50);

  const live = jobs.filter((job) => job.status === 'queued' || job.status === 'running').length;
  const lod0 = (job: (typeof jobs)[number]) => job.result?.meshes.find((mesh) => mesh.lod === 'lod0')?.digest;
  const drafted = await packsByMeshDigest(
    getSql(),
    jobs.map(lod0).filter((digest): digest is string => Boolean(digest)),
  );

  return (
    <section data-testid="cad">
      <header className="admin-head">
        <div>
          <h1>CAD ingestion</h1>
          <p className="auth-sub">
            {jobs.length} ingestion{jobs.length === 1 ? '' : 's'}
            {live > 0 ? `, ${live} in flight` : ''} · pipeline {PIPELINE_VERSION}
          </p>
        </div>
      </header>

      <CadUpload accept={KNOWN_EXTENSIONS} />

      <h2>Ingestions</h2>
      <div className="table-wrap">
        <table className="admin-table" data-testid="cad-table">
          <thead>
            <tr>
              <th>File</th>
              <th>Format</th>
              <th>Size</th>
              <th>Result</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <IngestionRow key={job.id} job={job} drafts={drafted[lod0(job) ?? ''] ?? []} />
            ))}
          </tbody>
        </table>
      </div>
      {jobs.length === 0 && (
        <p className="auth-sub" data-testid="cad-empty">
          Nothing ingested yet. Upload a STEP file to turn it into a draft pack.
        </p>
      )}
    </section>
  );
}
