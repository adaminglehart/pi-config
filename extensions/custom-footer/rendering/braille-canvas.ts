import { lightGlyph, type RGB } from "./spectral-color.js";

const DOT_BITS = [[1, 2, 4, 64], [8, 16, 32, 128]] as const;

/** A four-row light buffer. Each terminal cell holds eight square subpixels. */
export class BrailleCanvas {
  readonly dotWidth: number;
  readonly dotHeight = 16;
  private readonly light: Float32Array;
  private readonly red: Float32Array;
  private readonly green: Float32Array;
  private readonly blue: Float32Array;

  constructor(readonly width: number) {
    this.dotWidth = Math.max(0, width) * 2;
    const size = this.dotWidth * this.dotHeight;
    this.light = new Float32Array(size);
    this.red = new Float32Array(size);
    this.green = new Float32Array(size);
    this.blue = new Float32Array(size);
  }

  addDot(x: number, y: number, energy: number, color: RGB): void {
    if (x < 0 || x >= this.dotWidth || y < 0 || y >= this.dotHeight) return;
    const index = y * this.dotWidth + x;
    this.light[index]! += energy;
    this.red[index]! += color[0] * energy;
    this.green[index]! += color[1] * energy;
    this.blue[index]! += color[2] * energy;
  }

  /** Bilinear splats let projected curves and comet heads move between dots. */
  splat(x: number, y: number, energy: number, color: RGB): void {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    this.addDot(ix, iy, energy * (1 - fx) * (1 - fy), color);
    this.addDot(ix + 1, iy, energy * fx * (1 - fy), color);
    this.addDot(ix, iy + 1, energy * (1 - fx) * fy, color);
    this.addDot(ix + 1, iy + 1, energy * fx * fy, color);
  }

  render(): string[] {
    const lines: string[] = [];
    for (let row = 0; row < 4; row++) {
      let line = "";
      for (let col = 0; col < this.width; col++) {
        let mask = 0;
        let peak = 0;
        let total = 0;
        let red = 0;
        let green = 0;
        let blue = 0;
        for (let dx = 0; dx < 2; dx++) {
          for (let dy = 0; dy < 4; dy++) {
            const index = (row * 4 + dy) * this.dotWidth + col * 2 + dx;
            const energy = this.light[index]!;
            if (energy > 0.16) mask |= DOT_BITS[dx]![dy]!;
            peak = Math.max(peak, energy);
            total += energy;
            red += this.red[index]!;
            green += this.green[index]!;
            blue += this.blue[index]!;
          }
        }
        if (mask === 0) {
          line += " ";
          continue;
        }
        const pearl = Math.min(0.45, Math.max(0, peak - 0.85) * 0.3);
        line += lightGlyph(String.fromCharCode(0x2800 + mask), [
          red / total * (1 - pearl) + 255 * pearl,
          green / total * (1 - pearl) + 255 * pearl,
          blue / total * (1 - pearl) + 255 * pearl,
        ], 0.42 + Math.min(1, peak) * 0.58);
      }
      lines.push(line + "\x1b[0m");
    }
    return lines;
  }
}
