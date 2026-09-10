import type {
    ControlCenterHostOptionsV1,
    RunningControlCenterHostV1,
} from './contract.js';
import { startControlCenterHost } from './host.js';
import { createMemoryControlCenterExtension } from './memory-extension.js';
import { createUsageControlCenterExtension } from './usage-extension.js';

export type ControlCenterOptions = Pick<
    ControlCenterHostOptionsV1,
    'host' | 'port' | 'token' | 'quiet'
>;
export type RunningControlCenter = RunningControlCenterHostV1;

export async function startControlCenter(
    options: ControlCenterOptions = {},
): Promise<RunningControlCenter> {
    return startControlCenterHost({
        ...options,
        extensions: [
            createMemoryControlCenterExtension(),
            createUsageControlCenterExtension(),
        ],
    });
}
