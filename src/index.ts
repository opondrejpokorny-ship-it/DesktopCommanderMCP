#!/usr/bin/env node

// MUST be first: raises the libuv threadpool size before any fs work is
// submitted. See src/bootstrap.ts for why import order matters.
import './bootstrap.js';
import { startDesktopCommanderServer } from './run-server.js';

// Public Free is the default product composition. Commercial attaches its
// entitlement and policy services through Commercial Contract v1 before start.
startDesktopCommanderServer();
