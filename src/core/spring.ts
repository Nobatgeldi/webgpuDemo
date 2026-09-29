/**
 * Critically damped spring: moves a value towards a target as fast as
 * possible without overshoot. Exact integration of x'' = -w^2 (x - t) - 2 w x',
 * so it is stable for any time step.
 */
export interface SpringState {
  value: number;
  velocity: number;
}

/**
 * Advances `state` towards `target` by `dt` seconds with angular frequency
 * `omega` (rad/s; roughly the inverse of the response time).
 */
export function stepCriticalSpring(state: SpringState, target: number, omega: number, dt: number): void {
  const x0 = state.value - target;
  const v0 = state.velocity;
  const decay = Math.exp(-omega * dt);
  const c = v0 + omega * x0;
  state.value = target + (x0 + c * dt) * decay;
  state.velocity = (v0 - omega * c * dt) * decay;
}

/** Wraps an angle difference to (-pi, pi]. */
export function wrapAngle(angle: number): number {
  return angle - 2 * Math.PI * Math.floor((angle + Math.PI) / (2 * Math.PI));
}
