# Slash Commands — Supabase Architect

| Comando | Propósito | Output |
|---|---|---|
| [`/supabase-architect`](supabase-architect.md) | Modo geral — decide o subset adequado | conforme escopo |
| [`/supabase-audit`](supabase-audit.md) | Auditoria completa (13 lentes) | `SUPABASE_AUDIT.md` |
| [`/supabase-rls`](supabase-rls.md) | Gerar / rever / blindar RLS | `SUPABASE_RLS.md` |
| [`/supabase-migrations`](supabase-migrations.md) | Rever / gerar migrações | `SUPABASE_MIGRATIONS.md` |
| [`/supabase-performance`](supabase-performance.md) | Indexes, queries, realtime, N+1 | `SUPABASE_PERFORMANCE.md` |
| [`/supabase-auth`](supabase-auth.md) | Auth, service_role, SSR, JWT | `SUPABASE_SECURITY.md` (Auth) |
| [`/supabase-storage`](supabase-storage.md) | Buckets, policies, paths, MIME | `SUPABASE_SECURITY.md` (Storage) |
| [`/supabase-realtime`](supabase-realtime.md) | Filtros, escala, Broadcast/Presence | `SUPABASE_SECURITY.md` (Realtime) |
| [`/supabase-edge-functions`](supabase-edge-functions.md) | Edge Functions seguras | `SUPABASE_SECURITY.md` (Edge) |
| [`/supabase-production-check`](supabase-production-check.md) | Production readiness 11-secção | `SUPABASE_PRODUCTION.md` |
| [`/supabase-docs`](supabase-docs.md) | Documentação técnica | `SUPABASE_ARCHITECTURE.md` + outros |
| [`/supabase-rag`](supabase-rag.md) | pgvector / RAG / semantic + hybrid search | `SUPABASE_RAG.md` |

## Decision matrix — qual comando usar quando

### Por problema observado

| O que detetas / queres | Comando primário | Comandos complementares |
|---|---|---|
| Ainda não sei se há problemas — "audita tudo" | `/supabase-audit` | (Output bloqueado por bloqueador? Continuar com os específicos.) |
| Mensagem "permission denied" inesperada no cliente | `/supabase-rls` | `/supabase-auth` |
| Query lenta / 500 timeout em produção | `/supabase-performance` | `/supabase-rls` (policy mal indexada) |
| Tabela nova / refactor de schema | `/supabase-architect` ou `/supabase-rls` | `/supabase-migrations` |
| Prestes a correr migration em produção | `/supabase-migrations` | — |
| Bucket público sem querer? Uploads não funcionam? | `/supabase-storage` | `/supabase-auth` |
| Auth flow não funciona em SSR; cookies fora de sincronia | `/supabase-auth` | — |
| Configurar MFA / SSO / Anonymous sign-ins | `/supabase-auth` | — |
| Realtime gera muito custo / events em fan-out | `/supabase-realtime` | `/supabase-performance` |
| Edge Function pública sem auth | `/supabase-edge-functions` | `/supabase-auth` |
| Webhook do Stripe / Resend / etc. | `/supabase-edge-functions` | — |
| Vai abrir ao público; é seguro lançar? | `/supabase-production-check` | `/supabase-audit` (preliminar) |
| Setup novo de semantic search / chatbot RAG | `/supabase-rag` (modo `setup`) | `/supabase-rls` |
| Already have RAG — está seguro? | `/supabase-rag` (modo `audit`) | `/supabase-performance` |
| Documentar projeto para handoff / onboarding | `/supabase-docs` | `/supabase-architect` |

### Por tipo de pergunta

| Pergunta começa com... | Comando |
|---|---|
| "Esta policy está segura?" / "Como faço RLS para..." | `/supabase-rls` |
| "Esta migration é segura?" / "Como rolo isto sem downtime?" | `/supabase-migrations` |
| "Que indexes faltam?" / "Esta query é lenta porquê?" | `/supabase-performance` |
| "Como configuro MFA?" / "Como integro SSO?" | `/supabase-auth` |
| "Setup do meu bucket está bem?" / "Como sirvo PDF privado?" | `/supabase-storage` |
| "Devo usar realtime para isto?" / "Como filtro events por tenant?" | `/supabase-realtime` |
| "Como faço webhook seguro?" / "Onde guardo secrets?" | `/supabase-edge-functions` |
| "Estou pronto para produção?" | `/supabase-production-check` |
| "Como faço RAG com pgvector?" / "HNSW ou IVFFlat?" | `/supabase-rag` |
| "Pode auditar tudo?" / "Audit completo" | `/supabase-audit` |
| "Gera-me docs do projeto" | `/supabase-docs` |

### Por contexto

| Estás a... | Comando |
|---|---|
| **Desenhar projeto novo** | `/supabase-architect` → `/supabase-rls` → `/supabase-migrations` |
| **Auditar projeto existente** | `/supabase-audit` (uma vez) → fixes por command específico |
| **Adicionar feature** | `/supabase-rls` (se nova tabela) + `/supabase-migrations` |
| **Investigar bug em produção** | `/supabase-performance` ou `/supabase-rls` consoante sintoma |
| **Pré-deploy crítico** | `/supabase-production-check` |
| **Onboarding de membro novo** | `/supabase-docs` |
| **Refactor para multi-tenant** | `/supabase-rls` + `/supabase-architect` |

### Quando NÃO usar um comando

- **`/supabase-audit` em PR pequenos** — overkill. Usar command específico.
- **`/supabase-production-check` em projeto inicial** — vai ter score muito baixo. Esperar até estar 60%+ pronto.
- **`/supabase-rag` sem ter requirements claros** — RAG sem caso de uso bem definido é over-engineering.
- **`/supabase-realtime` para listings normais** — polling chega. Realtime para colaboração ao vivo.

## Princípios

- Todos os comandos seguem o workflow das 7 fases de [`../SKILL.md`](../SKILL.md).
- Cada comando carrega apenas as `references/` relevantes ao seu escopo (loading hierárquico).
- Output é sempre um ficheiro Markdown estruturado pronto a commitar em `docs/`.
- Comandos podem ser **encadeados**: `/supabase-audit` deteta → `/supabase-rls fix-all` aplica → `/supabase-production-check` valida.
