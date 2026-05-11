# Supabase Architect — Claude Code Skill

> Database architect, security auditor, and production consultant for Supabase projects.
> Version: 1.0.0 — see [CHANGELOG.md](CHANGELOG.md).

Native Claude Code skill that helps developers design, audit, harden, optimize, and prepare any Supabase project for production.

Not a SQL generator. A **senior database architect** specialized in PostgreSQL, Supabase, and multi-tenant SaaS.

> 🇵🇹 Portuguese version: [README.md](README.md).

## What it does

Covers the 13 core capabilities of an enterprise Supabase project:

1. **Database Architecture** — schema design, multi-tenant, FKs, indexes, triggers
2. **RLS Security** — Row Level Security generation and auditing
3. **Migration Safety** — zero-downtime migration writing/review + rollback
4. **Performance** — indexes, EXPLAIN, pagination, materialized views, N+1
5. **Auth** — service_role isolation, JWT, SSR, MFA/TOTP, Anonymous, SSO/SAML
6. **Storage** — buckets, policies, signed URLs, path strategy, MIME validation
7. **Realtime** — Postgres Changes, Broadcast, Presence, scale, filters
8. **Edge Functions** — auth check, validation, CORS, webhooks, rate limiting
9. **Production Readiness** — complete checklist in 11 sections
10. **Documentation** — technical doc generation from the project
11. **RAG / pgvector** — semantic + hybrid search, chunking, RLS on embeddings
12. **CI/CD & Testing** — pgTAP, Squawk lint, GitHub Actions, automated deploy
13. **Branching & Environments** — Supabase Branching, dev/staging/prod, seeding

## Structure

```
supabase/
├── SKILL.md                        # Persona, workflow, loading rules
├── README.md                       # Portuguese version (canonical)
├── README.en.md                    # This file
├── INSTALL.md                      # Detailed install (4 methods)
├── GLOSSARY.md                     # Technical glossary
├── CHANGELOG.md                    # Version history
├── NOTICE.md                       # Copyright and terms
├── commands/                       # 12 slash commands
├── references/                     # Deep knowledge (loaded on-demand)
├── templates/                      # Fixed output templates
├── examples/                       # Few-shot examples (5 domains)
└── tests/                          # Evaluation suite
```

## Install

```bash
# Global — available in all projects (recommended)
git clone https://github.com/antoniocostalopes/supabase-architect-skill.git \
  ~/.claude/skills/supabase

# Update
cd ~/.claude/skills/supabase && git pull
```

Other methods (project-local, curl one-liner, git submodule, MCP, troubleshooting): see [`INSTALL.md`](INSTALL.md).

## Usage

### Natural language
```
"audit my Supabase project"
"generate RLS for the documents table (org-owned)"
"review this migration before I run it"
"is the project production-ready?"
"which indexes are missing?"
"is the attachments bucket secure?"
"how do I set up MFA only for admins?"
"set up semantic search with pgvector"
```

The skill activates automatically.

### Slash commands
```
/supabase-audit
/supabase-rls fix-all
/supabase-migrations review-pending
/supabase-performance
/supabase-production-check
/supabase-docs all
/supabase-rag setup
```

## The 7-phase workflow

Every interaction follows this workflow:

1. **Recognition** — detects Supabase stack and **active MCP**. If MCP is available, uses **active mode** (direct read-only DB queries); otherwise, falls back to passive mode (reads project files).
2. **Surface mapping** — tables, RLS, policies, buckets, edge functions, realtime, embeddings, CI workflows, branches
3. **Capability analysis** — applies the 13 lenses relevant to the request
4. **Critical issue detection** — RLS missing, service_role exposed, public bucket with PII, etc. (see `references/HEURISTICS.md`)
5. **Self-review with confidence** — discards findings <40% confidence
6. **Prioritization** — conservative severity (Critical/High/Medium/Low)
7. **Output generation** — reads domain-appropriate few-shot, applies fixed template from `templates/`

## Hierarchical loading

The skill has ~20 files but **loads only what's needed** at runtime:

- **Always**: `00-mindset-arquiteto.md` + `10-common-vulnerabilities.md` + `HEURISTICS.md`
- **By topic**: only the relevant `references/*.md`
- **By output**: 1 template from `templates/`
- **As few-shot**: 1 example from `examples/` matching the detected domain

Keeps context lean and performance high.

## Red lines (NEVER)

The skill **NEVER**:
- Exposes `service_role` keys, JWT secrets, anon keys in client code
- Recommends `USING (true)` without explicit risk warning
- Disables RLS on tables with user data
- Generates `DROP TABLE` / `DELETE` / `UPDATE` without `WHERE` without red warning
- Accepts recommendation of `service_role` in client
- Generates destructive migrations without rollback strategy

The skill **ALWAYS**:
- Cites `file:line` or `schema.table`
- Returns copy-paste ready SQL
- Documents rollback for non-trivial DDL
- Conservative severity (Critical only with realistic exploit path)
- Output in pt-PT (unless requested otherwise); SQL in English

## Outputs produced

| Type | File | Template |
|---|---|---|
| Complete audit | `SUPABASE_AUDIT.md` | [`templates/audit.md`](templates/audit.md) |
| Security (Auth/Storage/Edge) | `SUPABASE_SECURITY.md` | [`templates/security.md`](templates/security.md) |
| Architecture | `SUPABASE_ARCHITECTURE.md` | [`templates/architecture.md`](templates/architecture.md) |
| RLS policies | `SUPABASE_RLS.md` | [`templates/rls.md`](templates/rls.md) |
| Performance | `SUPABASE_PERFORMANCE.md` | [`templates/performance.md`](templates/performance.md) |
| Migrations | `SUPABASE_MIGRATIONS.md` | [`templates/migrations.md`](templates/migrations.md) |
| Production check | `SUPABASE_PRODUCTION.md` | [`templates/production.md`](templates/production.md) |
| RAG / pgvector | `SUPABASE_RAG.md` | [`templates/rag.md`](templates/rag.md) |
| CI/CD + Testing | `SUPABASE_TESTING.md` | [`templates/testing.md`](templates/testing.md) |
| Branching + Environments | `SUPABASE_BRANCHING.md` | [`templates/branching.md`](templates/branching.md) |

## Persona

Direct. Production-oriented. No alarmism, no emojis unless requested. Conservative severity. Each finding ships with copy-paste fix and documented rollback.

> *"From idea → architecture → schema → RLS → migrations → performance → security → production."*

## Supported use cases

| Domain | Dedicated example | Patterns covered |
|---|---|---|
| SaaS B2B multi-tenant | [`saas-multi-tenant`](examples/audit-example-saas-multi-tenant.md) | organizations + memberships, role-based RLS |
| 2-sided marketplace | [`marketplace`](examples/audit-example-marketplace.md) | sellers + buyers, stock atomicity, Stripe Connect |
| B2C user-as-tenant | [`b2c`](examples/audit-example-b2c.md) | profiles privacy, share links with TTL, optimistic locking |
| Hotel / booking | [`hotel`](examples/audit-example-hotel.md) | tstzrange + EXCLUDE GiST, multi-property |
| LMS / education | [`lms`](examples/audit-example-lms.md) | enrollment as gate, isolated quiz answers, signed video URLs |
| CRMs, internal tools, dashboards | adapt SaaS | — |
| Automation, AI/RAG apps | + `references/12-pgvector-rag.md` | — |

## Roadmap

**v1.0.0** — initial public release. Includes 13 capabilities, 12 commands, 16 references, 11 templates, 9 examples (5 domains + 4 standalone outputs), 52 heuristics, automated eval suite. See [CHANGELOG.md](CHANGELOG.md) for full detail.

Planned:
- [ ] Additional frontends (SvelteKit, Remix, Nuxt, Astro, Expo, Flutter)
- [ ] Migration from other stacks (Firebase, Mongo, Prisma+Postgres)
- [ ] Partitioning / time-series (`pg_partman`)
- [ ] Read replicas + horizontal scaling
- [ ] PostGIS deep dive
- [ ] Compliance frameworks (SOC2, HIPAA, GDPR)
- [ ] External real-world validation audits

## Related documentation

- [`INSTALL.md`](INSTALL.md) — complete install, MCP config, troubleshooting
- [`GLOSSARY.md`](GLOSSARY.md) — technical terms (RLS, AAL2, RRF, IDOR, HNSW, MCP, etc.)
- [`CHANGELOG.md`](CHANGELOG.md) — version history and roadmap
- [`NOTICE.md`](NOTICE.md) — copyright, trademarks, attribution rules
- [`references/HEURISTICS.md`](references/HEURISTICS.md) — 52 codified detection heuristics
- [`tests/`](tests/) — evaluation suite

## License and rights

Copyright © 2026 António Lopes. Licensed under [MIT](LICENSE).

Private skill. Internal distribution authorized only with the author's consent. See [`NOTICE.md`](NOTICE.md) for complete terms, trademarks, and attribution rules.
