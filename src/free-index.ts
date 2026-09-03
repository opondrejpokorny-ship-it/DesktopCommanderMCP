#!/usr/bin/env node

// MUST be first: raises the libuv threadpool size before any fs work is
// submitted. See src/bootstrap.ts for why import order matters.
import './bootstrap.js';
import { startDesktopCommanderServer } from './run-server.js';

// Free intentionally relies on the shared defaults:
// FreeEntitlementProvider + NoopPolicyHook.
startDesktopCommanderServer();
