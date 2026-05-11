# Changelog

Todas as mudanças notáveis nesta skill ficam documentadas aqui.

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt/1.1.0/) e versionamento [SemVer](https://semver.org/lang/pt/).

## [Unreleased]

### A planear
- LLM-as-judge na eval suite (substituir heurística regex por avaliação semântica)
- Frontends adicionais (SvelteKit, Remix, Nuxt, Astro, Expo, Flutter)
- Migração de outros stacks (Firebase, Mongo, Prisma+Postgres → Supabase)
- Particionamento + time-series (`pg_partman`)
- Read replicas + scaling horizontal
- PostGIS deep dive
- Compliance frameworks (SOC2, HIPAA detalhado, PCI-DSS)
- Self-hosted Supabase (Docker/K8s)
- Validação por audits reais em projetos externos

## [1.0.0] — 2026-05-11

Lançamento público inicial.

### Capacidades (13 lentes)

1. **Database Architecture** — design de schema, SaaS multi-tenant, FKs, indexes, triggers, soft-delete, enums, audit fields
2. **RLS Security** — geração e auditoria de Row Level Security; helpers `is_member`/`has_role`; patterns por tipo de ownership (user, org, public, admin, hierarchy)
3. **Migration Safety** — migrações zero-downtime, expand/contract, backfill em batches, rollback documentado, Squawk lint
4. **Performance** — indexes (BTREE, GIN, GiST, partial, HNSW), EXPLAIN ANALYZE, paginação cursor, materialized views, N+1
5. **Auth** — service_role isolation, JWT, SSR (`@supabase/ssr`), custom claims, **MFA/TOTP**, **Anonymous sign-ins**, **SSO/SAML**
6. **Storage** — buckets, policies path-based, signed URLs, MIME validation, path traversal prevention
7. **Realtime** — Postgres Changes, Broadcast, Presence, filtros server-side, tenant isolation, custo
8. **Edge Functions** — auth check, Zod validation, CORS, webhook signature, rate limiting, idempotência
9. **Production Readiness** — checklist 11 secções (security, performance, migrations, integrity, observability, backups, env, app, rate limiting, compliance, docs)
10. **Documentation** — geração de docs técnicos a partir do projeto
11. **RAG / pgvector** — HNSW/IVFFlat, hybrid search FTS+vector (RRF), chunking strategy, RLS em embeddings multi-tenant, Edge Function de ingestão
12. **CI/CD & Testing** — pgTAP, Squawk lint, GitHub Actions, deploy automatizado, smoke tests
13. **Branching & Environments** — Supabase Branching, dev/staging/prod, seeding, OAuth por ambiente

### Conteúdo incluído

| Tipo | Ficheiros | Detalhe |
|---|---|---|
| Slash commands | 12 | `supabase-architect`, `supabase-audit`, `supabase-rls`, `supabase-migrations`, `supabase-performance`, `supabase-auth`, `supabase-storage`, `supabase-realtime`, `supabase-edge-functions`, `supabase-production-check`, `supabase-docs`, `supabase-rag` |
| References | 16 | `00` mindset · `01` RLS · `02` multi-tenant · `03` performance · `04` migrations · `05` auth · `06` storage · `07` realtime · `08` edge functions · `09` production checklist · `10` common vulnerabilities (V01–V20) · `11` schema patterns · `12` pgvector/RAG · `13` CI/CD testing · `14` branching · `15` postgres extensions (pg_cron, pg_net, webhooks) · `16` cost estimation · `17` MCP integration · `18` encryption/secrets + `HEURISTICS.md` (H01–H52) |
| Templates | 11 | audit · security · architecture · rls · performance · migrations · production · rag · testing · branching · incident |
| Examples | 9 | audits: SaaS B2B, marketplace, B2C, hotel/booking, LMS · standalone: RLS, performance, migration (rename expand/contract), RAG |
| Heurísticas | 52 | H01–H52 em `references/HEURISTICS.md` — catálogo central com sinal SQL/grep, severidade, confidence e cross-reference |
| Eval suite | 12 cenários | prompts + rubric (5 dimensões × 2pts) + expected outputs + runner automatizado (Anthropic SDK) |

### DX e qualidade

- `INSTALL.md` com 4 métodos de instalação (git clone, project-local, curl, submodule)
- `GLOSSARY.md` com ~150 termos técnicos (RLS, AAL2, RRF, IDOR, HNSW, MCP, etc.)
- `CONTRIBUTING.md` com filosofia, tipos de contribuição, guia de severidade, convenções de commit
- `SECURITY.md` com política de disclosure privado (GitHub Security Advisories)
- `CODE_OF_CONDUCT.md` — Contributor Covenant 2.1
- `.github/` — 2 issue templates, PR template, 2 workflows CI (lint + eval)
- Licença MIT, `.editorconfig`, `.markdownlint.json`
- `README.en.md` versão inglesa

### Domínios suportados

SaaS B2B multi-tenant, marketplace 2-sided, B2C user-as-tenant, hotel/booking (tstzrange + EXCLUDE GiST), LMS (enrollment como gate, quiz answers isolados), CRMs, internal tools, dashboards, AI/RAG apps.

---

Copyright © 2026 António Lopes. Licenciado sob MIT — ver [LICENSE](LICENSE).
