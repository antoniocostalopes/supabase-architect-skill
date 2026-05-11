# References — Supabase Architect

Conhecimento profundo carregado **on-demand** pela skill.

## Sempre carregar
- [`00-mindset-arquiteto.md`](00-mindset-arquiteto.md) — Princípios de design, auditoria, comunicação
- [`10-common-vulnerabilities.md`](10-common-vulnerabilities.md) — 20 anti-patterns frequentes (V01–V20)
- [`HEURISTICS.md`](HEURISTICS.md) — Catálogo central de 52 heurísticas de detecção (H01–H52)

## Por tópico
- [`01-rls-patterns.md`](01-rls-patterns.md) — Row Level Security em profundidade
- [`02-multi-tenant-patterns.md`](02-multi-tenant-patterns.md) — SaaS B2B com organizations + memberships
- [`03-postgresql-performance.md`](03-postgresql-performance.md) — Indexes, EXPLAIN, paginação, materialized views
- [`04-migration-safety.md`](04-migration-safety.md) — Escrever/rever migrações zero-downtime
- [`05-auth-security.md`](05-auth-security.md) — Supabase Auth, service_role, JWT, SSR, **MFA/TOTP**, **Anonymous sign-ins**, **SSO/SAML**
- [`06-storage-security.md`](06-storage-security.md) — Buckets, policies, signed URLs
- [`07-realtime-patterns.md`](07-realtime-patterns.md) — Postgres Changes, Broadcast, Presence
- [`08-edge-functions-security.md`](08-edge-functions-security.md) — Edge Functions seguras
- [`09-production-checklist.md`](09-production-checklist.md) — Production readiness completa
- [`11-schema-patterns.md`](11-schema-patterns.md) — Convenções e padrões de schema
- [`12-pgvector-rag.md`](12-pgvector-rag.md) — pgvector, HNSW/IVFFlat, hybrid search FTS+vector, RAG patterns
- [`13-ci-cd-testing.md`](13-ci-cd-testing.md) — pgTAP, Squawk lint, GitHub Actions, deploy automatizado, smoke tests
- [`14-branching-environments.md`](14-branching-environments.md) — Supabase Branching, ambientes (dev/staging/prod), seeding
- [`15-postgres-extensions.md`](15-postgres-extensions.md) — pg_cron, pg_net, Database Webhooks, outbox pattern
- [`16-cost-estimation.md`](16-cost-estimation.md) — 7 eixos de custo, otimização por fase, AI tokens, MAU, egress, branching
- [`17-mcp-integration.md`](17-mcp-integration.md) — Supabase MCP server (skill lê schema diretamente via tools)
- [`18-encryption-secrets.md`](18-encryption-secrets.md) — Vault, pgsodium TCE/explicit, application-level encryption, key rotation, compliance (PCI/HIPAA/GDPR)

## Mapeamento pedido → references

| Pedido | Referências |
|---|---|
| audit completa | todas |
| RLS | 01 + 02 + 10 |
| migração | 04 + 10 + 13 |
| performance | 03 + 11 |
| auth/JWT/service_role | 05 + 10 |
| MFA / SSO / anonymous | 05 |
| storage | 06 + 10 |
| realtime | 07 |
| edge functions | 08 + 05 |
| schema design | 11 + 02 |
| RAG / pgvector | 12 + 01 + 02 + 03 |
| CI/CD / testing | 13 + 04 |
| branching / environments | 14 + 04 |
| pg_cron / pg_net / webhooks | 15 |
| outbox pattern / event delivery | 15 |
| cost estimation / pricing | 16 |
| skill activation via MCP | 17 |
| encryption / Vault / PII regulada | 18 |
| compliance (PCI/HIPAA/GDPR) | 18 |
| production | 09 + todas |
