/** On-chain pool tick bounds (`contracts/pool/src/lib.rs`). */
export const POOL_MIN_TICK = -443636;
export const POOL_MAX_TICK = 443636;
/** Tick spacing for 30 bps fee tier (default deployed pools). */
export const POOL_TICK_SPACING = 60;

/** Widest valid tick range aligned to pool tick spacing. */
export function fullRangeTicks(spacing = POOL_TICK_SPACING): {
  tickLower: number;
  tickUpper: number;
} {
  const tickLower = Math.ceil(POOL_MIN_TICK / spacing) * spacing;
  const tickUpper = Math.floor(POOL_MAX_TICK / spacing) * spacing;
  return { tickLower, tickUpper };
}

export function assertValidTickRange(tickLower: number, tickUpper: number, spacing = POOL_TICK_SPACING): void {
  if (tickLower >= tickUpper) throw new Error("tickLower must be < tickUpper");
  if (tickLower < POOL_MIN_TICK || tickUpper > POOL_MAX_TICK) {
    throw new Error(`Ticks must be within [${POOL_MIN_TICK}, ${POOL_MAX_TICK}]`);
  }
  if (tickLower % spacing !== 0 || tickUpper % spacing !== 0) {
    throw new Error(`Ticks must be multiples of tick spacing (${spacing})`);
  }
}
