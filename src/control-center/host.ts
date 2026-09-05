import crypto from 'node:crypto';
import http, { IncomingMessage, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import type { Capability, EntitlementSnapshot } from '../entitlements/capabilities.js';
import { FreeEntitlementProvider } from '../entitlements/free-provider.js';
import type {
    ControlCenterExtensionV1,
    ControlCenterHostOptionsV1,
    ControlCenterRequestContextV1,
    ControlCenterRouteV1,
    RunningControlCenterHostV1,
} from './contract.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 17831;
const API_TOKEN_HEADER = 'x-dc-control-token';
const MAX_BODY_BYTES = 8192;
const RESERVED_API_PREFIXES = ['/api/state'] as const;

interface CompiledRoute {
    extension: ControlCenterExtensionV1;
    route: ControlCenterRouteV1;
    matcher: RegExp;
    paramNames: readonly string[];
}

class RequestBodyError extends Error {}

function setSecurityHeaders(response: ServerResponse): void {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader(
        'Content-Security-Policy',
        [
            "default-src 'self'",
            "script-src 'unsafe-inline'",
            "style-src 'unsafe-inline'",
            "connect-src 'self'",
            "img-src 'self' data:",
            "frame-ancestors 'none'",
            "base-uri 'none'",
            "form-action 'self'",
        ].join('; '),
    );
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
    setSecurityHeaders(response);
    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(body));
}

function writeText(
    response: ServerResponse,
    status: number,
    text: string,
    contentType = 'text/plain; charset=utf-8',
): void {
    setSecurityHeaders(response);
    response.statusCode = status;
    response.setHeader('Content-Type', contentType);
    response.end(text);
}

function requestHeader(request: IncomingMessage, name: string): string | undefined {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
}

function tokensMatch(provided: string | undefined, expected: string): boolean {
    if (!provided) return false;
    const left = Buffer.from(provided);
    const right = Buffer.from(expected);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function isLoopbackHostname(hostname: string | null): boolean {
    return hostname === '127.0.0.1' || hostname === 'localhost' ||
        hostname === '::1' || hostname === '[::1]';
}

function hostnameFromHostHeader(value: string | undefined): string | null {
    if (!value) return null;
    try {
        return new URL(`http://${value}`).hostname.toLowerCase();
    } catch {
        return null;
    }
}

function hostHeaderIsLocal(request: IncomingMessage): boolean {
    return isLoopbackHostname(hostnameFromHostHeader(request.headers.host));
}

function mutationOriginIsLocal(request: IncomingMessage): boolean {
    const origin = requestHeader(request, 'origin');
    if (!origin) return true;
    try {
        return isLoopbackHostname(new URL(origin).hostname.toLowerCase());
    } catch {
        return false;
    }
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function namespacesOverlap(left: string, right: string): boolean {
    return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function compileRoute(route: ControlCenterRouteV1): { matcher: RegExp; paramNames: string[] } {
    if (!route.path.startsWith('/') || route.path.includes('*') || route.path.includes('?') || route.path.includes('#')) {
        throw new Error(`Invalid Control Center route path: ${route.path}`);
    }
    const segments = route.path === '/' ? [] : route.path.slice(1).split('/');
    if (segments.some((segment) => !segment)) {
        throw new Error(`Invalid Control Center route path: ${route.path}`);
    }
    const paramNames: string[] = [];
    const pattern = segments.map((segment) => {
        if (segment.startsWith(':')) {
            const name = segment.slice(1);
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || paramNames.includes(name)) {
                throw new Error(`Invalid Control Center route parameter: ${segment}`);
            }
            paramNames.push(name);
            return '([^/]+)';
        }
        if (!/^[A-Za-z0-9._~-]+$/.test(segment)) {
            throw new Error(`Invalid Control Center route segment: ${segment}`);
        }
        return escapeRegex(segment);
    }).join('/');
    const suffix = route.path === '/' ? '/' : `/${pattern}`;
    return {
        matcher: new RegExp(`^${escapeRegex(route.apiPrefix)}${suffix}$`),
        paramNames,
    };
}

function validateExtensions(extensions: readonly ControlCenterExtensionV1[]): CompiledRoute[] {
    const ids = new Set<string>();
    const prefixes: string[] = [];
    const viewIds = new Set<string>();
    const routeKeys = new Set<string>();
    const compiled: CompiledRoute[] = [];

    for (const extension of extensions) {
        if (!/^[a-z0-9][a-z0-9._-]*$/i.test(extension.id) || ids.has(extension.id)) {
            throw new Error(`Invalid or duplicate Control Center extension ID: ${extension.id}`);
        }
        ids.add(extension.id);
        if (!extension.apiPrefixes.length) {
            throw new Error(`Control Center extension ${extension.id} must own an API namespace`);
        }
        for (const prefix of extension.apiPrefixes) {
            if (!/^\/api\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(prefix)) {
                throw new Error(`Invalid Control Center API namespace: ${prefix}`);
            }
            if (RESERVED_API_PREFIXES.some((reserved) => namespacesOverlap(prefix, reserved))) {
                throw new Error(`Control Center API namespace is reserved: ${prefix}`);
            }
            if (prefixes.some((other) => namespacesOverlap(prefix, other))) {
                throw new Error(`Control Center API namespace collision: ${prefix}`);
            }
            prefixes.push(prefix);
        }
        if (extension.ui) {
            if (!extension.ui.viewId || viewIds.has(extension.ui.viewId)) {
                throw new Error(`Invalid or duplicate Control Center view ID: ${extension.ui.viewId}`);
            }
            viewIds.add(extension.ui.viewId);
        }
        for (const route of extension.routes) {
            if (route.method !== 'GET' && route.method !== 'POST') {
                throw new Error(`Unsupported Control Center route method: ${route.method}`);
            }
            if (!extension.apiPrefixes.includes(route.apiPrefix)) {
                throw new Error(`Control Center route prefix is not owned by ${extension.id}: ${route.apiPrefix}`);
            }
            const key = `${route.method} ${route.apiPrefix}${route.path}`;
            if (routeKeys.has(key)) {
                throw new Error(`Duplicate Control Center route: ${key}`);
            }
            routeKeys.add(key);
            const compiledRoute = compileRoute(route);
            compiled.push({ extension, route, ...compiledRoute });
        }
    }

    return compiled;
}

function entitlementExpired(snapshot: EntitlementSnapshot): boolean {
    if (!snapshot.expiresAt) return false;
    const expiry = Date.parse(snapshot.expiresAt);
    return !Number.isFinite(expiry) || expiry <= Date.now();
}

function hasCapabilities(
    snapshot: EntitlementSnapshot,
    required: readonly Capability[],
): boolean {
    if (required.length === 0) return true;
    if (entitlementExpired(snapshot)) return false;
    const available = new Set(snapshot.capabilities);
    return required.every((capability) => available.has(capability));
}

function extensionIsActive(
    snapshot: EntitlementSnapshot,
    extension: ControlCenterExtensionV1,
): boolean {
    return hasCapabilities(snapshot, extension.requiredCapabilities ?? []);
}

function sanitizeEntitlement(snapshot: EntitlementSnapshot): EntitlementSnapshot {
    return {
        source: snapshot.source,
        tier: snapshot.tier,
        capabilities: [...snapshot.capabilities],
        ...(snapshot.expiresAt ? { expiresAt: snapshot.expiresAt } : {}),
    };
}

function activeExtensionMetadata(
    snapshot: EntitlementSnapshot,
    extensions: readonly ControlCenterExtensionV1[],
): Array<{ id: string; viewId?: string; label?: string }> {
    return extensions
        .filter((extension) => extensionIsActive(snapshot, extension))
        .map((extension) => ({
            id: extension.id,
            ...(extension.ui ? {
                viewId: extension.ui.viewId,
                label: extension.ui.label,
            } : {}),
        }));
}

function parseQuery(url: URL): Readonly<Record<string, readonly string[]>> {
    const values: Record<string, string[]> = Object.create(null);
    for (const [key, value] of url.searchParams) {
        const existing = values[key];
        if (existing) existing.push(value);
        else values[key] = [value];
    }
    for (const value of Object.values(values)) Object.freeze(value);
    return Object.freeze(values);
}

async function readJsonBody(
    request: IncomingMessage,
    requestedLimit = MAX_BODY_BYTES,
): Promise<unknown> {
    const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
        ? Math.min(requestedLimit, MAX_BODY_BYTES)
        : MAX_BODY_BYTES;
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > limit) throw new RequestBodyError('Request body is too large.');
        chunks.push(buffer);
    }
    if (chunks.length === 0) throw new RequestBodyError('Request body is required.');
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
        if (error instanceof RequestBodyError) throw error;
        throw new RequestBodyError('Invalid JSON request body.');
    }
}

function matchRoute(
    pathname: string,
    method: string | undefined,
    routes: readonly CompiledRoute[],
): { compiled: CompiledRoute; params: Readonly<Record<string, string>> } | null {
    for (const compiled of routes) {
        if (method !== compiled.route.method) continue;
        const match = compiled.matcher.exec(pathname);
        if (!match) continue;
        const params: Record<string, string> = Object.create(null);
        try {
            compiled.paramNames.forEach((name, index) => {
                params[name] = decodeURIComponent(match[index + 1]);
            });
        } catch {
            return null;
        }
        return { compiled, params: Object.freeze(params) };
    }
    return null;
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function renderControlCenterHtml(
    token: string,
    activeExtensions: readonly ControlCenterExtensionV1[],
): string {
    const serializedToken = JSON.stringify(token).replace(/</g, '\\u003c');
    const views = activeExtensions.filter((extension) => extension.ui);
    const navigation = views.map((extension) =>
        `<button data-dc-target="${escapeHtml(extension.ui!.viewId)}">${escapeHtml(extension.ui!.label)}</button>`,
    ).join('');
    const bodies = views.map((extension, index) =>
        `<section data-dc-view="${escapeHtml(extension.ui!.viewId)}"${index ? ' hidden' : ''}>${extension.ui!.html}</section>`,
    ).join('');
    const scripts = views.map((extension) => extension.ui!.script ?? '').join('\n');
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Desktop Commander Control Center</title>
<style>
:root{color-scheme:light dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif}*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:Canvas;color:CanvasText}main{width:min(1180px,calc(100% - 32px));margin:auto;padding:28px 0 48px}
header{display:flex;gap:20px;justify-content:space-between;align-items:center;margin-bottom:20px}nav{display:flex;gap:8px;flex-wrap:wrap}
button{border:1px solid color-mix(in srgb,CanvasText 22%,transparent);border-radius:10px;padding:8px 12px;background:Canvas;color:CanvasText;cursor:pointer}
.dc-empty{opacity:.68;padding:20px 0}code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
</style></head><body><main>
<header><div><small>Local · loopback only</small><h1>Desktop Commander Control Center</h1></div><code id="dc-entitlement">Loading…</code></header>
<nav id="dc-nav">${navigation}</nav><div id="dc-views">${bodies || '<div class="dc-empty">No additional controls are available.</div>'}</div>
</main><script>
const TOKEN=${serializedToken};
async function api(path,options={}){const headers=new Headers(options.headers||{});headers.set('X-DC-Control-Token',TOKEN);const response=await fetch(path,{...options,headers,cache:'no-store'});if(!response.ok){let message='Request failed ('+response.status+')';try{const body=await response.json();if(body&&body.error)message=body.error}catch{}throw new Error(message)}return response.json()}

function createElement(tag,text,className){const element=document.createElement(tag);if(text!==undefined)element.textContent=text;if(className)element.className=className;return element}
window.dcControlCenter=Object.freeze({api,createElement});for(const button of document.querySelectorAll('[data-dc-target]')){button.addEventListener('click',()=>{const target=button.dataset.dcTarget;for(const view of document.querySelectorAll('[data-dc-view]'))view.hidden=view.dataset.dcView!==target})}
api('/api/state').then((state)=>{document.getElementById('dc-entitlement').textContent=state.entitlement.tier}).catch(()=>{document.getElementById('dc-entitlement').textContent='Disconnected'});
${scripts}
</script></body></html>`;
}

export async function startControlCenterHost(
    options: ControlCenterHostOptionsV1 = {},
): Promise<RunningControlCenterHostV1> {
    const host = options.host ?? DEFAULT_HOST;
    if (!isLoopbackHostname(host)) {
        throw new Error('Control Center host must be a loopback address');
    }
    const port = options.port ?? DEFAULT_PORT;
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error('Invalid Control Center port');
    }
    if (options.token !== undefined && !options.token) {
        throw new Error('Control Center session token must not be empty');
    }
    const token = options.token ?? crypto.randomBytes(32).toString('base64url');
    const extensions = [...(options.extensions ?? [])];
    const compiledRoutes = validateExtensions(extensions);
    const entitlementProvider = options.entitlementProvider ?? new FreeEntitlementProvider();

    const server = http.createServer(async (request, response) => {
        try {
            if (!hostHeaderIsLocal(request)) {
                writeJson(response, 400, { error: 'Invalid local Host header.' });
                return;
            }
            const requestUrl = new URL(
                request.url ?? '/',
                `http://${request.headers.host}`,
            );
            if (request.method === 'GET' && requestUrl.pathname === '/') {
                const snapshot = await entitlementProvider.getEntitlement();
                const active = extensions.filter((extension) => extensionIsActive(snapshot, extension));
                writeText(
                    response,
                    200,
                    renderControlCenterHtml(token, active),
                    'text/html; charset=utf-8',
                );
                return;
            }
            if (request.method === 'GET' && requestUrl.pathname === '/favicon.ico') {
                setSecurityHeaders(response);
                response.statusCode = 204;
                response.end();
                return;
            }
            if (!requestUrl.pathname.startsWith('/api/')) {
                writeJson(response, 404, { error: 'Not found.' });
                return;
            }
            if (!tokensMatch(requestHeader(request, API_TOKEN_HEADER), token)) {
                writeJson(response, 403, { error: 'Invalid Control Center session token.' });
                return;
            }
            if (request.method === 'GET' && requestUrl.pathname === '/api/state') {
                const snapshot = await entitlementProvider.getEntitlement();
                writeJson(response, 200, {
                    generatedAt: new Date().toISOString(),
                    entitlement: sanitizeEntitlement(snapshot),
                    activeExtensions: activeExtensionMetadata(snapshot, extensions),
                });
                return;
            }

            const match = matchRoute(requestUrl.pathname, request.method, compiledRoutes);
            if (!match) {
                writeJson(response, 404, { error: 'Not found.' });
                return;
            }
            const snapshot = await entitlementProvider.getEntitlement();
            const required = [
                ...(match.compiled.extension.requiredCapabilities ?? []),
                ...(match.compiled.route.requiredCapabilities ?? []),
            ];
            if (!hasCapabilities(snapshot, required)) {
                writeJson(response, 404, { error: 'Not found.' });
                return;
            }
            if (request.method !== 'GET' && !mutationOriginIsLocal(request)) {
                writeJson(response, 403, { error: 'Invalid mutation origin.' });
                return;
            }

            let bodyPromise: Promise<unknown> | undefined;
            const context: ControlCenterRequestContextV1 = {
                method: match.compiled.route.method,
                pathname: requestUrl.pathname,
                params: match.params,
                query: parseQuery(requestUrl),
                entitlement: sanitizeEntitlement(snapshot),
                readJsonBody(maxBytes?: number) {
                    bodyPromise ??= readJsonBody(request, maxBytes);
                    return bodyPromise;
                },
            };
            const result = await match.compiled.route.handle(context);
            if (!Number.isInteger(result.status) || result.status < 100 || result.status > 599) {
                throw new Error('Control Center extension returned an invalid status');
            }
            writeJson(response, result.status, result.body);
        } catch (error) {
            if (error instanceof RequestBodyError) {
                writeJson(response, 400, { error: error.message });
                return;
            }
            if (!options.quiet) {
                console.error('Desktop Commander Control Center request failed.');
            }
            writeJson(response, 500, { error: 'Control Center request failed.' });
        }
    });
    await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
            server.off('listening', onListening);
            reject(error);
        };
        const onListening = () => {
            server.off('error', onError);
            resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        throw new Error('Control Center failed to resolve its local listening address.');
    }
    const actualPort = (address as AddressInfo).port;
    const urlHost = host === '::1' ? '[::1]' : host;
    return {
        host,
        port: actualPort,
        token,
        url: `http://${urlHost}:${actualPort}/`,
        close: () => new Promise<void>((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        }),
    };
}
