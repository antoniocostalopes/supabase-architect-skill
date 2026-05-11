# Example — SUPABASE_PERFORMANCE.md (SaaS B2B)

Exemplo do output de `/supabase-performance` num projeto com queries lentas e indexes em falta.

Contexto: dashboard de orders demora 8s. Tabela tem 12M rows. Stack: Next.js + Supabase Pro.

---

```markdown
# SUPABASE_PERFORMANCE — acme-crm

> Gerado por **Supabase Architect** em 2026-05-11.
> Escopo: análise de queries lentas + audit de indexes.

## Sumário

- **Queries lentas identificadas**: 3
- **FKs sem index**: 5 (1 crítica — tabela `activities` com 1.1M rows)
- **Indexes redundantes**: 2 (~340 MB recuperáveis)
- **Realtime overhead**: 1 tabela inadequada (`audit_logs`)

## 1. Query lenta principal

### Query
```sql
SELECT * FROM public.orders
WHERE organization_id = $1 AND status = 'pending'
ORDER BY created_at DESC LIMIT 50;
```

### EXPLAIN ANALYZE actual
```
Sort  (cost=18234.50..18250.50 rows=6400 width=240) (actual time=7820.12..7820.34 rows=48 loops=1)
  Sort Key: created_at DESC
  Sort Method: top-N heapsort  Memory: 25kB
  ->  Seq Scan on orders  (cost=0.00..15244.00 rows=6400 width=240) (actual time=0.94..7234.55 rows=12384 loops=1)
        Filter: ((organization_id = $1) AND (status = 'pending'::text))
        Rows Removed by Filter: 12003896
Planning Time: 0.18 ms
Execution Time: 7820.89 ms
```

**Diagnóstico**:
- `Seq Scan` em tabela de 12M rows
- `Rows Removed by Filter: 12_003_896` — Postgres lê tudo, descarta 99.9%
- Nem index em `organization_id` nem em `(organization_id, status, created_at)`

### Fix

**Opção A (recomendada): partial index para hot path**
```sql
CREATE INDEX CONCURRENTLY idx_orders_org_pending_created
  ON public.orders(organization_id, created_at DESC)
  WHERE status = 'pending';
```

Vantagens: index pequeno (só orders pending), suporta ordering, suporta filtro de tenant.

**EXPLAIN esperado após**:
```
Limit  (cost=0.43..15.85 rows=50 width=240) (actual time=0.18..1.24 rows=48 loops=1)
  ->  Index Scan using idx_orders_org_pending_created on orders
        Index Cond: (organization_id = $1)
Planning Time: 0.12 ms
Execution Time: 1.42 ms
```

**Opção B (alternativa): index composto sem partial**
```sql
CREATE INDEX CONCURRENTLY idx_orders_org_status_created
  ON public.orders(organization_id, status, created_at DESC);
```

Mais genérico (cobre filtros por status diversos) mas mais pesado. Escolher A se `status = 'pending'` é o caso 80%+; B se há vários status filtrados.

### Otimização adicional: SELECT colunas explícitas

```ts
// ANTES
.from('orders').select()  // ~50 colunas, payload grande

// DEPOIS
.from('orders').select('id, status, amount, currency, created_at, customer_id')
```

Reduz egress + parsing no cliente.

## 2. FKs sem index

Query usada:
```sql
SELECT c.conrelid::regclass AS tbl, a.attname AS col
FROM pg_constraint c
JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
WHERE c.contype = 'f'
  AND NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = c.conrelid AND a.attnum = i.indkey[0]
  );
```

Resultado:
| Tabela | FK | Linhas estimadas | Heurística | Severidade |
|---|---|---|---|---|
| public.activities | deal_id | 1.1M | H17 | **Alto** |
| public.activities | contact_id | 1.1M | H17 | **Alto** |
| public.stages | pipeline_id | 6.5k | H17 | Médio |
| public.comments | deal_id | 84k | H17 | Médio |
| public.deal_history | deal_id | 420k | H17 | Médio |

Fix:
```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_activities_deal_id
  ON public.activities(deal_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_activities_contact_id
  ON public.activities(contact_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_stages_pipeline_id
  ON public.stages(pipeline_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_comments_deal_id
  ON public.comments(deal_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_deal_history_deal_id
  ON public.deal_history(deal_id);
```

**Impacto esperado**: DELETE em `deals` cai de seq scan (~2s) para index scan (~5ms).

## 3. Indexes redundantes

```sql
SELECT
  s.schemaname || '.' || s.indexrelname AS index_name,
  pg_size_pretty(pg_relation_size(s.indexrelid)) AS size
FROM pg_stat_user_indexes s
JOIN pg_index i ON i.indexrelid = s.indexrelid
WHERE s.idx_scan = 0 AND NOT i.indisunique AND s.schemaname = 'public'
ORDER BY pg_relation_size(s.indexrelid) DESC;
```

Resultado:
| Index | Tamanho | Recomendação |
|---|---|---|
| idx_orders_legacy_email | 220 MB | DROP — coluna `email` deprecada |
| idx_deals_old_status | 120 MB | DROP — substituído por `idx_deals_status_created` |

```sql
DROP INDEX CONCURRENTLY public.idx_orders_legacy_email;
DROP INDEX CONCURRENTLY public.idx_deals_old_status;
```

**Cuidado**: confirmar que mesmo `idx_scan = 0` não é index para policy raramente acionada. Se for, manter.

## 4. Realtime — tabelas inadequadas

```sql
SELECT pubname, schemaname, tablename
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime';
```

| Tabela | Adequada? | Justificação |
|---|---|---|
| messages | ✅ | Chat em tempo real |
| notifications | ✅ | UI updates |
| audit_logs | **❌** | 4.2M rows, write-heavy. Realtime desnecessário. **Heurística H33** |

Fix:
```sql
ALTER PUBLICATION supabase_realtime DROP TABLE public.audit_logs;
```

**Impacto**: reduz WAL replication overhead + CPU em peak hours.

## 5. N+1 do cliente (revisão)

### Padrão detectado em `src/app/dashboard/page.tsx:42`

```ts
// ANTES — N+1
const { data: deals } = await supabase.from('deals').select().eq('organization_id', orgId)
for (const deal of deals ?? []) {
  const { data: activities } = await supabase
    .from('activities').select().eq('deal_id', deal.id)
  // ... 50 deals → 51 round-trips
}
```

### Fix — embedding

```ts
const { data } = await supabase
  .from('deals')
  .select(`
    id, name, amount, stage,
    activities ( id, type, occurred_at, contact_id )
  `)
  .eq('organization_id', orgId)
  .order('created_at', { ascending: false })
  .limit(50)
```

**Impacto**: 51 round-trips → 1. Latência cai de ~3s para ~150ms.

## 6. Connection pooling

### Verificação
```bash
# Confirmar URL no `.env.production`
grep -E "(54)?32" .env.production
```

Resultado: `DATABASE_URL=...supabase.co:5432/postgres`

Stack é Next.js serverless (Vercel) → devia ser **transaction mode** (`:6543`).

Fix:
```env
# .env.production
DATABASE_URL=postgresql://postgres.<ref>:<password>@<pooler>:6543/postgres?pgbouncer=true
```

## 7. Materialized view recomendada

Dashboard agregado de revenue mensal por org:
```sql
CREATE MATERIALIZED VIEW public.org_monthly_revenue AS
SELECT
  organization_id,
  date_trunc('month', created_at) AS month,
  count(*) AS orders_count,
  sum(amount) FILTER (WHERE status = 'paid') AS revenue
FROM public.orders
WHERE deleted_at IS NULL
GROUP BY organization_id, date_trunc('month', created_at);

CREATE UNIQUE INDEX idx_org_monthly_revenue_unique
  ON public.org_monthly_revenue(organization_id, month);

-- Refresh agendado
SELECT cron.schedule(
  'refresh-org-revenue',
  '*/15 * * * *',  -- a cada 15 min
  $$REFRESH MATERIALIZED VIEW CONCURRENTLY public.org_monthly_revenue$$
);
```

Dashboard query passa de query agregado completo (12M rows) → SELECT direto (1 row por org-mês).

## Plano de aplicação

### Fase 1 — Quick wins (1 dia, fora de janela de tráfego)
- [ ] `CREATE INDEX CONCURRENTLY` para 5 FKs
- [ ] Partial index para orders pending
- [ ] Remover audit_logs da publication realtime
- [ ] DROP indexes não usados

### Fase 2 — App refactor (1 semana)
- [ ] Substituir N+1 no dashboard por embedding
- [ ] SELECT colunas explícitas nos hot paths
- [ ] Materialized view org_monthly_revenue
- [ ] Connection pooling corrigido em `.env.production`

### Fase 3 — Validação
- [ ] EXPLAIN ANALYZE das queries críticas — antes/depois documentado em commit
- [ ] Supabase Reports → p95 < 100ms em routes hot
- [ ] Cost mensal Supabase: avaliar redução de egress / compute

## Métricas baseline (para comparar depois)

```sql
-- Hot tables
SELECT relname, n_live_tup, pg_size_pretty(pg_relation_size(relid)) AS size
FROM pg_stat_user_tables WHERE schemaname = 'public'
ORDER BY n_live_tup DESC LIMIT 10;

-- Seq scans excessivos
SELECT relname, seq_scan, idx_scan, seq_tup_read
FROM pg_stat_user_tables WHERE schemaname = 'public'
ORDER BY seq_tup_read DESC LIMIT 10;

-- Top indexes não usados
SELECT relname, indexrelname, idx_scan,
       pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_stat_user_indexes
WHERE schemaname = 'public' AND idx_scan < 100
ORDER BY pg_relation_size(indexrelid) DESC LIMIT 20;
```

Tirar snapshot antes de Fase 1 → comparar 1 semana depois.
```

---

## Notas — uso deste example

- Foca na **dor real** (query 8s) e mostra **causa via EXPLAIN ANALYZE**, não suposições
- Apresenta **opção A vs B** quando há trade-off (partial vs composite index)
- Sempre `CONCURRENTLY` em produção
- N+1 do cliente é parte integral — performance não é só DB
- Materialized view com refresh **agendado** via pg_cron
- Plano em 3 fases (quick wins → refactor → validação)
- **Metricas baseline** para o developer poder medir o impacto
