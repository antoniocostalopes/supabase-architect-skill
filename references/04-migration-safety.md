# Migration Safety em Supabase

Como rever, escrever e gerar migrações que não derrubam produção.

## Princípios

1. **Toda migração corre contra dados reais.** Pensa no estado da tabela em produção.
2. **Toda migração corre com tráfego ativo.** Locks longos = downtime visível.
3. **Toda migração precisa de rollback.** Mesmo que seja "restore from backup".
4. **Toda migração é versionada.** Sem alterações via Studio em produção sem captura.

## Estrutura de migrações no Supabase

```
supabase/
├── config.toml
├── migrations/
│   ├── 20260101120000_initial_schema.sql
│   ├── 20260102093000_add_organizations.sql
│   └── 20260103154500_add_documents_rls.sql
└── seed.sql
```

Convenção: timestamp UTC `YYYYMMDDHHMMSS_<descrição_em_snake>.sql`.

Comandos chave:
```bash
supabase migration new <name>       # cria ficheiro
supabase db diff -f <name>          # gera diff vs schema remoto
supabase db push                    # aplica em remoto
supabase db reset                   # local: drop + replay todas
```

## Anatomia de uma migração segura

```sql
-- Migration: 20260103154500_add_documents_table.sql
-- Author: <quem>
-- Description: Adiciona tabela documents com RLS e indexes.
-- Risk: low — additive only.
-- Rollback: 20260103154500_add_documents_table.down.sql

BEGIN;

-- 1. Schema
CREATE TABLE public.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  title text NOT NULL,
  content text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

-- 2. Indexes (notar: index na FK obrigatório)
CREATE INDEX idx_documents_org_alive
  ON public.documents(organization_id, created_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_documents_creator ON public.documents(created_by);

-- 3. RLS
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "documents_select" ON public.documents
FOR SELECT TO authenticated
USING (public.is_member(organization_id) AND deleted_at IS NULL);

CREATE POLICY "documents_insert" ON public.documents
FOR INSERT TO authenticated
WITH CHECK (public.is_member(organization_id) AND created_by = auth.uid());

CREATE POLICY "documents_update" ON public.documents
FOR UPDATE TO authenticated
USING (public.has_role(organization_id, 'member') OR created_by = auth.uid())
WITH CHECK (public.is_member(organization_id));

CREATE POLICY "documents_delete" ON public.documents
FOR DELETE TO authenticated
USING (public.has_role(organization_id, 'admin'));

-- 4. Trigger de updated_at
CREATE TRIGGER trg_documents_updated_at
BEFORE UPDATE ON public.documents
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 5. Grants
GRANT SELECT, INSERT, UPDATE, DELETE ON public.documents TO authenticated;

COMMIT;
```

**Notas**:
- Tudo dentro de `BEGIN`/`COMMIT` (atómica)
- Comentário inicial documenta risk e rollback
- Indexes criados na mesma migração que a tabela (não há tráfego ainda)
- RLS ativado **e** policies criadas (não deixar tabela com RLS sem policies em deploy se algum cliente já espera ler)

## Operações por nível de risco

### Verde (additive, baixo risco)

Operações que não bloqueiam reads e raramente bloqueiam writes:

```sql
-- Criar tabela nova
CREATE TABLE ...;

-- Adicionar coluna nullable
ALTER TABLE x ADD COLUMN new_col text;

-- Adicionar coluna NOT NULL com DEFAULT constante (Postgres ≥11)
ALTER TABLE x ADD COLUMN tier text NOT NULL DEFAULT 'free';

-- Criar policy / função / trigger
CREATE POLICY ...; CREATE FUNCTION ...;

-- Adicionar grant
GRANT SELECT ON x TO authenticated;
```

### Amarelo (cuidado, requer estratégia)

```sql
-- Criar index em tabela grande
-- → usar CONCURRENTLY fora de transação
CREATE INDEX CONCURRENTLY idx_x_y ON public.x(y);

-- Renomear coluna
-- → cliente antigo ainda envia o nome antigo. Usar duas migrações:
--   1. ADD COLUMN novo, COPY de dados, app passa a usar novo
--   2. DROP COLUMN antigo
ALTER TABLE x RENAME COLUMN old_name TO new_name;

-- Mudar tipo de coluna
-- → pode reescrever a tabela. Avaliar volume.
ALTER TABLE x ALTER COLUMN n TYPE bigint;

-- Adicionar UNIQUE constraint
-- → faz scan completo para verificar.
-- → usar UNIQUE INDEX CONCURRENTLY + ADD CONSTRAINT USING INDEX
CREATE UNIQUE INDEX CONCURRENTLY uq_x_y ON public.x(y);
ALTER TABLE x ADD CONSTRAINT uq_x_y UNIQUE USING INDEX uq_x_y;

-- Adicionar FK
-- → scan para validar; pode bloquear.
-- → usar NOT VALID + VALIDATE em duas fases
ALTER TABLE x ADD CONSTRAINT fk_x_y FOREIGN KEY (y_id) REFERENCES y(id) NOT VALID;
ALTER TABLE x VALIDATE CONSTRAINT fk_x_y;
```

### Vermelho (destrutivo, exige aprovação explícita)

```sql
-- Drop tabela ou coluna
DROP TABLE x;
ALTER TABLE x DROP COLUMN y;

-- Truncate ou delete em massa
TRUNCATE x;
DELETE FROM x WHERE ...;
DELETE FROM x;  -- ← sem WHERE: NUNCA aceitar sem confirmação dupla

-- Update em massa
UPDATE x SET y = 'z';  -- sem WHERE: NUNCA aceitar
UPDATE x SET y = 'z' WHERE always_true_predicate;

-- Mudar coluna PK ou tipo incompatível
ALTER TABLE x ALTER COLUMN id TYPE text;

-- Disable RLS
ALTER TABLE x DISABLE ROW LEVEL SECURITY;
```

## Padrões de expand/contract (zero-downtime)

Para alterações que mudam contrato com a app, separar em fases:

### Renomear coluna

```sql
-- Migration 1 (expand)
ALTER TABLE users ADD COLUMN full_name text;
UPDATE users SET full_name = name;  -- backfill (em batches se tabela grande)
CREATE OR REPLACE FUNCTION sync_full_name() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.full_name := NEW.name; RETURN NEW; END;
$$;
CREATE TRIGGER trg_sync_full_name BEFORE INSERT OR UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION sync_full_name();

-- Deploy 1: app escreve em ambos, lê de full_name
-- Deploy 2: app só escreve em full_name

-- Migration 2 (contract), só depois de garantir que nada lê name
DROP TRIGGER trg_sync_full_name ON users;
DROP FUNCTION sync_full_name();
ALTER TABLE users DROP COLUMN name;
```

### Adicionar NOT NULL a coluna existente

```sql
-- Migration 1
ALTER TABLE x ADD CONSTRAINT x_y_not_null CHECK (y IS NOT NULL) NOT VALID;
-- Backfill em batches:
UPDATE x SET y = 'default' WHERE y IS NULL;
-- Validar:
ALTER TABLE x VALIDATE CONSTRAINT x_y_not_null;
-- (CHECK NOT NULL é equivalente para policies, mas para esquemar formalmente:)
ALTER TABLE x ALTER COLUMN y SET NOT NULL;
ALTER TABLE x DROP CONSTRAINT x_y_not_null;
```

## Backfill em batches

Tabela com milhões de linhas. UPDATE direto = lock prolongado.

```sql
-- Função de backfill em batch
CREATE OR REPLACE FUNCTION public.backfill_chunk(batch_size int DEFAULT 5000)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE updated_count int;
BEGIN
  WITH batch AS (
    SELECT id FROM public.orders
    WHERE tier IS NULL
    ORDER BY id LIMIT batch_size
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.orders o
  SET tier = 'free'
  FROM batch
  WHERE o.id = batch.id;
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;

-- Correr até esgotar:
DO $$
DECLARE n int;
BEGIN
  LOOP
    SELECT public.backfill_chunk(5000) INTO n;
    EXIT WHEN n = 0;
    PERFORM pg_sleep(0.5);  -- alivia carga
  END LOOP;
END;
$$;
```

## Detectar drift

Quando o schema é alterado fora das migrações (Studio, hotfix manual):

```bash
# Comparar local vs remoto
supabase db diff --use-migra

# Gerar migração para sincronizar
supabase db diff --use-migra -f sync_drift_$(date +%Y%m%d)
```

Antes de aplicar: **revê** linha por linha. O diff captura tudo, incluindo alterações indesejadas.

## Anti-patterns de migração

### A1. `CREATE INDEX` sem `CONCURRENTLY` em tabela grande
```sql
-- ERRADO: lock de escrita
CREATE INDEX idx_orders_user ON orders(user_id);

-- CERTO
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_user ON orders(user_id);
-- Nota: CONCURRENTLY não pode estar dentro de BEGIN/COMMIT.
-- No CLI Supabase, retirar BEGIN/COMMIT do ficheiro de migração específico.
```

### A2. Adicionar `NOT NULL` sem default
```sql
-- ERRADO: falha imediata se houver dados
ALTER TABLE users ADD COLUMN tier text NOT NULL;

-- CERTO (Postgres ≥11)
ALTER TABLE users ADD COLUMN tier text NOT NULL DEFAULT 'free';
```

### A3. Mudar tipo incompatível direto
```sql
-- ERRADO
ALTER TABLE orders ALTER COLUMN status TYPE int USING status::int;

-- CERTO: usar coluna shadow
ALTER TABLE orders ADD COLUMN status_int int;
UPDATE orders SET status_int = ...;  -- em batches
-- (deploy app a ler new col)
-- futuro: drop old + rename
```

### A4. Migração que mistura DDL + DML em massa
```sql
-- ERRADO numa só migração:
BEGIN;
ALTER TABLE x ADD COLUMN y text;
UPDATE x SET y = derive_from(x);  -- pode demorar horas
COMMIT;
```
Migrações longas seguram locks. Separar DDL (rápido) de DML (em batches assíncronos).

### A5. Migração sem teste local
Toda migração deve correr em `supabase db reset` local antes de `supabase db push`.

### A6. Disable RLS "temporariamente"
```sql
ALTER TABLE x DISABLE ROW LEVEL SECURITY;
-- (faz seed/backfill)
ALTER TABLE x ENABLE ROW LEVEL SECURITY;
```
Esquecer-se de reativar = exposição total. Em alternativa, fazer backfill via service_role conectado a Postgres direto, sem mudar RLS.

## Checklist de revisão de migração

Antes de aprovar uma migração:

- [ ] Comentário inicial: nome, autor, risk level, rollback?
- [ ] Está dentro de transação? (Salvo `CONCURRENTLY`.)
- [ ] Não há `DROP` sem aprovação explícita?
- [ ] Não há `UPDATE`/`DELETE` sem `WHERE`?
- [ ] Indexes em FKs criadas?
- [ ] RLS ativada para tabelas novas com dados de utilizador?
- [ ] Policies cobrem SELECT/INSERT/UPDATE/DELETE conforme casos de uso?
- [ ] `NOT NULL` adicionados têm `DEFAULT` ou backfill em fase prévia?
- [ ] `CREATE INDEX` em tabela grande usa `CONCURRENTLY`?
- [ ] Renames seguem expand/contract em 2 deploys?
- [ ] Rollback documentado (mesmo se for "restore from backup")?
- [ ] Foi testada em `supabase db reset` local?

## Geração de rollback

Para cada migração, gera um `.down.sql` ao lado. Não corre automaticamente — é referência para emergência.

Exemplo para a migração de cima:
```sql
-- Rollback for 20260103154500_add_documents_table.sql
BEGIN;
DROP TABLE IF EXISTS public.documents CASCADE;
-- (CASCADE remove policies, triggers, FKs dependentes)
COMMIT;
```

Para operações irreversíveis (drop column, delete em massa):
```sql
-- Rollback for 20260104120000_drop_legacy_field.sql
-- NOT REVERSIBLE. Restore from backup taken at 2026-01-04 11:55 UTC.
```

## Comandos úteis

```bash
# Ver migrações pendentes
supabase migration list

# Squash local antes de partilhar
supabase migration squash --version <timestamp>

# Inspecionar estado da DB remota
supabase db dump --schema public > current_schema.sql

# Forçar uma migração já aplicada a re-correr (cuidado)
supabase migration repair --status reverted <timestamp>
supabase db push
```
