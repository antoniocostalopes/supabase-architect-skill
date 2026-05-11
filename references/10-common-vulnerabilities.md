# Vulnerabilidades e Anti-Patterns Comuns em Supabase

Catálogo de problemas frequentes em projetos Supabase, com sintoma, impacto e fix.

## V01 — Tabela sem RLS (Crítico)

**Sintoma**: `CREATE TABLE public.invoices (...)` sem `ALTER TABLE invoices ENABLE ROW LEVEL SECURITY`.

**Impacto**: Qualquer cliente com a `anon` ou `authenticated` key (todo o frontend) pode `SELECT * FROM invoices` via REST/PostgREST.

**Detecção**:
```sql
SELECT schemaname, tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public' AND rowsecurity = false;
```

**Fix**:
```sql
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
-- Adicionar policies imediatamente; RLS sem policies = nega tudo.
```

## V02 — Policy `USING (true)` (Crítico)

**Sintoma**:
```sql
CREATE POLICY "Allow all" ON public.documents FOR SELECT USING (true);
```

**Impacto**: A policy autoriza qualquer linha. Equivalente a não ter RLS para a operação coberta.

**Fix**: Substituir por filtro de ownership ou tenant. Ver `01-rls-patterns.md`.

## V03 — Policy só com `user_id` em sistema multi-tenant (Alto)

**Sintoma**:
```sql
CREATE POLICY "Own docs" ON public.documents
FOR SELECT USING (user_id = auth.uid());
```

Mas a tabela tem `organization_id` e o produto é SaaS multi-tenant.

**Impacto**: Um utilizador admin da Org A com acesso direto à DB consegue colocar o seu `user_id` num INSERT/UPDATE como sendo de outro registo? Não. Mas o problema real: se um utilizador pertencer a Org A e Org B, vê documentos privados de Org A mesmo quando autenticado no contexto de Org B. E cross-references entre `documents` e `organizations.settings` podem expor dados de outro tenant via JOINs explorados.

**Fix**:
```sql
CREATE POLICY "Org docs read" ON public.documents
FOR SELECT USING (
  organization_id IN (
    SELECT organization_id FROM public.memberships WHERE user_id = auth.uid()
  )
);
```

## V04 — `service_role` exposto no frontend (Crítico)

**Sintoma**:
```env
NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY=eyJ...
```

Ou:
```ts
const supabase = createClient(url, process.env.NEXT_PUBLIC_SERVICE_ROLE)
```

**Impacto**: Qualquer visitante do site lê a key em `view-source`. Bypass total de RLS. Acesso completo à DB.

**Detecção** (grep):
```
NEXT_PUBLIC_.*SERVICE_ROLE
PUBLIC.*service_role
createClient.*SERVICE_ROLE.*(?!Edge)
```

**Fix**:
1. Rotar a key imediatamente no Supabase Dashboard
2. Mover o uso para Edge Function ou server-only route handler
3. `SUPABASE_SERVICE_ROLE_KEY` sem prefixo público
4. Auditar logs por acesso suspeito

## V05 — Bucket público com dados privados (Alto→Crítico)

**Sintoma**:
```sql
INSERT INTO storage.buckets (id, name, public) VALUES ('invoices', 'invoices', true);
```

**Impacto**: Qualquer URL `https://<project>.supabase.co/storage/v1/object/public/invoices/<path>` é acessível sem auth. Se `<path>` é previsível ou listável, exfiltração total.

**Fix**:
```sql
UPDATE storage.buckets SET public = false WHERE id = 'invoices';
-- Adicionar policies + usar signed URLs no cliente
```

## V06 — Storage sem policies (Crítico em buckets privados de upload)

**Sintoma**: Bucket privado mas sem policies em `storage.objects` → ninguém faz upload (parece OK) **OU** policy `USING (true)` em upload → qualquer um carrega para qualquer path.

**Fix**: Policies por bucket com path-based ownership.
```sql
CREATE POLICY "Org members upload to own folder"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'documents'
  AND (storage.foldername(name))[1] IN (
    SELECT organization_id::text FROM public.memberships
    WHERE user_id = auth.uid()
  )
);
```

## V07 — FK sem índice (Médio→Alto)

**Sintoma**:
```sql
CREATE TABLE comments (
  id uuid PRIMARY KEY,
  post_id uuid REFERENCES posts(id),  -- FK sem index
  ...
);
```

**Impacto**:
- DELETE/UPDATE em `posts` faz scan sequencial em `comments` para verificar integridade referencial
- JOIN `posts → comments` lento
- Em multi-tenant, `WHERE organization_id = ... AND post_id = ...` não usa o melhor plan

**Fix**:
```sql
CREATE INDEX CONCURRENTLY idx_comments_post_id ON comments(post_id);
-- ou composto se for sempre filtrado por org:
CREATE INDEX CONCURRENTLY idx_comments_org_post ON comments(organization_id, post_id);
```

## V08 — `CREATE INDEX` sem `CONCURRENTLY` em produção (Alto)

**Sintoma** numa migração:
```sql
CREATE INDEX idx_orders_user ON orders(user_id);
```

**Impacto**: Lock de **escrita** durante a criação. Em tabela com 5M de linhas pode ser minutos com erros 500 no cliente.

**Fix**:
```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_user ON orders(user_id);
-- Nota: CONCURRENTLY não pode estar dentro de transação.
-- No Supabase, separar do resto da migração ou usar deploy especial.
```

## V09 — `ALTER TABLE ... NOT NULL` sem `DEFAULT` (Alto)

**Sintoma**:
```sql
ALTER TABLE users ADD COLUMN tier text NOT NULL;
```

**Impacto**: Falha imediata se houver linhas (não há default). Mesmo com `DEFAULT`, em Postgres <11 rewrita a tabela.

**Fix** (Postgres ≥11, default constante):
```sql
ALTER TABLE users ADD COLUMN tier text NOT NULL DEFAULT 'free';
-- Fast — apenas catalog change.
```

**Fix** (default não-constante ou volume crítico):
```sql
-- 1. Add nullable
ALTER TABLE users ADD COLUMN tier text;
-- 2. Backfill em batches (fora desta migração)
UPDATE users SET tier = 'free' WHERE tier IS NULL AND id IN (
  SELECT id FROM users WHERE tier IS NULL LIMIT 10000
);
-- 3. Add constraint depois
ALTER TABLE users ALTER COLUMN tier SET NOT NULL;
ALTER TABLE users ALTER COLUMN tier SET DEFAULT 'free';
```

## V10 — `DROP COLUMN` direto (Alto)

**Sintoma**:
```sql
ALTER TABLE users DROP COLUMN legacy_field;
```

**Impacto**: Perda de dados irreversível. Se clientes ainda enviarem o campo → erros 400. Se outras tabelas/views referenciarem → cascata.

**Fix recomendado** (deprecação em 2 deploys):
1. Deploy A: parar de escrever; manter coluna. Renomear para `legacy_field_deprecated_2026_05`.
2. Deploy B (semanas depois, validado): `DROP COLUMN`.

## V11 — Edge Function sem validação de auth (Alto)

**Sintoma**:
```ts
Deno.serve(async (req) => {
  const body = await req.json()
  const supabase = createClient(url, SERVICE_ROLE_KEY)
  await supabase.from('orders').insert(body)
  return new Response('ok')
})
```

**Impacto**: Endpoint anónimo. Qualquer um cria orders em nome de qualquer user.

**Fix**:
```ts
Deno.serve(async (req) => {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return new Response('Unauthorized', { status: 401 })

  const userClient = createClient(url, ANON_KEY, {
    global: { headers: { Authorization: authHeader } }
  })
  const { data: { user } } = await userClient.auth.getUser()
  if (!user) return new Response('Unauthorized', { status: 401 })

  // Validar membership do recurso
  // ...
  // Só então usar service_role se for mesmo necessário
})
```

## V12 — Realtime sem filtro de tenant (Médio→Alto)

**Sintoma**:
```ts
supabase.channel('orders').on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, handler).subscribe()
```

**Impacto**:
- O cliente recebe eventos de **todos os tenants** (RLS filtra payload, mas o backend avalia tudo)
- Custo de CPU + bandwidth desproporcional
- Em caso de policy mal desenhada, leak parcial

**Fix**:
```ts
supabase.channel(`orders:${orgId}`)
  .on('postgres_changes', {
    event: '*',
    schema: 'public',
    table: 'orders',
    filter: `organization_id=eq.${orgId}`
  }, handler)
  .subscribe()
```

E policy correspondente:
```sql
CREATE POLICY "Realtime orders by org" ON public.orders
FOR SELECT USING (
  organization_id IN (SELECT organization_id FROM memberships WHERE user_id = auth.uid())
);
```

## V13 — `SECURITY DEFINER` em função sem `search_path` fixo (Alto)

**Sintoma**:
```sql
CREATE FUNCTION get_user_role() RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
AS $$ ... $$;
```

**Impacto**: Função corre com privilégios do owner. Se o `search_path` não estiver fixado, um utilizador pode criar um schema/função com o mesmo nome e fazer escalação de privilégios (CVE-style classic).

**Fix**:
```sql
CREATE FUNCTION public.get_user_role() RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$ ... $$;
REVOKE EXECUTE ON FUNCTION public.get_user_role() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_user_role() TO authenticated;
```

## V14 — Trigger `updated_at` em falta (Médio)

**Sintoma**: Tabela tem coluna `updated_at timestamptz` mas nenhum trigger atualiza.

**Impacto**: Coluna fica obsoleta. Lógica de cache/sync baseada em `updated_at` quebra silenciosamente.

**Fix**:
```sql
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_orders_updated_at
BEFORE UPDATE ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
```

## V15 — Soft-delete inconsistente (Médio)

**Sintoma**: Tabela tem `deleted_at` mas policies/queries não filtram. Resultado: utilizadores veem registos "apagados".

**Fix**: Filtrar em todas as policies SELECT:
```sql
CREATE POLICY "Org docs read alive" ON public.documents
FOR SELECT USING (
  deleted_at IS NULL
  AND organization_id IN (SELECT organization_id FROM memberships WHERE user_id = auth.uid())
);
```

E criar **partial index**:
```sql
CREATE INDEX CONCURRENTLY idx_docs_alive
ON documents(organization_id, created_at DESC)
WHERE deleted_at IS NULL;
```

## V16 — `auth.uid()` chamado dentro de função sem `STABLE` (Médio)

**Sintoma**: Função custom usa `auth.uid()` em SELECT mas não marca a função como `STABLE`/`IMMUTABLE`.

**Impacto**: Planner não consegue otimizar. Em policies, pode causar re-avaliação por linha.

**Fix**:
```sql
CREATE OR REPLACE FUNCTION public.current_org_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT organization_id FROM memberships
  WHERE user_id = auth.uid() AND is_active = true
  LIMIT 1;
$$;
```

## V17 — `anon` com privilégios excessivos (Alto)

**Sintoma**: Default Supabase é generoso. `GRANT ALL ON SCHEMA public TO anon;` em algumas instalações.

**Detecção**:
```sql
SELECT grantee, table_schema, table_name, privilege_type
FROM information_schema.table_privileges
WHERE grantee IN ('anon', 'authenticated')
ORDER BY grantee, table_schema, table_name;
```

**Fix**: Revogar agressivamente.
```sql
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
-- Conceder seletivamente nas tabelas que devem ser legíveis sem auth
GRANT SELECT ON public.blog_posts TO anon;
```

## V18 — Migrações que não estão em `supabase/migrations/` (Médio)

**Sintoma**: Schema foi alterado via Studio/UI e não foi capturado em migrações versionadas.

**Impacto**: Drift entre ambientes. Impossível reproduzir.

**Detecção**: `supabase db diff` mostra alterações pendentes.

**Fix**: `supabase db diff --use-migra -f sync_drift` e rever antes de commitar.

## V19 — Realtime ligado em tabelas grandes (Médio)

**Sintoma**: `alter publication supabase_realtime add table large_log_table;`

**Impacto**: Cada INSERT/UPDATE/DELETE em `large_log_table` é replicado e avaliado. Custo significativo.

**Fix**: Só ativar realtime em tabelas onde o produto precisa de UI ao vivo.

## V20 — `RETURNING *` em queries com colunas sensíveis (Médio)

**Sintoma**:
```ts
const { data } = await supabase.from('users').update({...}).eq(...).select()
// RLS protege quem mas o response inclui todas as colunas
```

**Fix**: Selecionar colunas explícitas:
```ts
.select('id, name, email, role')
```

E para campos sensíveis (ex: `password_hash` se existir, `internal_notes`), mover para tabela separada com policy restritiva.

## Heatmap de risco (referência rápida)

| Vulnerabilidade | Frequência observada | Severidade típica |
|---|---|---|
| V01 RLS missing | Alta | Crítico |
| V03 Policy sem org filter | Alta | Alto |
| V07 FK sem index | Muito alta | Médio→Alto |
| V04 service_role exposto | Média | Crítico |
| V05 Bucket público com PII | Média | Alto→Crítico |
| V11 Edge Function sem auth | Alta | Alto |
| V12 Realtime sem filtro | Alta | Médio→Alto |
| V02 USING (true) | Média | Crítico |
| V08/V09 Migration locks | Muito alta | Alto |
| V13 SECURITY DEFINER sem search_path | Baixa | Alto |
