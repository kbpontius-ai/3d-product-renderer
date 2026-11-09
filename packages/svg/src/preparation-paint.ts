import colors from './css-colors.json';
import { PreparationError } from './preparation-types.js';

const names: Record<string, string> = colors;
const hex = (rgb: number[]): string =>
  `#${rgb
    .map((n) =>
      Math.round(Math.min(255, Math.max(0, n)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;

export function preparationPaint(value: string): string | null {
  const input = value.trim().toLowerCase();
  if (input === 'none' || input === 'transparent') return null;
  if (names[input]) return names[input]!;
  const color = /^#([a-f0-9]{3,8})$/.exec(input)?.[1];
  if (color) {
    const expanded =
      color.length === 3 || color.length === 4 ? [...color].map((n) => n + n).join('') : color;
    if (expanded.length === 8) {
      if (expanded.slice(6) === '00') return null;
      if (expanded.slice(6) !== 'ff')
        throw new PreparationError(
          'Partially transparent paint cannot define an exact solid mark. Export opaque vectors.',
        );
    }
    if (expanded.length === 6 || expanded.length === 8) return `#${expanded.slice(0, 6)}`;
  }
  const functional = /^(rgb|rgba|hsl|hsla)\((.*)\)$/.exec(input);
  if (functional) {
    const parts = functional[2]!.trim().split(/[\s,/]+/);
    if (parts.length === 4) {
      const alpha = parts[3]!.endsWith('%') ? Number.parseFloat(parts[3]!) / 100 : Number(parts[3]);
      if (alpha === 0) return null;
      if (alpha !== 1)
        throw new PreparationError(
          'Partially transparent paint cannot define an exact solid mark. Export opaque vectors.',
        );
    }
    if (parts.length === 3 || parts.length === 4) {
      if (functional[1]!.startsWith('rgb')) {
        const rgb = parts
          .slice(0, 3)
          .map((part) => (part.endsWith('%') ? Number.parseFloat(part) * 2.55 : Number(part)));
        if (rgb.every(Number.isFinite)) return hex(rgb);
      } else {
        const hue = parts[0]!;
        const degrees =
          Number.parseFloat(hue) *
          (hue.endsWith('turn')
            ? 360
            : hue.endsWith('grad')
              ? 0.9
              : hue.endsWith('rad')
                ? 180 / Math.PI
                : 1);
        const h = (((degrees % 360) + 360) % 360) / 60;
        const s = Math.min(1, Math.max(0, Number.parseFloat(parts[1]!) / 100));
        const l = Math.min(1, Math.max(0, Number.parseFloat(parts[2]!) / 100));
        const c = (1 - Math.abs(2 * l - 1)) * s,
          x = c * (1 - Math.abs((h % 2) - 1)),
          m = l - c / 2;
        const rgb =
          h < 1
            ? [c, x, 0]
            : h < 2
              ? [x, c, 0]
              : h < 3
                ? [0, c, x]
                : h < 4
                  ? [0, x, c]
                  : h < 5
                    ? [x, 0, c]
                    : [c, 0, x];
        if ([h, s, l].every(Number.isFinite)) return hex(rgb.map((n) => (n + m) * 255));
      }
    }
  }
  throw new PreparationError(
    'This paint uses a gradient, pattern, or unsupported color space. Re-export with solid RGB fill and stroke.',
  );
}
