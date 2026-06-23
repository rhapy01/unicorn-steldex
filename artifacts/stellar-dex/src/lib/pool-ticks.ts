export const POOL_MIN_TICK = -443636;
export const POOL_MAX_TICK = 443636;
export const POOL_TICK_SPACING = 60;

export function fullRangeTicks(spacing = POOL_TICK_SPACING): {
  tickLower: number;
  tickUpper: number;
} {
  const tickLower = Math.ceil(POOL_MIN_TICK / spacing) * spacing;
  const tickUpper = Math.floor(POOL_MAX_TICK / spacing) * spacing;
  return { tickLower, tickUpper };
}
