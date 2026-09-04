export const OPERATIONAL_LESSON_CODES = [
  'enforcement_before_consuming_preflight',
  'client_provenance_untrusted',
  'tooling_availability_check',
  'shell_quoting_unreliable',
  'tool_timeout_not_test_failure',
  'flaky_test_isolate',
  'connection_generation_guard',
  'parallel_checkout_conflict',
  'child_env_wrapper_required',
  'fetch_required_git_refs',
  'governance_recheck_before_side_effect',
  'per_action_preflight_required',
] as const;

export type OperationalLessonCode = typeof OPERATIONAL_LESSON_CODES[number];

export interface OperationalLessonTemplate {
  summary: string;
  lesson: string;
}

export const OPERATIONAL_LESSON_TEMPLATES: Record<
  OperationalLessonCode,
  OperationalLessonTemplate
> = {
  enforcement_before_consuming_preflight: {
    summary: 'A reusable ordering lesson was recorded for enforcement and approval preflight.',
    lesson: 'Run non-authorizing enforcement checks before any preflight that can consume a one-time approval.',
  },
  client_provenance_untrusted: {
    summary: 'A reusable provenance lesson was recorded for client-controlled origin metadata.',
    lesson: 'Do not treat client-controlled origin or provenance fields as a security or operational-memory exemption.',
  },
  tooling_availability_check: {
    summary: 'A reusable tooling-availability lesson was recorded.',
    lesson: 'Check whether an optional CLI is available before depending on it; prefer repository-provided tooling when available.',
  },
  shell_quoting_unreliable: {
    summary: 'A reusable shell-quoting lesson was recorded.',
    lesson: 'Avoid complex inline shell patching when quoting is fragile; prefer structured file editing or a short temporary script that is removed afterwards.',
  },
  tool_timeout_not_test_failure: {
    summary: 'A reusable timeout-interpretation lesson was recorded.',
    lesson: 'A tool wait timeout does not prove the underlying process or test failed; inspect process completion and exit evidence.',
  },
  flaky_test_isolate: {
    summary: 'A reusable flaky-test lesson was recorded.',
    lesson: 'Re-run a suspected flaky or concurrency-sensitive test in isolation before classifying it as a regression.',
  },
  connection_generation_guard: {
    summary: 'A reusable connection-generation lesson was recorded.',
    lesson: 'Ignore late failures from stale connection generations and perform bounded cleanup after failed initialization.',
  },
  parallel_checkout_conflict: {
    summary: 'A reusable parallel-edit lesson was recorded.',
    lesson: 'Before editing shared security or workflow areas, verify active ownership and checkout stability to avoid parallel-write races.',
  },
  child_env_wrapper_required: {
    summary: 'A reusable child-environment lesson was recorded.',
    lesson: 'When a child transport does not propagate required test environment overrides, use an isolated wrapper that sets them inside the child.',
  },
  fetch_required_git_refs: {
    summary: 'A reusable Git-ref lesson was recorded.',
    lesson: 'Before merge-base or release comparisons, verify required remote refs exist locally and fetch missing refs explicitly.',
  },
  governance_recheck_before_side_effect: {
    summary: 'A reusable governance-drift lesson was recorded.',
    lesson: 'Re-check governance immediately before a protected side effect and before an exact retry after approval.',
  },
  per_action_preflight_required: {
    summary: 'A reusable policy-preflight lesson was recorded.',
    lesson: 'Use the backend per-action preflight; project-level gating alone may miss a more-specific applicable rule.',
  },
};

export function isOperationalLessonCode(value: unknown): value is OperationalLessonCode {
  return typeof value === 'string' &&
    (OPERATIONAL_LESSON_CODES as readonly string[]).includes(value);
}
