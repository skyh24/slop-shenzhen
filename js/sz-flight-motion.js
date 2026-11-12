// 手动飞行和巡游共用入场转向及前进加速的默认值。
export const FLIGHT_ENTRY_SECONDS = 1;
export const FLIGHT_FORWARD_ACCELERATION = 200 / 3.6;

export function flightEntryYaw(remaining, duration) {
  const t = Math.max(0, Math.min(1, remaining / duration));
  return Math.PI / 4 * t * t * (3 - 2 * t);
}

export function flightEnvelopeRadius(bounds) {
  return bounds ? Math.hypot(Math.max(-bounds.min.x, bounds.max.x), Math.max(-bounds.min.z, bounds.max.z)) : 4.5;
}
