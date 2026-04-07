/**
 * Test SEO cycle: update meta for Duro, verify score, read back
 *
 * Usage: npx tsx tests/test-seo-cycle.ts
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
  console.log(`${name}(${Object.keys(args).length > 2 ? JSON.stringify(args, null, 2) : JSON.stringify(args)})`);
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

  const client = new Client({ name: 'test-seo-cycle', version: '1.0' });
  await client.connect(transport);
  console.log('MCP server connected.');

  // 1. Update SEO meta for Duro
  await call(client, 'sm_update_seo_meta', {
    collection: 'machines',
    id: 'duro',
    locale: 'fr',
    data: {
      meta_title: 'Trancheuse à pain JAC Duro | Machine boulangerie professionnelle',
      meta_description: 'La trancheuse JAC Duro est la référence historique pour le tranchage du pain en boulangerie. Robuste, précise et fiable depuis plus de 50 ans.',
      focus_keyword: 'trancheuse à pain JAC Duro',
    },
  });

  // 2. Read back to confirm persistence
  await call(client, 'sm_get_seo_meta', {
    collection: 'machines',
    id: 'duro',
    locale: 'fr',
  });

  await client.close();
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
