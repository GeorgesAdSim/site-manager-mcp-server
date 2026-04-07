# @adsim/site-manager-mcp-server

The AI-native site manager — content, SEO, performance, deploy — from a conversation. No CMS needed.

Built by [AdSim](https://adsim.be) — Digital Marketing & AI Agency, Liège, Belgium.

## What is this?

A [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server that turns any Supabase-backed website into an AI-managed site. Connect it to Claude Desktop, Cursor, or any MCP client and manage your content, SEO, and site operations through natural conversation.

**No WordPress. No Strapi. No admin panel.** Just your data in Supabase and an AI that knows how to work with it.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                   index.ts                       │
│           Orchestrator + Transport               │
│         (stdio / HTTP Streamable)                │
├──────────┬──────────┬──────────┬────────────────┤
│  Core    │ Content  │   SEO    │  Performance   │
│ Engine   │ Engine   │ Engine   │   (planned)    │
├──────────┴──────────┴──────────┴────────────────┤
│              Shared Layer                        │
│   governance.ts · audit.ts · context.ts          │
├─────────────────────────────────────────────────┤
│              Supabase (PostgreSQL)               │
│   Content tables · sm_* tables · Storage         │
└─────────────────────────────────────────────────┘
```

```
src/
  index.ts                # Orchestrator, dual transport stdio/HTTP
  types.ts                # All TypeScript interfaces
  shared/
    governance.ts         # Enterprise controls (read-only, disable-delete, rate limit)
    audit.ts              # JSON audit trail on stderr + Supabase persistence
    context.ts            # Multi-site target management + Content Contract
  engines/
    core.ts               # Site introspection, discovery, target switching
    content.ts            # CRUD on collections, globals, search
    seo.ts                # SEO audit, meta read/write, scoring
```

## Features

- **Content Contract** — Auto-discovers your Supabase schema and generates a contract defining collections, fields, translations, and globals
- **i18n Detection** — Supports both `translation_table` and `suffix` strategies (e.g., `name_en`, `slug_fr`, `description_de`)
- **Enterprise Governance** — Read-only mode, delete protection, deploy confirmation, rate limiting
- **Audit Trail** — Every operation logged as JSON on stderr (pipe to Datadog/Splunk/ELK) + optional Supabase persistence
- **Multi-Site** — Switch between multiple Supabase projects in one session
- **Dual Transport** — stdio for Claude Desktop, HTTP Streamable for web clients
- **SEO Scoring** — Automated SEO audits with scoring on title, description, keyword presence and placement

## Tools (17)

### Core Engine

| Tool | Description |
|------|-------------|
| `sm_site_info` | Site overview: Content Contract, collections, governance status, targets |
| `sm_discover` | Auto-discover schema, detect i18n, generate Content Contract |
| `sm_set_target` | Switch active site in multi-target mode |
| `sm_get_site_options` | Read globals: site_config, seo_config, navigation |

### Content Engine

| Tool | Description |
|------|-------------|
| `sm_list_collections` | List all collections with schema and document counts |
| `sm_list_documents` | Paginated document listing with sort, search, filters |
| `sm_get_document` | Get document by ID or slug, with SEO meta and schemas |
| `sm_create_document` | Create a document (draft by default) |
| `sm_update_document` | Partial update of a document |
| `sm_delete_document` | Delete a document (governed) |
| `sm_update_global` | Update site_config, seo_config, navigation (merge) |
| `sm_search` | Full-text search across one or all collections |

### SEO Engine

| Tool | Description |
|------|-------------|
| `sm_audit_seo` | Bulk SEO audit on a collection with scoring and history |
| `sm_get_seo_meta` | Read SEO meta for a document (title, description, score) |
| `sm_update_seo_meta` | Write/update SEO meta with auto score recalculation |
| `sm_generate_schema` | Generate JSON-LD Product schema (schema.org) for a document |
| `sm_suggest_internal_links` | Suggest internal links between same-category documents (maillage interne) |

### SEO Scoring

Each document is scored out of 100:

| Check | Pass | Fail |
|-------|------|------|
| Meta title present | — | -30 |
| Meta title length (30-60 chars) | — | -10 |
| Meta description present | — | -30 |
| Meta description length (120-160 chars) | — | -10 |
| Focus keyword present | — | -20 |
| Focus keyword in title | — | -10 |

## Quick Start

### 1. Install

```bash
git clone https://github.com/GeorgesAdSim/site-manager-mcp-server.git
cd site-manager-mcp-server
npm install
npm run build
```

### 2. Configure

```bash
cp .env.example .env
# Edit .env with your Supabase credentials
```

### 3. Run (stdio)

```bash
node dist/index.js
```

### 4. Run (HTTP)

```bash
MCP_TRANSPORT=http MCP_HTTP_PORT=3100 node dist/index.js
# → http://127.0.0.1:3100/mcp
# → http://127.0.0.1:3100/health
```

## Claude Desktop Configuration

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "site-manager": {
      "command": "node",
      "args": ["/path/to/site-manager-mcp-server/dist/index.js"],
      "env": {
        "SUPABASE_URL": "https://your-project.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "eyJ...",
        "SITE_URL": "https://your-site.com",
        "SM_AUDIT_LOG": "on",
        "SM_COMPACT_JSON": "true"
      }
    }
  }
}
```

Restart Claude Desktop. The tools appear automatically.

## Supabase Tables

The server uses these `sm_*` tables (create them in your Supabase project):

```sql
-- Globals (Content Contract, site config, SEO config, navigation)
CREATE TABLE sm_globals (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- SEO metadata per page
CREATE TABLE sm_seo_meta (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  page_type TEXT NOT NULL,
  page_id UUID NOT NULL,
  locale TEXT NOT NULL DEFAULT 'fr',
  meta_title TEXT,
  meta_description TEXT,
  focus_keyword TEXT,
  canonical TEXT,
  og_title TEXT,
  og_description TEXT,
  og_image TEXT,
  noindex BOOLEAN DEFAULT false,
  nofollow BOOLEAN DEFAULT false,
  seo_score INTEGER DEFAULT 0,
  score_details JSONB DEFAULT '{}'::jsonb,
  last_audit TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(page_type, page_id, locale)
);

-- SEO audit history
CREATE TABLE sm_seo_history (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  collection TEXT NOT NULL,
  locale TEXT NOT NULL,
  audited_at TIMESTAMPTZ NOT NULL,
  document_count INTEGER,
  avg_score INTEGER,
  min_score INTEGER,
  max_score INTEGER,
  distribution JSONB,
  issue_counts JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Schema.org structured data (used by sm_generate_schema)
CREATE TABLE sm_schema_org (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  page_type TEXT NOT NULL,
  page_id UUID NOT NULL,
  locale TEXT NOT NULL DEFAULT 'fr',
  schema_type TEXT NOT NULL,
  data JSONB NOT NULL,
  validated BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(page_type, page_id, locale, schema_type)
);

-- Internal links (used by sm_suggest_internal_links)
CREATE TABLE sm_internal_links (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_id UUID NOT NULL,
  target_type TEXT NOT NULL,
  target_id UUID NOT NULL,
  anchor_text TEXT,
  relevance_score NUMERIC(3,2) DEFAULT 0,
  auto_generated BOOLEAN DEFAULT false,
  approved BOOLEAN,
  batch_id UUID,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Audit log
CREATE TABLE sm_audit_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL,
  tool TEXT NOT NULL,
  action TEXT NOT NULL,
  site TEXT,
  collection TEXT,
  document_id TEXT,
  document_slug TEXT,
  status TEXT NOT NULL,
  latency_ms INTEGER,
  params JSONB DEFAULT '{}'::jsonb,
  changes JSONB DEFAULT '{}'::jsonb,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Changelog
CREATE TABLE sm_changelog (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  action TEXT NOT NULL,
  collection TEXT,
  document_id TEXT,
  changes JSONB,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Media management
CREATE TABLE sm_media (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  filename TEXT NOT NULL,
  url TEXT NOT NULL,
  type TEXT,
  size_bytes INTEGER,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Redirects
CREATE TABLE sm_redirects (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  source_path TEXT NOT NULL,
  target_path TEXT NOT NULL,
  status_code INTEGER DEFAULT 301,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SUPABASE_URL` | Yes | — | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | — | Service role key (bypasses RLS) |
| `SITE_URL` | No | — | Production site URL |
| `SM_READ_ONLY` | No | `false` | Block all write operations |
| `SM_DISABLE_DELETE` | No | `false` | Block delete operations |
| `SM_CONFIRM_DEPLOY` | No | `true` | Require confirmation for deploys |
| `SM_AUDIT_LOG` | No | `on` | Enable audit trail (`on`/`off`) |
| `SM_COMPACT_JSON` | No | `true` | Compact JSON output |
| `SM_MAX_CALLS_PER_MINUTE` | No | `0` (unlimited) | Rate limit |
| `SM_CONTENT_MODE` | No | `supabase` | Content backend |
| `SM_DEPLOY_TARGET` | No | `netlify` | Deploy provider |
| `SM_TOOL_CATEGORIES` | No | all | Comma-separated: `core,content,seo` |
| `MCP_TRANSPORT` | No | `stdio` | Transport: `stdio` or `http` |
| `MCP_HTTP_PORT` | No | `3100` | HTTP server port |
| `MCP_AUTH_TOKEN` | No | — | Bearer token for HTTP mode |
| `SM_TARGETS_JSON` | No | — | Multi-site JSON config |

## Multi-Site Configuration

For managing multiple sites, set `SM_TARGETS_JSON`:

```json
{
  "jac-machines": {
    "supabase_url": "https://xxx.supabase.co",
    "supabase_service_key": "eyJ...",
    "site_url": "https://jac-machines.media"
  },
  "wallfin": {
    "supabase_url": "https://yyy.supabase.co",
    "supabase_service_key": "eyJ...",
    "site_url": "https://wallfin.be"
  }
}
```

Then use `sm_set_target` to switch between sites during a conversation.

## i18n Support

The server auto-detects two i18n strategies:

### Suffix Strategy (JAC Machines pattern)
Translations stored as columns: `name_en`, `name_de`, `slug_fr`, `description_it`...
```
machines table:
  name         → base field (FR)
  name_en      → English translation
  name_de      → German translation
  slug_fr      → French slug
  slug_en      → English slug
```

### Translation Table Strategy
Separate table with locale column:
```
products table:        product_translations table:
  id                     product_id → FK
  name (base)            locale: 'en', 'de', 'es'
  slug                   name, description (translated)
```

## Governance

| Mode | Env Variable | Effect |
|------|-------------|--------|
| Read-only | `SM_READ_ONLY=true` | Blocks all write/update/delete tools |
| No delete | `SM_DISABLE_DELETE=true` | Blocks `sm_delete_document` only |
| Rate limit | `SM_MAX_CALLS_PER_MINUTE=60` | Throttles all tool calls |
| Tool filter | `SM_TOOL_CATEGORIES=core,content` | Only expose specified engines |

## Audit Trail

Every tool call emits a JSON log line on stderr:

```json
{
  "timestamp": "2026-04-07T08:43:07.454Z",
  "tool": "sm_update_seo_meta",
  "action": "update",
  "site": "default",
  "collection": "machines",
  "document_slug": "duro",
  "status": "success",
  "latency_ms": 1154,
  "params": { "locale": "fr", "fields_changed": ["meta_title", "meta_description"] }
}
```

Pipe to your log aggregator:
```bash
node dist/index.js 2>> /var/log/site-manager-audit.jsonl
```

If `sm_audit_log` table exists, logs are also persisted to Supabase.

## Roadmap

- [ ] **Performance Engine** — Lighthouse audits, bundle analysis, image optimization
- [ ] **Deploy Engine** — Netlify/Vercel preview + production deploys
- [ ] **Connect Engine** — Analytics, form submissions, social, webhooks
- [ ] **i18n Engine** — Translation coverage, sync SEO across locales
- [x] **Schema.org** — JSON-LD Product generation (`sm_generate_schema`) + internal linking suggestions (`sm_suggest_internal_links`)
- [ ] **Media Engine** — Image optimization, responsive breakpoints

## License

MIT — see [LICENSE](LICENSE).

## Links

- **Repository**: [github.com/GeorgesAdSim/site-manager-mcp-server](https://github.com/GeorgesAdSim/site-manager-mcp-server)
- **MCP Protocol**: [modelcontextprotocol.io](https://modelcontextprotocol.io)
- **AdSim**: [adsim.be](https://adsim.be)
