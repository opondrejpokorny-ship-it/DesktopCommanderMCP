import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface RemoteDeviceIdentity {
    deviceId: string;
}

export const REMOTE_DEVICE_CONFIG_FILE = path.join(
    os.homedir(),
    '.desktop-commander-device',
    'device.json',
);

/**
 * Read only the public identity needed for Team policy targeting.
 *
 * The Remote Device config also contains authentication tokens. This function
 * intentionally never returns the parsed config object or session fields.
 */
export async function loadRemoteDeviceIdentity(
    configPath: string = REMOTE_DEVICE_CONFIG_FILE,
): Promise<RemoteDeviceIdentity | null> {
    let raw: string;

    try {
        raw = await fs.readFile(configPath, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return null;
        }
        throw error;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }

    if (!parsed || typeof parsed !== 'object') {
        return null;
    }

    const deviceId = (parsed as Record<string, unknown>).deviceId;
    if (typeof deviceId !== 'string' || deviceId.trim().length === 0) {
        return null;
    }

    return { deviceId: deviceId.trim() };
}
