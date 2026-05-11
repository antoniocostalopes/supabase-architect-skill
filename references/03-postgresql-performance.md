# PostgreSQL Performance para Supabase

Guia operacional para detectar e resolver problemas de performance num projeto Supabase.

## Hierarquia de impacto

Por ordem do que mais frequentemente causa lentidão num SaaS Supabase:

1. **Index missing em FK** ou em coluna de filtro frequente
2. **Policy de RLS sem index a suportar** a expressão
3. **N+1 a partir do cliente** (ORM/SDK)
4. **`SELECT *`** com colunas `jsonb`/`text` grandes
5. **Ausência de paginação** (devolve milhares de linhas)
6. **Subqueries não otimizadas** em policies/views
7. **Lock contention** em UPDATE de hot rows
8. **Realtime em tabelas escritas em alto volume**
9. **Functions sem `STABLE`/`IMMUTABLE`** chamadas em policies
10. **Materialized views desatualizadas** ou refresh sem `CONCURRENTLY`

## Index strategy

### Regra base

Toda coluna que aparece em:
- `JOIN ... ON`
- `WHERE`
- `ORDER BY`
- `GROUP BY` (em alguns casos)
- Subquery de policy RLS

é **candidata** a index. A decisão depende de cardinalidade e padrão de query.

### Indexes obrigatórios em qualquer projeto

```sql
-- 1. Todas as FK
-- Postgres NÃO cria index automaticamente em FK.
-- Sem ele: DELETE/UPDATE na tabela referenciada faz seq scan.

-- Detecção:
SELECT
  c.conrelid::regclass AS table_name,
  a.attname AS column_name
FROM pg_constraint c
JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
WHERE c.contype = 'f'
  AND NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = c.conrelid
      AND a.attnum = ANY(i.indkey)
      AND i.indkey[0] = a.attnum  -- coluna deve estar no início do index
  )
ORDER BY table_name;

-- Fix: criar index para cada FK encontrada
CREATE INDEX CONCURRENTLY idx_<table>_<col> ON public.<table>(<col>);
```

```sql
-- 2. tenant_id / organization_id em todas as tabelas multi-tenant
CREATE INDEX CONCURRENTLY idx_<table>_org ON public.<table>(organization_id);

-- 3. created_at DESC para listagens recentes
CREATE INDEX CONCURRENTLY idx_<table>_created ON public.<table>(created_at DESC);

-- 4. Compostos quando há padrão estável de query
CREATE INDEX CONCURRENTLY idx_<table>_org_created ON public.<table>(organization_id, created_at DESC);
```

### Indexes parciais (para soft-delete e filtros booleanos)

```sql
-- Partial index — só indexa linhas vivas
CREATE INDEX CONCURRENTLY idx_documents_org_alive
ON public.documents(organization_id, created_at DESC)
WHERE deleted_at IS NULL;

-- Para feature flags / queries enviesadas
CREATE INDEX CONCURRENTLY idx_orders_pending
ON public.orders(created_at DESC)
WHERE status = 'pending';
```

Vantagem: menor, mais rápido, e o planner usa-o sempre que a query inclui o predicado.

### Indexes em colunas JSONB

```sql
-- GIN em JSONB completo (queries com @>, ?, ?&, ?|)
CREATE INDEX CONCURRENTLY idx_orders_metadata_gin
ON public.orders USING gin (metadata);

-- BTREE em chave específica (queries em campo conhecido)
CREATE INDEX CONCURRENTLY idx_orders_metadata_status
ON public.orders ((metadata->>'status'));
```

### Indexes em texto (full-text)

```sql
-- tsvector com peso (title > body)
CREATE INDEX CONCURRENTLY idx_posts_fts
ON public.posts USING gin (
  to_tsvector('portuguese', coalesce(title,'') || ' ' || coalesce(body,''))
);

-- pg_trgm para LIKE/ILIKE
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX CONCURRENTLY idx_users_email_trgm
ON public.users USING gin (email gin_trgm_ops);
```

### Indexes para ordering por mais recente

```sql
-- Index DESC explícito
CREATE INDEX CONCURRENTLY idx_events_org_time
ON public.events(organization_id, occurred_at DESC);

-- Permite scan reverso sem sort
```

## Detectar índices em falta

```sql
-- Tabelas com muitos seq scans
SELECT
  schemaname, relname,
  seq_scan, seq_tup_read,
  idx_scan, idx_tup_fetch,
  pg_size_pretty(pg_relation_size(relid)) AS size
FROM pg_stat_user_tables
WHERE schemaname = 'public'
  AND seq_scan > 100
ORDER BY seq_tup_read DESC
LIMIT 20;
```

Tabelas com `seq_tup_read` enorme e `idx_scan` baixo → falta de index ou query problemática.

## Detectar índices duplicados/redundantes

```sql
-- Pares de indexes onde um é prefixo do outro
SELECT
  pg_size_pretty(SUM(pg_relation_size(idx))::bigint) AS size,
  (array_agg(idx))[1] AS idx1, (array_agg(idx))[2] AS idx2
FROM (
  SELECT indexrelid::regclass AS idx,
    (indrelid::text || E'\n' || indclass::text || E'\n' || indkey::text || E'\n' ||
     coalesce(indexprs::text,'') || E'\n' || coalesce(indpred::text,'')) AS key
  FROM pg_index
) sub
GROUP BY key HAVING count(*) > 1
ORDER BY SUM(pg_relation_size(idx)) DESC;
```

## Detectar índices nunca usados

```sql
SELECT
  s.schemaname, s.relname, s.indexrelname,
  pg_size_pretty(pg_relation_size(s.indexrelid)) AS size,
  s.idx_scan
FROM pg_stat_user_indexes s
JOIN pg_index i ON i.indexrelid = s.indexrelid
WHERE s.idx_scan = 0
  AND NOT i.indisunique  -- não apagar unique constraints
  AND s.schemaname = 'public'
ORDER BY pg_relation_size(s.indexrelid) DESC;
```

Atenção: `idx_scan = 0` pode significar:
- O index é mesmo desnecessário → DROP
- A app é nova e ainda não correu queries → manter
- Suporta uma policy RLS raramente acionada → manter

## EXPLAIN para diagnóstico

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT, VERBOSE)
SELECT ...;
```

Sinais a procurar:
- **`Seq Scan` em tabela grande** + `Filter:` selectivo → index missing
- **`Rows Removed by Filter` >> `Rows Returned`** → filtro a aplicar tarde, falta predicado em index
- **`Sort` antes do `Limit`** → falta order matching no index
- **`Nested Loop` com `Rows Removed by Join Filter`** → JOIN sem index
- **`Rows Removed by RLS`** → RLS está a filtrar muito; index na expressão da policy

Para verificar custo real (não estimado):
```sql
EXPLAIN (ANALYZE, BUFFERS)
-- Reparar em "Buffers: shared hit=X read=Y"
-- read = páginas vindas de disco; hit = cache. Hot path deve ser ≈ tudo hit.
```

## RLS e performance

Policies são re-avaliadas por linha. Más policies destroem performance.

### Helper functions devem ser `STABLE` + `SECURITY DEFINER`

```sql
-- LENTO (re-avalia subquery por linha)
CREATE POLICY "x_select" ON public.x FOR SELECT USING (
  organization_id IN (SELECT organization_id FROM memberships WHERE user_id = auth.uid())
);

-- RÁPIDO (função cacheável)
CREATE POLICY "x_select" ON public.x FOR SELECT USING (
  public.is_member(organization_id)
);
```

Onde `public.is_member` é declarada `STABLE SECURITY DEFINER` (ver `02-multi-tenant-patterns.md`).

### `auth.uid()` é STABLE — chamar uma vez

```sql
-- Em RPCs/funções, capturar:
DECLARE current_user_id uuid := auth.uid();
```

### Index "matching" a policy

Se a policy é `USING (organization_id IN (...))`, precisas de index em `organization_id`. Se é `USING (created_by = auth.uid())`, precisas de index em `created_by`.

## N+1 do lado do cliente

### Padrão errado
```ts
const { data: orgs } = await supabase.from('organizations').select()
for (const org of orgs) {
  const { data: members } = await supabase
    .from('memberships').select().eq('organization_id', org.id)
  // N+1 round-trips
}
```

### Correção via embedding (PostgREST)
```ts
const { data } = await supabase
  .from('organizations')
  .select(`
    id, name,
    memberships ( user_id, role )
  `)
// 1 round-trip, 1 query SQL com JOIN
```

### Quando o embedding não chega: RPC

```sql
CREATE OR REPLACE FUNCTION public.dashboard_summary(org uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'orders_count', (SELECT count(*) FROM orders WHERE organization_id = org),
    'revenue_30d',  (SELECT coalesce(sum(amount),0) FROM orders
                     WHERE organization_id = org AND created_at > now() - interval '30 days'),
    'top_products', (SELECT jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'sold',s.qty))
                     FROM (SELECT product_id, sum(qty) qty FROM order_items
                           JOIN orders ON orders.id = order_items.order_id
                           WHERE orders.organization_id = org
                           GROUP BY product_id ORDER BY 2 DESC LIMIT 5) s
                     JOIN products p ON p.id = s.product_id)
  );
$$;
```

Cliente:
```ts
const { data } = await supabase.rpc('dashboard_summary', { org: orgId })
```

## Paginação

### Errado: OFFSET grande
```sql
SELECT * FROM orders WHERE organization_id = $1 ORDER BY created_at DESC OFFSET 10000 LIMIT 50;
-- Lê 10050 linhas para devolver 50.
```

### Correto: cursor-based (keyset pagination)
```sql
-- Primeira página
SELECT * FROM orders
WHERE organization_id = $1
ORDER BY created_at DESC, id DESC
LIMIT 50;

-- Próxima página (passar last_created_at e last_id do cliente)
SELECT * FROM orders
WHERE organization_id = $1
  AND (created_at, id) < ($last_created_at, $last_id)
ORDER BY created_at DESC, id DESC
LIMIT 50;
```

Com index composto `(organization_id, created_at DESC, id DESC)` esta query é O(log n).

PostgREST suporta via:
```ts
await supabase
  .from('orders')
  .select()
  .eq('organization_id', orgId)
  .order('created_at', { ascending: false })
  .order('id', { ascending: false })
  .lt('created_at', cursor.created_at)
  .limit(50)
```

## Materialized views

Para dashboards que agregam dados pesados:

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

-- Refresh sem lock (precisa do UNIQUE INDEX)
REFRESH MATERIALIZED VIEW CONCURRENTLY public.org_monthly_stats;
```

Agendar via pg_cron:
```sql
SELECT cron.schedule('refresh-org-stats', '0 * * * *',
  $$REFRESH MATERIALIZED VIEW CONCURRENTLY public.org_monthly_stats$$);
```

**RLS em materialized views**: por defeito **não** se aplica. Tens de:
1. Filtrar `organization_id` no cliente (com RLS na view associada se possível) **ou**
2. Expor via RPC `SECURITY DEFINER` que aplica filtro

## Lock contention

### Detectar
```sql
SELECT
  pid, usename, datname, state, wait_event_type, wait_event,
  pg_blocking_pids(pid) AS blocked_by, query
FROM pg_stat_activity
WHERE wait_event_type IN ('Lock','LWLock');
```

### Causas comuns
- **Hot row UPDATE** (contador num registo) — usar `UPDATE ... WHERE id = X` em alto volume gera contention. Considerar:
  - Atomic increment (`amount = amount + 1`)
  - Sharding do contador (várias linhas, soma agregada)
  - Mover para Redis/cache se permitido
- **Long transactions** que seguram locks
- **Falta de `CONCURRENTLY`** em índices

## Connection pooling

Supabase oferece pooler (PgBouncer). Em apps Node/Next.js serverless:

- **Transaction mode** (porta `6543`) para serverless functions (não suporta prepared statements duradouros nem `LISTEN/NOTIFY`)
- **Session mode** (porta `5432`) para apps long-lived

Sintomas de pool exhaustion:
- `remaining connection slots are reserved`
- Latência aumenta em picos

## Realtime cost

```sql
-- Ver tabelas com replicação ativa
SELECT pubname, schemaname, tablename
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime';

-- Remover de tabelas com escrita alta
ALTER PUBLICATION supabase_realtime DROP TABLE public.audit_logs;
```

Realtime é **caro por evento**. Não ligar em logs, eventos de webhook, telemetria.

## Checklist de performance

### Por tabela
- [ ] Index na FK?
- [ ] Index em `organization_id` (se multi-tenant)?
- [ ] Index composto para padrão de listing principal?
- [ ] Partial index se há `deleted_at` ou status enviesado?
- [ ] Sem indexes duplicados/redundantes?

### Por query identificada como lenta
- [ ] `EXPLAIN ANALYZE` revela `Seq Scan` em tabela grande?
- [ ] Existe index a suportar `WHERE` + `ORDER BY` combinados?
- [ ] Há `Sort` antes de `Limit`?
- [ ] Há cliente a fazer N round-trips?

### Por policy RLS
- [ ] Usa helper function (`is_member`, `has_role`) e não subquery inline?
- [ ] Função é `STABLE` ou `IMMUTABLE`?
- [ ] Index suporta a expressão da policy?

### Global
- [ ] Realtime só nas tabelas que precisam?
- [ ] Paginação por cursor em listings grandes?
- [ ] Materialized views para dashboards de agregação pesada?
- [ ] Connection pooling configurado para o modo correto?
