# Templates — Supabase Architect

Templates **fixos** para os outputs gerados pela skill. Sempre que possível, copia a estrutura literalmente.

| Template | Output | Quando usar |
|---|---|---|
| [`audit.md`](audit.md) | `SUPABASE_AUDIT.md` | Auditoria completa (13 lentes) |
| [`security.md`](security.md) | `SUPABASE_SECURITY.md` | Auth + Storage + Edge + Secrets |
| [`architecture.md`](architecture.md) | `SUPABASE_ARCHITECTURE.md` | Desenho de schema / documentação |
| [`rls.md`](rls.md) | `SUPABASE_RLS.md` | Geração / revisão de policies |
| [`performance.md`](performance.md) | `SUPABASE_PERFORMANCE.md` | Análise de performance / indexes |
| [`migrations.md`](migrations.md) | Migration `.sql` + report | Review / geração de migração |
| [`production.md`](production.md) | `SUPABASE_PRODUCTION.md` | Production readiness assessment |
| [`rag.md`](rag.md) | `SUPABASE_RAG.md` | Setup / audit / tuning de pgvector + RAG |
| [`testing.md`](testing.md) | `SUPABASE_TESTING.md` | Setup / audit de CI/CD + pgTAP |
| [`branching.md`](branching.md) | `SUPABASE_BRANCHING.md` | Setup / audit de branching + ambientes |
| [`incident.md`](incident.md) | `SUPABASE_INCIDENT.md` | Post-incident review (blameless postmortem) |

## Princípios de uso

- O template é a estrutura. **Preencher** com dados reais do projeto, não copiar placeholders.
- Achados sem evidência clara são marcados "**Suspeita** — requer verificação manual".
- Cada SQL de fix deve ser copy-paste pronto, com indexes e rollback quando aplicável.
- Score e prioridades calculados conforme a regra definida em `audit.md`.
