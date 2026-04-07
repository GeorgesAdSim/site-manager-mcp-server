/**
 * Test sm_discover via MCP Client → Server (stdio transport)
 *
 * Usage: npx tsx tests/test-discover.ts
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load .env
const envPath = resolve(import.meta.dirname, '..', '.env');
const envVars: Record<string, string> = {};
for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) envVars[match[1].trim()] = match[2].trim();
}

async function main() {
  console.log('Starting MCP server...\n');

  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js'],
    cwd: resolve(import.meta.dirname, '..'),
    env: { ...process.env, ...envVars },
  });

  const client = new Client({ name: 'test-client', version: '1.0' });
  await client.connect(transport);

  // 1. List tools
  const { tools } = await client.listTools();
  console.log(`Registered tools (${tools.length}):`);
  for (const tool of tools) {
    console.log(`  ${tool.name} — ${tool.description?.split('\n')[0]}`);
  }

  // 2. Call sm_site_info
  console.log('\n' + '='.repeat(60));
  console.log('sm_site_info');
  console.log('='.repeat(60));
  const siteInfo = await client.callTool({ name: 'sm_site_info', arguments: {} });
  for (const c of siteInfo.content as { type: string; text: string }[]) {
    if (c.type === 'text') console.log(c.text);
  }

  // 3. Call sm_discover with save=true
  console.log('\n' + '='.repeat(60));
  console.log('sm_discover (save=true)');
  console.log('='.repeat(60));
  const discover = await client.callTool({
    name: 'sm_discover',
    arguments: {
      save: true,
      site_name: 'JAC Machines',
      site_url: 'https://jac-machines.media',
      stack: 'react-vite',
    },
  });
  for (const c of discover.content as { type: string; text: string }[]) {
    if (c.type === 'text') console.log(c.text);
  }

  // 4. Verify saved contract
  console.log('\n' + '='.repeat(60));
  console.log('Verify: sm_site_info (after save)');
  console.log('='.repeat(60));
  const verify = await client.callTool({ name: 'sm_site_info', arguments: {} });
  for (const c of verify.content as { type: string; text: string }[]) {
    if (c.type === 'text') {
      const parsed = JSON.parse(c.text);
      console.log(`  contract_loaded: ${parsed.contract_loaded}`);
      console.log(`  site: ${JSON.stringify(parsed.site)}`);
      console.log(`  collections: ${parsed.collections.length}`);
      for (const col of parsed.collections) {
        console.log(`    ${col.name} — ${col.documents} docs, ${col.fields} fields, translatable: ${col.translatable}`);
      }
      console.log(`  i18n: ${JSON.stringify(parsed.i18n)}`);
    }
  }

  await client.close();
  console.log('\nDone.');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
