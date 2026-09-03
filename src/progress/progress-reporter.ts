import type { ProductTier } from '../entitlements/capabilities.js';

export interface ProgressReportInput {
    percentRemaining: number;
    currentPhase: string;
    estimatedRemainingMinutes: number;
}

export interface ProgressAccess {
    tier: ProductTier;
    includeEta: boolean;
}

export interface ProgressReportBase {
    tier: ProductTier;
    percentRemaining: number;
    percentComplete: number;
    currentPhase: string;
    message: string;
}

export interface PaidProgressReport extends ProgressReportBase {
    estimatedRemainingMinutes: number;
    estimatedRemainingText: string;
}

export type ProgressReport = ProgressReportBase | PaidProgressReport;

function normalizePercent(value: number): number {
    if (!Number.isFinite(value)) {
        throw new Error('percentRemaining must be a finite number');
    }

    return Math.min(100, Math.max(0, Math.round(value)));
}

export function formatEstimatedRemainingTime(minutes: number): string {
    if (!Number.isFinite(minutes) || minutes < 0) {
        throw new Error('estimatedRemainingMinutes must be a non-negative finite number');
    }

    if (minutes === 0) {
        return 'complete';
    }

    const roundedMinutes = Math.max(5, Math.round(minutes / 5) * 5);

    if (roundedMinutes < 60) {
        return `about ${roundedMinutes} min`;
    }

    const hours = Math.floor(roundedMinutes / 60);
    const remainder = roundedMinutes % 60;

    if (remainder === 0) {
        return `about ${hours} h`;
    }

    return `about ${hours} h ${remainder} min`;
}

export function buildProgressReport(
    input: ProgressReportInput,
    access: ProgressAccess,
): ProgressReport {
    const percentRemaining = normalizePercent(input.percentRemaining);
    const percentComplete = 100 - percentRemaining;
    const currentPhase = input.currentPhase.trim();

    if (!currentPhase) {
        throw new Error('currentPhase must not be empty');
    }

    const base: ProgressReportBase = {
        tier: access.tier,
        percentRemaining,
        percentComplete,
        currentPhase,
        message: `${percentRemaining}% remaining. Current phase: ${currentPhase}.`,
    };

    if (!access.includeEta) {
        return base;
    }

    const estimatedRemainingText = formatEstimatedRemainingTime(
        input.estimatedRemainingMinutes,
    );

    return {
        ...base,
        estimatedRemainingMinutes: input.estimatedRemainingMinutes,
        estimatedRemainingText,
        message:
            `${percentRemaining}% remaining. Estimated time remaining: ` +
            `${estimatedRemainingText}. Current phase: ${currentPhase}.`,
    };
}
