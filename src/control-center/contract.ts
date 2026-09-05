import type {
    Capability,
    EntitlementProvider,
    EntitlementSnapshot,
} from '../entitlements/capabilities.js';

export type ControlCenterMethodV1 = 'GET' | 'POST';

export interface ControlCenterJsonResponseV1 {
    status: number;
    body: unknown;
}

export interface ControlCenterRequestContextV1 {
    method: ControlCenterMethodV1;
    pathname: string;
    params: Readonly<Record<string, string>>;
    query: Readonly<Record<string, readonly string[]>>;
    entitlement: EntitlementSnapshot;
    readJsonBody(maxBytes?: number): Promise<unknown>;
}

export interface ControlCenterRouteV1 {
    method: ControlCenterMethodV1;
    apiPrefix: `/api/${string}`;
    path: string;
    requiredCapabilities?: readonly Capability[];
    handle(
        context: ControlCenterRequestContextV1,
    ): Promise<ControlCenterJsonResponseV1>;
}
export interface ControlCenterUiContributionV1 {
    viewId: string;
    label: string;
    html: string;
    script?: string;
}

export interface ControlCenterExtensionV1 {
    id: string;
    apiPrefixes: readonly `/api/${string}`[];
    requiredCapabilities?: readonly Capability[];
    routes: readonly ControlCenterRouteV1[];
    ui?: ControlCenterUiContributionV1;
}

export interface ControlCenterHostOptionsV1 {
    host?: '127.0.0.1' | 'localhost' | '::1';
    port?: number;
    token?: string;
    quiet?: boolean;
    entitlementProvider?: EntitlementProvider;
    extensions?: readonly ControlCenterExtensionV1[];
}

export interface RunningControlCenterHostV1 {
    host: string;
    port: number;
    token: string;
    url: string;
    close(): Promise<void>;
}
