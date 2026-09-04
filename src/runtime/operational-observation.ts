import type { ServerResult } from '../types.js';

export type OperationalObservation =
  | { reasonCode: 'process_exit_nonzero' }
  | { reasonCode: 'process_wait_timeout' };

const observations = new WeakMap<ServerResult, OperationalObservation>();

export function setOperationalObservation(
  result: ServerResult,
  observation: OperationalObservation,
): ServerResult {
  observations.set(result, observation);
  return result;
}

export function getOperationalObservation(
  result: ServerResult,
): OperationalObservation | undefined {
  return observations.get(result);
}
