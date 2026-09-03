import { CapabilityRegistry } from '../entitlements/capabilities.js';
import type { AuditSink } from '../policy/audit-sink.js';
import { FileAuditSink } from '../policy/audit-store.js';
import { PrototypeEntitlementProvider } from './prototype-entitlement-provider.js';

export async function getPrototypeAuditSink(
    auditPath?: string,
): Promise<AuditSink | undefined> {
    const entitlement = await new PrototypeEntitlementProvider().getEntitlement();
    const capabilities = new CapabilityRegistry(entitlement.capabilities);
    return capabilities.has('audit.local')
        ? new FileAuditSink(auditPath)
        : undefined;
}
