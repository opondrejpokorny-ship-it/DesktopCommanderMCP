#!/usr/bin/env node

import { listApprovals, setApprovalDecision } from '../policy/approval-store.js';
import { listAuditEvents } from '../policy/audit-store.js';
import {
    isCommandPermission,
    isDesktopCommanderTier,
    isFolderPermission,
    isPolicyProfile,
    loadPolicyRuntimeConfig,
    setCommandPermission,
    setFolderPermission,
    setPolicyDeviceId,
    setPolicyProfile,
    setPolicyTier,
} from '../policy/policy-runtime.js';

function printJson(value: unknown): void {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message: string, exitCode = 1): never {
    process.stderr.write(`${message}\n`);
    process.exit(exitCode);
}

async function main(): Promise<void> {
    const [command, value, second, third] = process.argv.slice(2);

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

        case 'set-tier': {
            if (!value || !isDesktopCommanderTier(value)) {
                fail('Invalid policy tier. Use free, pro, or team.');
            }
            printJson(await setPolicyTier(value));
            return;
        }

        case 'set-profile': {
            if (!value || !isPolicyProfile(value)) {
                fail('Invalid policy profile. Use full_access, safe_developer, or read_only.');
            }
            printJson(await setPolicyProfile(value));
            return;
        }

        case 'set-device': {
            if (!value) {
                fail('Usage: access-control set-device <device-id>');
            }
            printJson(await setPolicyDeviceId(value));
            return;
        }

        case 'set-folder': {
            if (!value || !isFolderPermission(value) || !second) {
                fail('Usage: access-control set-folder <permission> <absolute-path> [device-id]');
            }
            printJson(await setFolderPermission(second, value, undefined, third));
            return;
        }

        case 'set-command': {
            if (!value || !isCommandPermission(value) || !second) {
                fail('Usage: access-control set-command <permission> <command-prefix> [device-id]');
            }
            printJson(await setCommandPermission(second, value, undefined, third));
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
                    '  set-tier <tier>         Set free / pro / team',
                    '  set-profile <profile>   Set full_access / safe_developer / read_only',
                    '  set-device <device-id>  Bind policy identity to a device',
                    '  set-folder <permission> <absolute-path> [device-id]',
                    '  set-command <permission> <command-prefix> [device-id]',
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
