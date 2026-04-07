/**
 * Test SEO Engine — sm_audit_seo on machines
 *
 * Usage: npx tsx tests/test-seo.ts
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const envPath = resolve(import.meta.dirname, '..', '.env');
const envVars: Record<string, string> = {};
for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) envVars[match[1].trim()] = match[2].trim();
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  console.log('\n' + '='.repeat(60));
  console.log(`${name}(${JSON.stringify(args)})`);
  console.log('='.repeat(60));
  const result = await client.callTool({ name, arguments: args });
  for (const c of result.content as { type: string; text: string }[]) {
    if (c.type === 'text') console.log(c.text);
  }
}

async function main() {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js'],
    cwd: resolve(import.meta.dirname, '..'),
    env: { ...process.env, ...envVars } as Record<string, string>,
  });

  const client = new Client({ name: 'test-seo', version: '1.0' });
  await client.connect(transport);
  console.log('MCP server connected.');

  // 1. Audit SEO on machines
  await call(client, 'sm_audit_seo', { collection: 'machines', locale: 'fr', limit: 50 });

  // 2. Get SEO meta for Duro (should now exist after audit)
  await call(client, 'sm_get_seo_meta', { collection: 'machines', id: 'duro', locale: 'fr' });

  await client.close();
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
