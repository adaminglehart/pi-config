/** True-color light for the four-row ASCII scenes. No terminal background fill. */
export type RGB = readonly [number, number, number];
export type Palette = readonly [RGB, RGB, ...RGB[]];

export function spectralColor(palette: Palette, phase: number): RGB {
  const position = ((phase % 1 + 1) % 1) * palette.length;
  const index = Math.floor(position);
  const from = palette[index]!;
  const to = palette[(index + 1) % palette.length]!;
  const fraction = position - index;
  const blend = fraction * fraction * (3 - 2 * fraction);
  return [
    from[0] + (to[0] - from[0]) * blend,
    from[1] + (to[1] - from[1]) * blend,
    from[2] + (to[2] - from[2]) * blend,
  ];
}

export function lightGlyph(glyph: string, color: RGB, light: number): string {
  if (glyph === " ") return " ";
  // Four-level channel steps reduce ANSI churn without visible palette bands.
  const channel = (value: number): number =>
    Math.min(255, Math.max(0, Math.round(value * light / 4) * 4));
  return `\x1b[38;2;${channel(color[0])};${channel(color[1])};${channel(color[2])}m${glyph}`;
}
