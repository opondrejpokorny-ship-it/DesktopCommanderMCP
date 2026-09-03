#!/usr/bin/env node

import { listApprovals, setApprovalDecision } from '../policy/approval-store.js';
import { listAuditEvents } from '../policy/audit-store.js';
import { loadPolicyRuntimeConfig } from '../policy/policy-runtime.js';

function printJson(value: unknown): void {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message: string, exitCode = 1): never {
    process.stderr.write(`${message}\n`);
    process.exit(exitCode);
}

async function main(): Promise<void> {
    const [command, value] = process.argv.slice(2);

    switch (command) {
        case 'approvals': {
            const approvals = await listApprovals();
            printJson(approvals);
            return;
        }

        case 'approve':
        case 'deny': {
            if (!value) {
                fail(`Usage: access-control ${command} <approval-request-id>`);
            }

            const decision = command === 'approve' ? 'approved' : 'denied';
            const record = await setApprovalDecision(value, decision);

            if (!record) {
                fail(`Approval request not found or not pending: ${value}`);
            }

            printJson(record);
            return;
        }

        case 'policy': {
            const policy = await loadPolicyRuntimeConfig();
            printJson(policy);
            return;
        }

        case 'audit': {
            const events = await listAuditEvents();
            printJson(events);
            return;
        }

        case 'help':
        case '--help':
        case '-h':
        case undefined:
            process.stdout.write(
                [
                    'Desktop Commander prototype access control',
                    '',
                    'Commands:',
                    '  approvals              List approval requests',
                    '  approve <request-id>   Approve one pending request',
                    '  deny <request-id>      Deny one pending request',
                    '  policy                 Show the active access policy',
                    '  audit                  Show recent Team audit events',
                    '',
                    'This CLI is intentionally outside the MCP tool surface.',
                    'An AI client cannot call it through Desktop Commander tools.',
                    '',
                ].join('\n'),
            );
            return;

        default:
            fail(`Unknown command: ${command}. Run with --help for usage.`);
    }
}

main().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
});
