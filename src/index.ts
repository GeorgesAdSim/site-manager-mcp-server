#!/usr/bin/env node

/**
 * @adsim/site-manager-mcp-server
 * 
 * The AI-native site manager — content, SEO, performance, deploy — from a conversation.
 * No CMS needed.
 * 
 * Enterprise Governance · Audit Trail · Multi-Site · Plugin-Free
 * 
 * v0.1.0 · ~15 tools · TypeScript · Supabase-native
 * 
 * Built by AdSim — Digital Marketing & AI Agency, Liège, Belgium.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';

// Shared modules
import { loadGovernanceConfig, enforceGovernance, enforceRateLimit, getFilteredTools } from './shared/governance.js';
import { configureAudit, logAudit } from './shared/audit.js';
import * as context from './shared/context.js';

// Engines
import { registerCoreTools } from './engines/core.js';
import { registerContentTools } from './engines/content.js';
import { registerSeoTools } from './engines/seo.js';
// import { registerPerformanceTools } from './engines/performance.js';
// import { registerDeployTools } from './engines/deploy.js';
// import { registerConnectTools } from './engines/connect.js';
// import { registerI18nTools } from './engines/i18n.js';

// ============================================================
// Constants
// ============================================================

const SERVER_NAME = 'site-manager-mcp-server';
const SERVER_VERSION = '0.1.0';

// ============================================================
// Server initialization
// ============================================================

const server = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
});

// ============================================================
// Load configuration
// ============================================================

const governance = loadGovernanceConfig();

// Configure audit
const auditEnabled = governance.auditLog;

// Load targets (single or multi-site)
context.loadTargets();

// ============================================================
// Register tools
// ============================================================

// Core engine — always registered
registerCoreTools(server);

// Content engine
registerContentTools(server);

// SEO engine
registerSeoTools(server);
// registerPerformanceTools(server);
// registerDeployTools(server);
// registerConnectTools(server);
// registerI18nTools(server);

// ============================================================
// Health check endpoint (HTTP mode only)
// ============================================================

function createHealthResponse() {
  return {
    status: 'ok',
    server: SERVER_NAME,
    version: SERVER_VERSION,
    transport: process.env.MCP_TRANSPORT || 'stdio',
    active_target: context.getActiveTargetName(),
    available_targets: context.getTargetNames(),
    governance: {
      read_only: governance.readOnly,
      disable_delete: governance.disableDelete,
      audit_log: governance.auditLog,
    },
  };
}

// ============================================================
// Transport: stdio
// ============================================================

async function runStdio(): Promise<void> {
  // Validate we have at least one target
  if (context.getTargetNames().length === 0) {
    process.stderr.write(
      `[${SERVER_NAME}] ERROR: No Supabase target configured.\n` +
      `Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY for single site,\n` +
      `or SM_TARGETS_JSON for multi-site.\n`
    );
    process.exit(1);
  }

  // Configure audit with Supabase persistence
  try {
    const client = context.getClient();
    configureAudit(auditEnabled, client);
  } catch {
    configureAudit(auditEnabled);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(
    `[${SERVER_NAME}] v${SERVER_VERSION} running via stdio\n` +
    `[${SERVER_NAME}] Target: ${context.getActiveTargetName()}\n` +
    `[${SERVER_NAME}] Governance: ${governance.readOnly ? 'READ-ONLY' : 'read-write'}` +
    `${governance.disableDelete ? ' | DELETE-OFF' : ''}` +
    `${governance.auditLog ? ' | AUDIT-ON' : ''}\n`
  );
}

// ============================================================
// Transport: HTTP Streamable
// ============================================================

async function runHTTP(): Promise<void> {
  const port = parseInt(process.env.MCP_HTTP_PORT || '3100');
  const host = process.env.MCP_HTTP_HOST || '127.0.0.1';
  const authToken = process.env.MCP_AUTH_TOKEN;

  if (!authToken) {
    process.stderr.write(`[${SERVER_NAME}] WARNING: MCP_AUTH_TOKEN not set. HTTP endpoint is unprotected.\n`);
  }

  // Validate targets
  if (context.getTargetNames().length === 0) {
    process.stderr.write(`[${SERVER_NAME}] ERROR: No Supabase target configured.\n`);
    process.exit(1);
  }

  // Configure audit
  try {
    const client = context.getClient();
    configureAudit(auditEnabled, client);
  } catch {
    configureAudit(auditEnabled);
  }

  const app = express();
  app.use(express.json());

  // Health check
  app.get('/health', (_req, res) => {
    res.json(createHealthResponse());
  });

  // MCP endpoint
  app.post('/mcp', async (req, res) => {
    // Bearer token authentication
    if (authToken) {
      const auth = req.headers.authorization;
      if (!auth || auth !== `Bearer ${authToken}`) {
        res.status(401).json({ error: 'Unauthorized. Provide Authorization: Bearer <token>' });
        return;
      }
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on('close', () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.listen(port, host, () => {
    process.stderr.write(
      `[${SERVER_NAME}] v${SERVER_VERSION} running on http://${host}:${port}/mcp\n` +
      `[${SERVER_NAME}] Health: http://${host}:${port}/health\n` +
      `[${SERVER_NAME}] Target: ${context.getActiveTargetName()}\n` +
      `[${SERVER_NAME}] Auth: ${authToken ? 'Bearer token required' : 'NONE (add MCP_AUTH_TOKEN)'}\n`
    );
  });
}

// ============================================================
// Startup
// ============================================================

const transportMode = process.env.MCP_TRANSPORT || 'stdio';

if (transportMode === 'http') {
  runHTTP().catch(error => {
    process.stderr.write(`[${SERVER_NAME}] Fatal: ${error}\n`);
    process.exit(1);
  });
} else {
  runStdio().catch(error => {
    process.stderr.write(`[${SERVER_NAME}] Fatal: ${error}\n`);
    process.exit(1);
  });
}
