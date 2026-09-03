import { z } from 'zod';

const textArray = z.array(z.string().min(1).max(1000)).max(100);
const affectedAreas = z.array(z.string().min(1).max(500)).min(1).max(100);
const riskAreas = z.array(z.string().min(1).max(200)).max(100);

export const ActiveWorkRegistryToolArgsSchema = z.object({
    action: z.enum(['check', 'register', 'list', 'update', 'remove']),
    projectRoot: z.string().min(1),
    entryId: z.string().min(1).max(200).optional(),
    title: z.string().min(1).max(300).optional(),
    scope: z.string().min(1).max(2000).optional(),
    affectedAreas: affectedAreas.optional(),
    riskAreas: riskAreas.optional(),
    target: z.string().min(1).max(500).optional(),
    safeParallelWork: textArray.optional(),
    nextAction: z.string().min(1).max(2000).optional(),
    conflictRisk: z.string().min(1).max(2000).optional(),
});

const candidateFields = {
    projectRoot: z.string().min(1),
    title: z.string().min(1).max(300),
    scope: z.string().min(1).max(2000),
    affectedAreas,
    riskAreas: riskAreas.optional(),
};

export const ActiveWorkRegistryArgsSchema = z.discriminatedUnion('action', [
    z.object({
        action: z.literal('check'),
        ...candidateFields,
    }),
    z.object({
        action: z.literal('register'),
        ...candidateFields,
        target: z.string().min(1).max(500).optional(),
        safeParallelWork: textArray.optional(),
        nextAction: z.string().min(1).max(2000).optional(),
        conflictRisk: z.string().min(1).max(2000).optional(),
    }),
    z.object({
        action: z.literal('list'),
        projectRoot: z.string().min(1),
    }),
    z.object({
        action: z.literal('update'),
        projectRoot: z.string().min(1),
        entryId: z.string().min(1).max(200),
        title: z.string().min(1).max(300).optional(),
        scope: z.string().min(1).max(2000).optional(),
        affectedAreas: affectedAreas.optional(),
        riskAreas: riskAreas.optional(),
        target: z.string().min(1).max(500).optional(),
        safeParallelWork: textArray.optional(),
        nextAction: z.string().min(1).max(2000).optional(),
        conflictRisk: z.string().min(1).max(2000).optional(),
    }),
    z.object({
        action: z.literal('remove'),
        projectRoot: z.string().min(1),
        entryId: z.string().min(1).max(200),
    }),
]);
