import { listMaterialsForStaff } from '@pr/catalog';
import { getSql } from '@/lib/server/db';
import { requireStaff } from '@/lib/server/admin';
import { MaterialGrid } from './material-grid';
import { NewMaterialForm } from './new-material-form';

/**
 * The material library (F-ADM-04).
 *
 * One card per material: its numbers, its texture slots, and — on demand — a sphere lit the way the
 * editor lights a product, so a change can be judged rather than guessed. Materials are named by key
 * in every design that uses one, which is why each card says how many designs it would change.
 */
export const dynamic = 'force-dynamic';

export default async function AdminMaterialsPage() {
  await requireStaff();
  const materials = await listMaterialsForStaff(getSql());
  const families = [...new Set(materials.map((material) => material.family))].sort();

  return (
    <section data-testid="materials">
      <header className="admin-head">
        <div>
          <h1>Materials</h1>
          <p className="auth-sub">
            {materials.length} material{materials.length === 1 ? '' : 's'} across {families.length}{' '}
            famil{families.length === 1 ? 'y' : 'ies'}.
          </p>
        </div>
        <NewMaterialForm />
      </header>

      {families.map((family) => (
        <div key={family}>
          <h2>{family}</h2>
          <MaterialGrid materials={materials.filter((material) => material.family === family)} />
        </div>
      ))}

      {materials.length === 0 && (
        <p className="auth-sub" data-testid="materials-empty">
          No materials yet. They arrive with packs, or can be created here.
        </p>
      )}
    </section>
  );
}
