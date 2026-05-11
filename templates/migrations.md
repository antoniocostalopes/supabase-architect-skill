# Template — SUPABASE_MIGRATIONS.md

Estrutura fixa para review/geração de migração.

---

```markdown
# SUPABASE_MIGRATIONS — <name_of_migration>

> Review/geração por **Supabase Architect** em <YYYY-MM-DD>.

## Metadata

- **Ficheiro**: `supabase/migrations/<timestamp>_<name>.sql`
- **Autor**: <quem>
- **Risk level**: <verde | amarelo | vermelho>
- **Tipo**: <additive | rename | drop | data backfill | mixed>
- **Rollback**: <documentado | parcial | não-recuperável>

## Resumo

<2-3 linhas: o que esta migração faz e porquê>

## Análise de segurança

### Operações destrutivas
- [ ] Nenhuma
- [ ] `DROP TABLE` — confirmado com owner
- [ ] `DROP COLUMN` — confirmado com owner
- [ ] `UPDATE`/`DELETE` em massa — com WHERE explícito
- [ ] `ALTER TYPE` incompatível — usa expand/contract

### Operações que bloqueiam
- [ ] `CREATE INDEX` sem `CONCURRENTLY` em tabela grande → usar CONCURRENTLY
- [ ] `ALTER ... NOT NULL` sem DEFAULT → adicionar DEFAULT ou backfill prévio
- [ ] `ALTER ... TYPE` que reescreve tabela → split em fases

### RLS
- [ ] Novas tabelas têm `ENABLE ROW LEVEL SECURITY`?
- [ ] Policies criadas na mesma migração?
- [ ] Indexes a suportar policies criados?

## Migração proposta

```sql
-- Migration: <YYYYMMDDHHMMSS>_<name>.sql
-- Author: <author>
-- Description: <descrição>
-- Risk: <verde|amarelo|vermelho>
-- Rollback: <ficheiro .down.sql | "not reversible — restore from backup"

BEGIN;

-- 1. Schema changes
CREATE TABLE public.<entity> (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- ...
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2. Indexes
CREATE INDEX idx_<entity>_org_created
  ON public.<entity>(organization_id, created_at DESC);

-- 3. RLS
ALTER TABLE public.<entity> ENABLE ROW LEVEL SECURITY;

CREATE POLICY "<entity>_select" ON public.<entity>
FOR SELECT TO authenticated
USING (public.is_member(organization_id));

CREATE POLICY "<entity>_insert" ON public.<entity>
FOR INSERT TO authenticated
WITH CHECK (public.has_role(organization_id, 'member'));

CREATE POLICY "<entity>_update" ON public.<entity>
FOR UPDATE TO authenticated
USING (public.has_role(organization_id, 'admin'))
WITH CHECK (public.is_member(organization_id));

CREATE POLICY "<entity>_delete" ON public.<entity>
FOR DELETE TO authenticated
USING (public.has_role(organization_id, 'admin'));

-- 4. Triggers
CREATE TRIGGER trg_<entity>_updated_at
BEFORE UPDATE ON public.<entity>
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 5. Grants
GRANT SELECT, INSERT, UPDATE, DELETE ON public.<entity> TO authenticated;

COMMIT;
```

## Rollback

```sql
-- File: <timestamp>_<name>.down.sql
-- Use only if migration above caused issues.

BEGIN;
DROP TABLE IF EXISTS public.<entity> CASCADE;
COMMIT;
```

Ou, para operações não-reversíveis:
```sql
-- NOT REVERSIBLE.
-- Restore from PITR backup at <YYYY-MM-DD HH:MM> UTC.
```

## Verificação local

Antes de `supabase db push`:

```bash
# Aplicar localmente
supabase db reset

# Verificar diff vs remoto
supabase db diff

# Smoke test
psql "<local_db_url>" -c "SELECT count(*) FROM public.<entity>;"
psql "<local_db_url>" -c "\d public.<entity>"
```

## Plano de deploy

### Pré-condições
- [ ] Migrações anteriores aplicadas
- [ ] Branch de feature merged em main
- [ ] CI verde (lint, tests)
- [ ] Window de baixo tráfego (se risk = amarelo/vermelho)

### Execução
```bash
supabase db push
# ou via CI deploy
```

### Pós-condições (verificação)
```sql
-- 1. Tabela criada
SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename='<entity>';
-- 2. RLS ativa
SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='<entity>';
-- 3. Policies criadas
SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='<entity>';
-- 4. Indexes
SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='<entity>';
```

Esperado: todas retornam linhas conforme migração.

## Caso especial — backfill em batches

Se a migração inclui DML em massa, separar:

### Migration A (DDL)
```sql
ALTER TABLE public.users ADD COLUMN tier text;  -- nullable
```

### Migration B (backfill, em script à parte ou outra migração)
```sql
DO $$
DECLARE n int;
BEGIN
  LOOP
    WITH batch AS (
      SELECT id FROM public.users WHERE tier IS NULL
      ORDER BY id LIMIT 5000 FOR UPDATE SKIP LOCKED
    )
    UPDATE public.users u
    SET tier = 'free'
    FROM batch
    WHERE u.id = batch.id;
    GET DIAGNOSTICS n = ROW_COUNT;
    EXIT WHEN n = 0;
    PERFORM pg_sleep(0.5);
  END LOOP;
END $$;
```

### Migration C (enforce)
```sql
ALTER TABLE public.users
  ALTER COLUMN tier SET NOT NULL,
  ALTER COLUMN tier SET DEFAULT 'free';
```

## Notas para o reviewer

<observações específicas desta migração>
```
