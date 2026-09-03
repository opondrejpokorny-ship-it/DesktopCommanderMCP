import {
    PolicyContext,
    PolicyEvaluation,
    PolicyRule,
} from './types.js';

function resourceMatches(resource: string | undefined, prefix: string | undefined): boolean {
    if (!prefix) {
        return true;
    }

    if (!resource) {
        return false;
    }

    // Phase 1 intentionally keeps resources transport-neutral. Filesystem path
    // canonicalization remains the responsibility of Desktop Commander's existing
    // validatePath() guardrail and will be added to policy normalization when the
    // engine is wired into real tool execution.
    return resource === prefix || resource.startsWith(prefix.endsWith('/') || prefix.endsWith('\\')
        ? prefix
        : `${prefix}/`) || resource.startsWith(prefix.endsWith('/') || prefix.endsWith('\\')
        ? prefix
        : `${prefix}\\`);
}

function ruleMatches(context: PolicyContext, rule: PolicyRule): boolean {
    if (context.action !== rule.action) {
        return false;
    }

    if (rule.deviceId && rule.deviceId !== context.deviceId) {
        return false;
    }

    return resourceMatches(context.resource, rule.resourcePrefix);
}

/**
 * Evaluate prototype tier policies before existing Desktop Commander guardrails.
 *
 * Free intentionally preserves the current low-friction upstream behavior.
 * Pro/Team apply matching policy rules, while unmatched requests continue to
 * existing upstream validation and execution unchanged.
 */
export function evaluatePolicy(
    context: PolicyContext,
    rules: readonly PolicyRule[] = [],
): PolicyEvaluation {
    if (context.tier === 'free') {
        return { decision: 'allow' };
    }

    const matchedRule = rules.find((rule) => ruleMatches(context, rule));

    if (!matchedRule) {
        return { decision: 'allow' };
    }

    return {
        decision: matchedRule.decision,
        matchedRuleId: matchedRule.id,
    };
}
