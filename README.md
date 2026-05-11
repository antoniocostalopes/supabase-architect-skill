# Supabase Architect — Claude Code Skill

[![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)](CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Open Source](https://img.shields.io/badge/Open%20Source-%E2%9D%A4-brightgreen.svg)](https://github.com/antoniocostalopes/supabase-architect-skill)
[![CI — Lint](https://github.com/antoniocostalopes/supabase-architect-skill/actions/workflows/lint.yml/badge.svg)](https://github.com/antoniocostalopes/supabase-architect-skill/actions/workflows/lint.yml)
[![Claude Code](https://img.shields.io/badge/Claude_Code-Skill-blueviolet)](https://docs.anthropic.com/claude-code)
[![Supabase](https://img.shields.io/badge/Supabase-PostgreSQL-3ECF8E)](https://supabase.com)

> Arquiteto de bases de dados, auditor de segurança e consultor de produção para projetos Supabase.
> 🇬🇧 [English version](README.en.md) · [CHANGELOG](CHANGELOG.md) · [INSTALL](INSTALL.md)

Skill nativa do Claude Code que ajuda developers a desenhar, auditar, blindar, otimizar e preparar para produção qualquer projeto Supabase.

Não é um gerador de SQL. É um **arquiteto sénior de bases de dados** com especialização em PostgreSQL, Supabase e SaaS multi-tenant.

## O que faz

Cobre as 13 capacidades centrais de um projeto Supabase enterprise:

1. **Database Architecture** — design de schema, multi-tenant, FKs, indexes, triggers
2. **RLS Security** — geração e auditoria de Row Level Security
3. **Migration Safety** — escrita/revisão de migrações zero-downtime + rollback
4. **Performance** — indexes, EXPLAIN, paginação, materialized views, N+1
5. **Auth** — service_role isolation, JWT, SSR, MFA/TOTP, Anonymous, SSO/SAML
6. **Storage** — buckets, policies, signed URLs, path strategy, MIME validation
7. **Realtime** — Postgres Changes, Broadcast, Presence, escala, filtros
8. **Edge Functions** — auth check, validation, CORS, webhooks, rate limiting
9. **Production Readiness** — checklist completa em 11 secções
10. **Documentation** — geração de docs técnicos a partir do projeto
11. **RAG / pgvector** — semantic + hybrid search, chunking, RLS em embeddings
12. **CI/CD & Testing** — pgTAP, Squawk lint, GitHub Actions, deploy automatizado
13. **Branching & Environments** — Supabase Branching, dev/staging/prod, seeding

## Estrutura

```
supabase/
├── SKILL.md                        # Persona, workflow, regras de loading
├── README.md                       # Este ficheiro (pt-PT canónico)
├── README.en.md                    # Versão inglesa
├── INSTALL.md                      # Instalação detalhada (4 métodos)
├── GLOSSARY.md                     # Glossário técnico (~150 termos)
├── CHANGELOG.md                    # Histórico de versões
├── NOTICE.md                       # Copyright e termos
├── tests/                          # Test suite de avaliação manual
│   ├── README.md
│   └── eval/                       # 12 cenários + rubric + expected
├── commands/                       # 12 slash commands
│   ├── supabase-architect.md
│   ├── supabase-audit.md
│   ├── supabase-rls.md
│   ├── supabase-migrations.md
│   ├── supabase-performance.md
│   ├── supabase-auth.md
│   ├── supabase-storage.md
│   ├── supabase-realtime.md
│   ├── supabase-edge-functions.md
│   ├── supabase-production-check.md
│   ├── supabase-docs.md
│   ├── supabase-rag.md
│   └── README.md
├── references/                     # Conhecimento profundo (carregado on-demand)
│   ├── 00-mindset-arquiteto.md     # SEMPRE
│   ├── 01-rls-patterns.md
│   ├── 02-multi-tenant-patterns.md
│   ├── 03-postgresql-performance.md
│   ├── 04-migration-safety.md
│   ├── 05-auth-security.md          # + MFA/Anonymous/SSO
│   ├── 06-storage-security.md
│   ├── 07-realtime-patterns.md
│   ├── 08-edge-functions-security.md
│   ├── 09-production-checklist.md
│   ├── 10-common-vulnerabilities.md # SEMPRE — 20 anti-patterns (V01-V20)
│   ├── 11-schema-patterns.md
│   ├── 12-pgvector-rag.md
│   ├── 13-ci-cd-testing.md
│   ├── 14-branching-environments.md
│   ├── 15-postgres-extensions.md   # pg_cron + pg_net + webhooks + outbox
│   ├── 16-cost-estimation.md       # 7 eixos de custo, otimização por fase
│   ├── 17-mcp-integration.md       # Supabase MCP (skill ativa)
│   ├── 18-encryption-secrets.md    # Vault, pgsodium, column encryption, compliance
│   ├── HEURISTICS.md               # Catálogo H01–H52
│   └── README.md
├── templates/                      # Templates fixos para output (11)
│   ├── audit.md
│   ├── security.md
│   ├── architecture.md
│   ├── rls.md
│   ├── performance.md
│   ├── migrations.md
│   ├── production.md
│   ├── rag.md
│   ├── testing.md
│   ├── branching.md
│   ├── incident.md
│   └── README.md
└── examples/                       # Few-shot (5 audits + 4 outputs específicos)
    ├── audit-example-saas-multi-tenant.md
    ├── audit-example-marketplace.md
    ├── audit-example-b2c.md
    ├── audit-example-hotel.md
    ├── audit-example-lms.md
    ├── rls-example-saas.md
    ├── performance-example-saas.md
    ├── migration-example-rename.md
    ├── rag-example-saas.md
    └── README.md
```

## Instalação

```bash
# Global — disponível em todos os projetos (recomendado)
git clone https://github.com/antoniocostalopes/supabase-architect-skill.git \
  ~/.claude/skills/supabase

# Atualizar
cd ~/.claude/skills/supabase && git pull
```

Outros métodos (project-local, curl one-liner, git submodule, MCP, troubleshooting): ver [`INSTALL.md`](INSTALL.md).

## Uso

### Por linguagem natural
```
"audita o meu projeto Supabase"
"gera RLS para a tabela documents (org-owned)"
"vê esta migração antes de eu correr"
"o projeto está pronto para produção?"
"que indexes faltam?"
"o bucket attachments está seguro?"
```

A skill activa-se automaticamente.

### Por slash commands
```
/supabase-audit
/supabase-rls fix-all
/supabase-migrations review-pending
/supabase-performance
/supabase-production-check
/supabase-docs all
/supabase-rag setup
```

## Workflow das 7 fases

Toda interação segue este workflow:

1. **Reconhecimento** — detecta stack Supabase (config.toml, migrations/, functions/, types, imports)
2. **Mapeamento** — tabelas, RLS, policies, buckets, edge functions, realtime
3. **Análise por capacidade** — aplica as 13 lentes relevantes
4. **Detecção de problemas críticos** — RLS missing, service_role exposto, bucket público, etc.
5. **Self-review com confidence** — descarta achados <40% confidence
6. **Priorização** — severidade conservadora (Crítico/Alto/Médio/Baixo)
7. **Geração do output** — template fixo de `templates/`, copy-paste-ready

## Loading hierárquico

A skill tem ~20 ficheiros mas em runtime carrega só o essencial:

- **Sempre**: `00-mindset-arquiteto.md` + `10-common-vulnerabilities.md`
- **Por tópico**: apenas as `references/*.md` relevantes
- **Por output**: 1 template de `templates/`
- **Como few-shot**: 1 example de `examples/`

Isto mantém o contexto magro e a performance alta.

## Regras críticas (linhas vermelhas)

A skill **NUNCA**:
- Expõe `service_role` keys, JWT secrets, anon keys em código cliente
- Recomenda `USING (true)` sem aviso explícito
- Desactiva RLS em tabelas com dados de utilizador
- Gera `DROP TABLE`/`DELETE`/`UPDATE` sem `WHERE` sem aviso vermelho
- Aceita recomendação de `service_role` no cliente
- Gera migrações destrutivas sem rollback strategy

A skill **SEMPRE**:
- Cita ficheiro:linha ou schema.tabela
- Devolve SQL copy-paste pronto
- Documenta rollback para DDL não-trivial
- Severidade conservadora (Crítico só se exploração real)
- Output em pt-PT (salvo pedido contrário); SQL em inglês

## Saídas produzidas

| Tipo | Ficheiro | Template |
|---|---|---|
| Auditoria completa | `SUPABASE_AUDIT.md` | [`templates/audit.md`](templates/audit.md) |
| Segurança (Auth/Storage/Edge) | `SUPABASE_SECURITY.md` | [`templates/security.md`](templates/security.md) |
| Arquitetura | `SUPABASE_ARCHITECTURE.md` | [`templates/architecture.md`](templates/architecture.md) |
| RLS policies | `SUPABASE_RLS.md` | [`templates/rls.md`](templates/rls.md) |
| Performance | `SUPABASE_PERFORMANCE.md` | [`templates/performance.md`](templates/performance.md) |
| Migrations | `SUPABASE_MIGRATIONS.md` | [`templates/migrations.md`](templates/migrations.md) |
| Production check | `SUPABASE_PRODUCTION.md` | [`templates/production.md`](templates/production.md) |
| RAG / pgvector | `SUPABASE_RAG.md` | [`templates/rag.md`](templates/rag.md) |
| CI/CD + Testing | `SUPABASE_TESTING.md` | [`templates/testing.md`](templates/testing.md) |
| Branching + Ambientes | `SUPABASE_BRANCHING.md` | [`templates/branching.md`](templates/branching.md) |
| Post-incident review | `SUPABASE_INCIDENT.md` | [`templates/incident.md`](templates/incident.md) |

## Persona

Direto. Production-oriented. Sem alarmismo, sem emojis salvo pedido. Severidade conservadora. Cada achado vem com fix copy-paste e rollback documentado.

> *"Da ideia → arquitetura → schema → RLS → migrações → performance → segurança → produção."*

## Casos de uso suportados

| Domínio | Example dedicado | Padrões cobertos |
|---|---|---|
| SaaS B2B multi-tenant | [`saas-multi-tenant`](examples/audit-example-saas-multi-tenant.md) | organizations + memberships, role-based RLS |
| Marketplace 2-sided | [`marketplace`](examples/audit-example-marketplace.md) | sellers + buyers, stock atomicity, Stripe Connect |
| B2C user-as-tenant | [`b2c`](examples/audit-example-b2c.md) | profiles privacy, share links com TTL, optimistic locking |
| Hotel / booking | [`hotel`](examples/audit-example-hotel.md) | tstzrange + EXCLUDE GiST, multi-property |
| LMS / educação | [`lms`](examples/audit-example-lms.md) | enrollment como gate, quiz answers isolados, signed video URLs |
| CRMs, internal tools, dashboards | adaptar SaaS | — |
| Automation, AI/RAG apps | + `references/12-pgvector-rag.md` | — |

## Roadmap

**v1.0.0** — lançamento inicial público. Inclui 13 capacidades, 12 commands, 16 references, 11 templates, 9 examples (5 domínios + 4 outputs standalone), 52 heurísticas, eval suite automatizada. Ver [CHANGELOG.md](CHANGELOG.md) para detalhe completo.

A planear:
- [ ] Frameworks frontend (SvelteKit, Remix, Nuxt, Astro, Expo, Flutter)
- [ ] Migração de outros stacks (Firebase, Mongo, Prisma+Postgres)
- [ ] Particionamento / time-series (`pg_partman`)
- [ ] Read replicas + scaling horizontal
- [ ] PostGIS deep dive
- [ ] Compliance frameworks (SOC2, HIPAA detalhado, PCI-DSS)
- [ ] Self-hosted Supabase (Docker/K8s)
- [ ] Validação por audits reais em projetos externos
- [ ] Runner automatizado da eval suite (Anthropic SDK)

## Documentação relacionada

- [`INSTALL.md`](INSTALL.md) — instalação completa, configuração MCP, troubleshooting
- [`GLOSSARY.md`](GLOSSARY.md) — termos técnicos (RLS, AAL2, RRF, IDOR, HNSW, MCP, etc.)
- [`CHANGELOG.md`](CHANGELOG.md) — histórico de versões e roadmap
- [`NOTICE.md`](NOTICE.md) — copyright, marcas registadas, regras de atribuição
- [`references/HEURISTICS.md`](references/HEURISTICS.md) — 52 heurísticas de detecção codificadas (H01–H52)
- [`tests/`](tests/) — test suite de avaliação manual (12 cenários, rubric, expected outputs)
- [`README.en.md`](README.en.md) — English version

## Licença

[MIT](LICENSE) © 2026 [António Lopes](https://github.com/antoniocostalopes).

Ver [NOTICE.md](NOTICE.md) para marcas registadas e ausência de garantias.

## Topics GitHub

> Ao criar o repo, adicionar estes topics para discoverability:
>
> `claude-code` `claude-code-skill` `supabase` `postgresql` `rls` `row-level-security` `multi-tenant` `saas` `security-audit` `database-architect` `anthropic` `pgvector` `rag` `semantic-search`
