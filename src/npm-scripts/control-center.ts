#!/usr/bin/env node

import { startControlCenter } from '../control-center/server.js';

function parsePort(value: string | undefined): number | undefined {
    if (value === undefined) {
        return undefined;
    }

    const port = Number.parseInt(value, 10);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error('Control Center port must be an integer between 0 and 65535.');
    }
    return port;
}

async function main(): Promise<void> {
    const port = parsePort(
        process.argv[2] ?? process.env.DESKTOP_COMMANDER_CONTROL_CENTER_PORT,
    );

    const running = await startControlCenter({ port });

    process.stdout.write(
        [
            'Desktop Commander Control Center is running locally.',
            running.url,
            'Press Ctrl+C to stop.',
            '',
        ].join('\n'),
    );

    const shutdown = async () => {
        await running.close();
        process.exit(0);
    };

    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
}

main().catch((error) => {
    process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
});
