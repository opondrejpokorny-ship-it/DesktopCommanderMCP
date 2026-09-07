import { getPrototypeAuditSink } from '../prototype/prototype-audit-sink.js';
import { PrototypeEntitlementProvider } from '../prototype/prototype-entitlement-provider.js';
import type {
    ControlCenterHostOptionsV1,
    RunningControlCenterHostV1,
} from './contract.js';
import { createDemoControlCenterExtension } from './demo-extension.js';
import { startControlCenterHost } from './host.js';
import { createMemoryControlCenterExtension } from './memory-extension.js';
import { createProControlCenterExtension } from './pro-extension.js';
import { createTeamControlCenterExtension } from './team-extension.js';
import { createUsageControlCenterExtension } from './usage-extension.js';

export type ControlCenterOptions = Pick<
    ControlCenterHostOptionsV1,
    'host' | 'port' | 'token' | 'quiet'
>;
export type RunningControlCenter = RunningControlCenterHostV1;

export async function startControlCenter(
    options: ControlCenterOptions = {},
): Promise<RunningControlCenter> {
    const entitlementProvider = new PrototypeEntitlementProvider();
    const auditSink = await getPrototypeAuditSink();
    return startControlCenterHost({
        ...options,
        entitlementProvider,
        extensions: [
            createProControlCenterExtension({ auditSink }),
            createTeamControlCenterExtension(),
            createDemoControlCenterExtension(),
            createMemoryControlCenterExtension(),
            createUsageControlCenterExtension(),
        ],
    });
}
