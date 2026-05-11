# Template — SUPABASE_PERFORMANCE.md

Estrutura fixa para análise de performance.

---

```markdown
# SUPABASE_PERFORMANCE — <project_name>

> Análise de performance gerada por **Supabase Architect** em <YYYY-MM-DD>.

## Sumário

- **Queries lentas identificadas**: <n>
- **Indexes em falta**: <n>
- **Indexes redundantes**: <n>
- **Tabelas com seq scans excessivos**: <n>

## 1. FKs sem index (Alto impacto)

| Tabela | FK | Linhas estimadas | Comando |
|---|---|---|---|
| public.comments | post_id | 250k | `CREATE INDEX CONCURRENTLY idx_comments_post_id ON public.comments(post_id);` |
| public.tasks | project_id | 1.2M | `CREATE INDEX CONCURRENTLY idx_tasks_project_id ON public.tasks(project_id);` |

Query de detecção:
```sql
SELECT
  c.conrelid::regclass AS table_name,
  a.attname AS fk_column
FROM pg_constraint c
JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
WHERE c.contype = 'f'
  AND NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = c.conrelid AND a.attnum = i.indkey[0]
  );
```

## 2. Indexes recomendados

### 2.1 Multi-tenant base
```sql
-- Para cada tabela <T> com organization_id:
CREATE INDEX CONCURRENTLY idx_<T>_org_alive
  ON public.<T>(organization_id, created_at DESC)
  WHERE deleted_at IS NULL;
```

### 2.2 Padrões observados
| Query pattern | Index proposto |
|---|---|
| `WHERE org_id = X AND status = 'pending' ORDER BY created_at DESC` | `(organization_id, status, created_at DESC)` |
| `WHERE org_id = X AND user_id = Y` | `(organization_id, user_id)` |
| `WHERE deleted_at IS NULL AND ...` | partial `WHERE deleted_at IS NULL` |

## 3. Indexes redundantes/nunca usados

```sql
-- Query de detecção
SELECT schemaname, relname, indexrelname,
       pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_stat_user_indexes
JOIN pg_index USING (indexrelid)
WHERE idx_scan = 0 AND NOT indisunique AND schemaname = 'public'
ORDER BY pg_relation_size(indexrelid) DESC;
```

Achados:
| Index | Tamanho | Recomendação |
|---|---|---|
| `idx_old_unused` | 240MB | DROP após confirmar |

## 4. Tabelas com seq scans excessivos

```sql
SELECT relname, seq_scan, idx_scan,
       pg_size_pretty(pg_relation_size(relid)) AS size
FROM pg_stat_user_tables
WHERE schemaname = 'public' AND seq_scan > 100
ORDER BY seq_tup_read DESC LIMIT 20;
```

Achados:
| Tabela | seq_scan | Hipótese | Ação |
|---|---|---|---|
| public.tasks | 12k | Queries por `assignee_id` sem index | Adicionar `idx_tasks_assignee` |

## 5. Queries lentas

### Query 1
```sql
SELECT * FROM public.orders
WHERE organization_id = $1 AND status = 'pending'
ORDER BY created_at DESC LIMIT 50;
```

EXPLAIN (atual):
```
Seq Scan on orders  (cost=0.00..15400.00 rows=120 width=...)
  Filter: ((organization_id = $1) AND (status = 'pending'))
  Rows Removed by Filter: 4_998_900
```

Fix:
```sql
CREATE INDEX CONCURRENTLY idx_orders_org_status_created
  ON public.orders(organization_id, status, created_at DESC);
```

EXPLAIN (esperado):
```
Index Scan using idx_orders_org_status_created on orders
  Index Cond: ((organization_id = $1) AND (status = 'pending'))
  Limit: 50
```

### Query 2
…

## 6. N+1 do cliente

### Padrão detectado em `src/app/dashboard/page.tsx:42`
```ts
const { data: orgs } = await supabase.from('organizations').select()
for (const org of orgs) {
  const { data: members } = await supabase.from('memberships')
    .select().eq('organization_id', org.id)
}
```

Fix:
```ts
const { data } = await supabase
  .from('organizations')
  .select(`id, name, memberships ( user_id, role )`)
```

## 7. Realtime cost

Tabelas em `supabase_realtime`:
| Tabela | Justificada? | Replica identity |
|---|---|---|
| public.messages | sim | default |
| public.audit_logs | **não** | full |

Remover:
```sql
ALTER PUBLICATION supabase_realtime DROP TABLE public.audit_logs;
```

## 8. Materialized views recomendadas

### Dashboard agregado por org
```sql
CREATE MATERIALIZED VIEW public.org_monthly_stats AS
SELECT
  organization_id,
  date_trunc('month', created_at) AS month,
  count(*) AS orders_count,
  sum(amount) AS revenue
FROM public.orders
GROUP BY organization_id, date_trunc('month', created_at);

CREATE UNIQUE INDEX ON public.org_monthly_stats(organization_id, month);

-- Refresh agendado
SELECT cron.schedule('refresh-org-stats', '0 * * * *',
  $$REFRESH MATERIALIZED VIEW CONCURRENTLY public.org_monthly_stats$$);
```

## 9. Paginação

### Substituir OFFSET por cursor
Em `src/components/OrdersList.tsx:18`:

```ts
// MAU
.range(offset, offset + 49)

// BOM
.lt('created_at', cursor.created_at)
.order('created_at', { ascending: false })
.order('id', { ascending: false })
.limit(50)
```

## 10. Connection pooling

| Ambiente | Modo correto | URL atual | Status |
|---|---|---|---|
| Next.js API routes (serverless) | transaction `:6543` | `:5432` | **Corrigir** |
| Workers long-lived | session `:5432` | `:5432` | OK |

## Plano de aplicação

### Fase 1 — Quick wins (1 dia)
- [ ] CREATE INDEX CONCURRENTLY para FKs sem index
- [ ] Remover `audit_logs` do realtime

### Fase 2 — Reestruturar (1 semana)
- [ ] Indexes compostos para queries identificadas
- [ ] Materialized view para dashboard
- [ ] Cursor pagination

### Fase 3 — Validar
- [ ] EXPLAIN ANALYZE em produção das queries críticas (antes vs depois)
- [ ] Métricas no Dashboard Supabase: p95 < 100ms

## Apêndice — Comandos
```sql
-- Hot tables
SELECT relname, n_live_tup, pg_size_pretty(pg_relation_size(relid)) AS size
FROM pg_stat_user_tables WHERE schemaname = 'public'
ORDER BY n_live_tup DESC LIMIT 20;

-- Hot indexes
SELECT relname, indexrelname, idx_scan,
       pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_stat_user_indexes WHERE schemaname = 'public'
ORDER BY idx_scan DESC LIMIT 20;
```
```
