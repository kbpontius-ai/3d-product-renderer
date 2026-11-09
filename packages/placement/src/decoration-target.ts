export function resolveDecorationTarget(
  explicit: string | undefined,
  legacy: string,
  drawableSlots: readonly string[],
  assignedSlots: readonly string[] = drawableSlots,
): string {
  // Historical packs mapped unnamed/unrecognized GLB materials to the first assigned slot.
  const drawable = [
    ...new Set(drawableSlots.map((slot) => (assignedSlots.includes(slot) ? slot : legacy))),
  ];
  if (explicit) {
    if (!drawable.includes(explicit)) {
      throw new Error(`Artwork target "${explicit}" has no drawable geometry.`);
    }
    return explicit;
  }
  if (drawable.includes(legacy)) return legacy;
  if (drawable.length === 1) return drawable[0]!;
  throw new Error('Choose the artwork target part in the product’s decoration-zone setup.');
}
