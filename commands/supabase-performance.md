---
description: Analisar performance Supabase — indexes, queries, RLS cost, realtime, paginação
argument-hint: [tabela | query | path opcional]
---

Aplica a skill **Supabase Architect** em modo performance sobre `$ARGUMENTS` (ou projeto inteiro).

Carrega:
- `references/03-postgresql-performance.md`
- `references/11-schema-patterns.md`
- `references/10-common-vulnerabilities.md` (V07, V16, V19)
- `references/01-rls-patterns.md` (para avaliar policy cost)

Workflow:
1. Mapeia tabelas, indexes existentes, FKs sem index
2. Detecta queries lentas conhecidas (via heurísticas no código + logs Dashboard se disponíveis)
3. Para cada query/padrão identificado:
   - Sugere `EXPLAIN (ANALYZE, BUFFERS)` para validar
   - Propõe index composto / partial / GIN conforme caso
4. Audita custo de RLS (subqueries inline vs helper functions)
5. Audita custo de realtime (tabelas em publication, replica identity, filtros)
6. Detecta N+1 do cliente (loops com `await supabase.from(...)`)
7. Verifica modo de connection pooling vs runtime (serverless → transaction mode)
8. Sugere materialized views para dashboards de agregação pesada

Output: `SUPABASE_PERFORMANCE.md` seguindo `templates/performance.md`:
- FKs sem index (com SQL `CREATE INDEX CONCURRENTLY`)
- Indexes recomendados (multi-tenant, partial, GIN, FTS)
- Indexes redundantes / nunca usados (com DROP)
- Tabelas com seq scans excessivos
- Queries lentas — EXPLAIN antes/depois
- Refactor N+1 → embedding ou RPC
- Realtime cost (tabelas a remover de publication)
- Materialized views propostas
- Cursor pagination onde aplicável
- Plano de aplicação em 3 fases (quick wins, refactor, validação)
