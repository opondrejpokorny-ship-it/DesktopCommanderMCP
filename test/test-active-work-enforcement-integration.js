/**
 * Keep the real built-MCP Active Work enforcement integration in the standard
 * npm test suite without requiring a dedicated workflow-only invocation.
 */
await import('./integration/active-work-enforcement.js');
