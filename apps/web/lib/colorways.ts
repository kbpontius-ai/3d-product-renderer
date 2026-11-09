/**
 * The colours a product can be ordered in.
 *
 * A stand-in for a pack-declared palette: a Product Pack will eventually ship its own colourways
 * (F-GEN-01), because a board carton and a moulded closure do not come in the same colours.
 */
export const COLORWAYS = [
  { key: 'forest', label: 'Forest green', hex: '#1b4d3e' },
  { key: 'ivory', label: 'Ivory', hex: '#efe8dc' },
  { key: 'cobalt', label: 'Cobalt', hex: '#1e3a8a' },
  { key: 'coral', label: 'Coral', hex: '#d1495b' },
  { key: 'graphite', label: 'Graphite', hex: '#2b2d31' },
] as const satisfies readonly { key: string; label: string; hex: string }[];
