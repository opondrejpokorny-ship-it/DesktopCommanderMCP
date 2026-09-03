import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'url';
import { captureRemote } from '../utils/capture.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface McpConfig {
    command: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
}

export class DesktopCommanderIntegration {
    private mcpClient: Client | null = null;
    private mcpTransport: StdioClientTransport | null = null;
    private isReady: boolean = false;
    private reinitPromise: Promise<void> | null = null;
    private isShuttingDown: boolean = false;
    private connectionGeneration: number = 0;
    private disconnectHandler: ((reason: string) => void) | null = null;
    private localToolCount: number = 0;

    get ready(): boolean {
        return this.isReady && this.mcpClient !== null;
    }

    onDisconnect(handler: (reason: string) => void): void {
        this.disconnectHandler = handler;
    }

    private handleLocalDisconnect(reason: string, generation = this.connectionGeneration): void {
        if (this.isShuttingDown || generation !== this.connectionGeneration) return;
        const hadConnection = this.isReady;
        this.isReady = false;
        this.mcpClient = null;
        this.mcpTransport = null;
        this.connectionGeneration += 1;
        if (hadConnection) {
            void captureRemote('desktop_integration_local_disconnected', { reason });
            this.disconnectHandler?.(reason);
        }
    }

    private async runBounded<T>(operation: Promise<T>, label: string, timeoutMs = 5000): Promise<T> {
        let timer: NodeJS.Timeout | undefined;
        try {
            return await Promise.race([
                operation,
                new Promise<T>((_, reject) => {
                    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
                })
            ]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    private async closeGenerationResources(
        client: { close: () => Promise<void> },
        transport: { close: () => Promise<void> }
    ): Promise<void> {
        await Promise.allSettled([
            this.runBounded(client.close(), 'failed MCP client close', 3000),
            this.runBounded(transport.close(), 'failed MCP transport close', 3000)
        ]);
    }

    private isTransportFailure(error: unknown): boolean {
        const message = error instanceof Error ? error.message : String(error);
        return /not connected|connection closed|transport.*closed|stdio.*closed/i.test(message);
    }

    async initialize(): Promise<void> {
        if (this.isShuttingDown) throw new Error('Desktop Commander integration is shutting down');
        console.debug('[DEBUG] DesktopCommanderIntegration.initialize() called');
        const config = await this.resolveMcpConfig();
        if (!config) throw new Error('Desktop Commander MCP not found. Please install it globally via npm or build the local project.');

        const generation = ++this.connectionGeneration;
        const transport = new StdioClientTransport({
            ...config,
            env: { ...getDefaultEnvironment(), ...config.env, DC_REMOTE_DEVICE: 'true' }
        });
        const client = new Client({ name: 'desktop-commander-client', version: '1.0.0' }, { capabilities: {} });
        this.mcpTransport = transport;
        this.mcpClient = client;
        this.isReady = false;

        transport.onclose = () => this.handleLocalDisconnect('stdio transport closed', generation);
        transport.onerror = (error: Error) => this.handleLocalDisconnect(`stdio transport error: ${error?.message ?? String(error)}`, generation);

        try {
            console.log(` - ⏳ Connecting to Local Desktop Commander MCP using: ${config.command} ${config.args.join(' ')}`);
            await client.connect(transport);
            const probe = await this.runBounded(client.listTools(), 'local MCP tools/list probe');
            if (generation !== this.connectionGeneration || this.mcpClient !== client) {
                throw new Error('Local MCP connection generation changed during initialization');
            }
            this.localToolCount = probe.tools?.length ?? 0;
            this.isReady = true;
            console.log(` - 🔌 Connected to Desktop Commander MCP (${this.localToolCount} tools verified)`);
        } catch (error) {
            await this.closeGenerationResources(client, transport);
            if (generation === this.connectionGeneration) {
                this.handleLocalDisconnect(error instanceof Error ? error.message : String(error), generation);
            }
            await captureRemote('desktop_integration_init_failed', { error });
            throw error;
        }
    }

    async ensureReady(): Promise<void> {
        if (this.ready) return;
        if (this.isShuttingDown) throw new Error('Desktop Commander integration is shutting down');
        if (!this.reinitPromise) {
            this.reinitPromise = this.initialize().finally(() => { this.reinitPromise = null; });
        }
        await this.reinitPromise;
    }

    async resolveMcpConfig(): Promise<McpConfig | null> {
        console.debug('[DEBUG] Resolving MCP config...');
        // Option 1: Development/Local Build
        // Adjusting path resolution since we are now in src/remote-device and dist is in root/dist
        // Original: path.resolve(__dirname, '../../dist/index.js')
        const devPath = path.resolve(__dirname, '../../dist/index.js');
        console.debug('[DEBUG] Checking local dev path:', devPath);
        try {
            await fs.access(devPath);
            console.debug(' - 🔍 Found local MCP server at:', devPath);
            return {
                command: process.execPath, // Use the current node executable
                args: [devPath],
                cwd: path.dirname(devPath)
            };
        } catch {
            console.debug('[DEBUG] Local dev path not found, trying global installation');
            // Local file not found, continue...
        }

        // Option 2: Global Installation
        const commandName = 'desktop-commander';
        console.debug('[DEBUG] Checking for global command:', commandName);
        try {
            await new Promise<void>((resolve, reject) => {
                // Use platform-appropriate command to check if the command exists in PATH
                // We can't run it directly as it's an stdio MCP server that waits for input
                const whichCommand = process.platform === 'win32' ? 'where' : 'which';
                console.debug('[DEBUG] Using platform command:', whichCommand, 'on platform:', process.platform);
                const check = spawn(whichCommand, [commandName], { windowsHide: true });  // Prevent visible console windows on Windows
                check.on('error', (err) => {
                    console.debug('[DEBUG] Spawn error for', whichCommand, ':', err.message);
                    reject(err);
                });
                check.on('close', (code) => {
                    console.debug('[DEBUG]', whichCommand, 'exited with code:', code);
                    return code === 0 ? resolve() : reject(new Error('Command not found'));
                });
            });
            console.debug(' - Found global desktop-commander CLI');
            return {
                command: commandName,
                args: []
            };
        } catch (err) {
            console.debug('[DEBUG] Global command not found:', err);
            // Global command not found
        }

        console.debug('[DEBUG] No MCP config resolved');
        return null;
    }

    async callClientTool(toolName: string, args: any, metadata?: any) {
        await this.ensureReady();
        if (!this.isReady || !this.mcpClient) {
            console.debug('[DEBUG] callClientTool() failed - not ready or no client');
            throw new Error('DesktopIntegration not initialized');
        }

        const client = this.mcpClient;
        const generation = this.connectionGeneration;

        // Proxy other tools to MCP server. Never replay an uncertain tool call:
        // if the bridge dies after dispatch, the caller receives the failure and
        // any retry must be a fresh explicit remote request.
        try {
            console.debug('[DEBUG] Calling MCP tool:', toolName, 'args:', JSON.stringify(args).substring(0, 100));
            const result = await client.callTool({
                name: toolName,
                arguments: args,
                _meta: { remote: true, ...metadata || {} }
            } as any);
            console.debug('[DEBUG] Tool call successful:', toolName);
            return result;
        } catch (error) {
            console.error(`Error executing tool ${toolName}:`, error);
            console.debug('[DEBUG] Tool call error details:', error);
            await captureRemote('desktop_integration_tool_call_failed', { error, toolName });
            if (
                this.isTransportFailure(error) &&
                generation === this.connectionGeneration &&
                this.mcpClient === client
            ) {
                this.handleLocalDisconnect(
                    error instanceof Error ? error.message : String(error),
                    generation
                );
            }
            throw error;
        }
    }

    async listClientTools() {
        await this.ensureReady();
        if (!this.mcpClient) throw new Error('DesktopIntegration not initialized');
        const client = this.mcpClient;
        const generation = this.connectionGeneration;
        try {
            const mcpTools = await client.listTools();
            return { tools: mcpTools.tools || [] };
        } catch (error) {
            console.error('Error fetching capabilities:', error);
            await captureRemote('desktop_integration_list_tools_failed', { error });
            if (
                this.isTransportFailure(error) &&
                generation === this.connectionGeneration &&
                this.mcpClient === client
            ) {
                this.handleLocalDisconnect(
                    error instanceof Error ? error.message : String(error),
                    generation
                );
            }
            throw error;
        }
    }

    async shutdown() {
        this.isShuttingDown = true;
        console.debug('[DEBUG] DesktopCommanderIntegration.shutdown() called');
        const closeWithTimeout = async (operation: () => Promise<void>, name: string, timeoutMs: number = 3000) => {
            return Promise.race([
                operation(),
                new Promise<void>((_, reject) =>
                    setTimeout(() => reject(new Error(`${name} timeout after ${timeoutMs}ms`)), timeoutMs)
                )
            ]);
        };

        if (this.mcpClient) {
            try {
                console.log('  → Closing MCP client...');
                console.debug('[DEBUG] Calling mcpClient.close() with timeout');
                await closeWithTimeout(
                    () => this.mcpClient!.close(),
                    'MCP client close'
                );
                console.log('  ✓ MCP client closed');
            } catch (e: any) {
                console.warn('  ⚠️  MCP client close timeout or error:', e.message);
                console.debug('[DEBUG] MCP client close error:', e);
                await captureRemote('desktop_integration_shutdown_error', { error: e, component: 'client' });
            }
            this.mcpClient = null;
        }

        if (this.mcpTransport) {
            try {
                console.log('  → Closing MCP transport...');
                console.debug('[DEBUG] Calling mcpTransport.close() with timeout');
                await closeWithTimeout(
                    () => this.mcpTransport!.close(),
                    'MCP transport close'
                );
                console.log('  ✓ MCP transport closed');
            } catch (e: any) {
                console.warn('  ⚠️  MCP transport close timeout or error:', e.message);
                console.debug('[DEBUG] MCP transport close error:', e);
                await captureRemote('desktop_integration_shutdown_error', { error: e, component: 'transport' });
            }
            this.mcpTransport = null;
        }

        this.isReady = false;
        console.debug('[DEBUG] Desktop Commander integration shutdown complete');
    }
}
