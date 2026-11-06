/**
 * RYA points of sail from the true wind angle (degrees, either sign) and whether the boom is
 * on the windward side (sailing by the lee). Boundaries are the usual teaching ones; the no-go
 * zone edge suits an ISO (≈40° off the true wind).
 */
export interface PointOfSail { name: string; zone: number }

export const SAIL_ZONES: ReadonlyArray<{ name: string; from: number; to: number; color: string }> = [
  { name: 'No-go zone', from: 0, to: 40, color: '#c0392b' },
  { name: 'Close hauled', from: 40, to: 55, color: '#e67e22' },
  { name: 'Close reach', from: 55, to: 80, color: '#f1c40f' },
  { name: 'Beam reach', from: 80, to: 100, color: '#2ecc71' },
  { name: 'Broad reach', from: 100, to: 150, color: '#1abc9c' },
  { name: 'Training run', from: 150, to: 170, color: '#3498db' },
  { name: 'Run', from: 170, to: 180.01, color: '#6c5ce7' },
];

export function pointOfSail(twaDeg: number, boomOnWindwardSide: boolean): PointOfSail {
  const a = Math.min(180, Math.abs(twaDeg));
  if (boomOnWindwardSide && a > 150) return { name: 'By the lee', zone: 6 };
  const zone = SAIL_ZONES.findIndex((z) => a >= z.from && a < z.to);
  return { name: SAIL_ZONES[zone].name, zone };
}

/** Tack is named after the side the wind comes over, i.e. opposite the boom. */
export const tackName = (boomAngle: number) => (boomAngle < 0 ? 'Starboard tack' : 'Port tack');
