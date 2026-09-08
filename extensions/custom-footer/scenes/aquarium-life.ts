export const AQUARIUM_ROWS = 3;

const FISH = [
  ["><>", "}<>"],
  ["><((o>", "}<((o>"],
  ["><{o>", "}<|o>"],
  ["><(((o>", "}<(((o>"],
  ["~<o>~", "^<o>^"],
] as const;
const CRAB = ["v(o_o)v", "\\(o_o)/"] as const;
const MIRROR: Readonly<Record<string, string>> = {
  "<": ">", ">": "<", "(": ")", ")": "(", "{": "}", "}": "{", "/": "\\", "\\": "/",
};

export interface AquariumCreature {
  x: number;
  row: number;
  sprite: string;
  hue: number;
}

/** Stable random samples: a fish changes only when it starts a new journey. */
export function aquariumRandom(seed: number, index: number): number {
  let value = (seed + Math.imul(index, 0x9e3779b9)) | 0;
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad);
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97);
  return ((value ^ (value >>> 15)) >>> 0) / 0x100000000;
}

/** Spaced swimming lanes prevent creatures from drawing over one another. */
export function aquariumCreatures(
  width: number,
  seconds: number,
  seed: number,
  extraFish = 0,
): AquariumCreature[] {
  if (width <= 0) return [];
  const margin = 10;
  const track = width + margin * 2;
  const slots = Math.max(2, Math.floor(track / 18));
  const spacing = track / slots;
  const creatures: AquariumCreature[] = [];

  for (let row = 0; row < AQUARIUM_ROWS; row++) {
    const direction = row === 1 ? -1 : 1;
    const speed = 1.9 + aquariumRandom(seed, row + 1) * 1.5 + (row === 1 ? 0.7 : 0);
    const start = aquariumRandom(seed, row + 10) * track;
    for (let slot = 0; slot < slots; slot++) {
      const id = row * 1009 + slot * 17;
      const jitter = (aquariumRandom(seed, id + 20) - 0.5) * spacing * 0.24;
      const travel = seconds * speed + slot * spacing + jitter + start;
      const journey = Math.floor(travel / track);
      const progress = travel - journey * track;
      const birth = id + journey * 7919;
      // Two of every three slots always contain a creature. Optional slots
      // change occupancy offscreen, never by popping into the middle of a lane.
      const optional = slot % 3 === 2;
      const optionalIndex = row * Math.floor(slots / 3) + Math.floor(slot / 3);
      if (optional && optionalIndex >= extraFish && aquariumRandom(seed, birth + 30) < 0.4) continue;

      const fin = Math.floor(seconds * (1.6 + aquariumRandom(seed, birth + 40))
        + aquariumRandom(seed, birth + 41) * 8) % 2;
      const species = Math.floor(aquariumRandom(seed, birth + 50) * FISH.length);
      const crab = row === 2 && aquariumRandom(seed, birth + 51) > 0.8;
      let sprite: string = crab ? CRAB[fin]! : FISH[species]![fin]!;
      if (direction === -1) {
        sprite = [...sprite].reverse().map((glyph) => MIRROR[glyph] ?? glyph).join("");
      }
      const drift = Math.sin(seconds * 0.6 + id) * 1.25
        + Math.sin(seconds * 0.31 + id * 2.1) * 0.55;
      const x = Math.floor((direction === 1 ? progress - margin
        : width + margin - progress - sprite.length) + drift);
      if (x + sprite.length <= 0 || x >= width) continue;
      creatures.push({ x, row, sprite, hue: aquariumRandom(seed, birth + 60) });
    }
  }
  return creatures;
}
