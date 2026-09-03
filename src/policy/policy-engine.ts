import path from 'node:path';
import {
    PolicyContext,
    PolicyEvaluation,
    PolicyRule,
} from './types.js';

function genericResourceMatches(
    resource: string | undefined,
    prefix: string | undefined,
): boolean {
    if (!prefix) {
        return true;
    }

    if (!resource) {
        return false;
    }

    return resource === prefix || resource.startsWith(
        prefix.endsWith('/') || prefix.endsWith('\\')
            ? prefix
            : `${prefix}/`,
    ) || resource.startsWith(
        prefix.endsWith('/') || prefix.endsWith('\\')
            ? prefix
            : `${prefix}\\`,
    );
}

function commandResourceMatches(
    resource: string | undefined,
    prefix: string | undefined,
): boolean {
    if (!prefix) {
        return true;
    }

    if (!resource) {
        return false;
    }

    const normalizedPrefix = prefix.trim();
    const normalizedResource = resource.trim();

    if (!normalizedPrefix) {
        return true;
    }

    if (normalizedResource === normalizedPrefix) {
        return true;
    }

    if (!normalizedResource.startsWith(normalizedPrefix)) {
        return false;
    }

    const nextCharacter = normalizedResource.charAt(normalizedPrefix.length);
    return /\s|[;&|()]/.test(nextCharacter);
}

function looksLikeWindowsPath(value: string): boolean {
    return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

function filesystemResourceMatches(
    resource: string | undefined,
    prefix: string | undefined,
): boolean {
    if (!prefix) {
        return true;
    }

    if (!resource) {
        return false;
    }

    const windowsStyle =
        looksLikeWindowsPath(resource) || looksLikeWindowsPath(prefix);
    const flavor = windowsStyle ? path.win32 : path.posix;

    let normalizedResource = windowsStyle
        ? flavor.normalize(resource.replace(/\//g, '\\')).toLowerCase()
        : flavor.normalize(resource);
    let normalizedPrefix = windowsStyle
        ? flavor.normalize(prefix.replace(/\//g, '\\')).toLowerCase()
        : flavor.normalize(prefix);

    // path.relative handles dot-segments and path boundaries correctly. It is
    // intentionally lexical: symlink resolution remains the responsibility of
    // Desktop Commander's existing validatePath()/filesystem guardrails.
    const relative = flavor.relative(normalizedPrefix, normalizedResource);

    return (
        relative === '' ||
        (
            relative !== '..' &&
            !relative.startsWith(`..${flavor.sep}`) &&
            !flavor.isAbsolute(relative)
        )
    );
}

function ruleMatches(context: PolicyContext, rule: PolicyRule): boolean {
    if (context.action !== rule.action) {
        return false;
    }

    if (rule.deviceId && rule.deviceId !== context.deviceId) {
        return false;
    }

    if (context.action.startsWith('filesystem.')) {
        return filesystemResourceMatches(
            context.resource,
            rule.resourcePrefix,
        );
    }

    if (context.action === 'terminal.execute') {
        return commandResourceMatches(
            context.resource,
            rule.resourcePrefix,
        );
    }

    return genericResourceMatches(context.resource, rule.resourcePrefix);
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

    let matchedRule: PolicyRule | undefined;
    let bestResourceSpecificity = -1;
    let bestDeviceSpecificity = -1;

    for (const rule of rules) {
        if (!ruleMatches(context, rule)) {
            continue;
        }

        // A nested resource rule must beat a broader folder rule regardless of
        // which one was edited most recently. Rules without a resource prefix
        // (for example profile defaults) are least specific.
        const resourceSpecificity = rule.resourcePrefix?.length ?? 0;
        const deviceSpecificity = rule.deviceId ? 1 : 0;

        if (
            !matchedRule ||
            resourceSpecificity > bestResourceSpecificity ||
            (
                resourceSpecificity === bestResourceSpecificity &&
                deviceSpecificity > bestDeviceSpecificity
            )
        ) {
            matchedRule = rule;
            bestResourceSpecificity = resourceSpecificity;
            bestDeviceSpecificity = deviceSpecificity;
        }
    }

    if (!matchedRule) {
        return { decision: 'allow' };
    }

    return {
        decision: matchedRule.decision,
        matchedRuleId: matchedRule.id,
    };
}
