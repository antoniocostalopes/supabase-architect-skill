# Example — SUPABASE_MIGRATIONS.md (rename column, expand/contract)

Exemplo do output de `/supabase-migrations` para uma operação **breaking** (rename de coluna) que tem de ser feita em **3 fases** para evitar downtime.

Contexto: tabela `users` tem coluna `name`. Equipa quer renomear para `full_name` para clareza. Tabela tem 5M rows; aplicação tem 4 services a consumir.

---

```markdown
# SUPABASE_MIGRATIONS — rename users.name to full_name

> Review/geração por **Supabase Architect** em 2026-05-11.

## Metadata

- **Operação**: rename de coluna em tabela de 5M rows
- **Risk level**: **Amarelo** (breaking change, exige expand/contract)
- **Tipo**: rename (expand/contract em 3 deploys)
- **Rollback**: documentado por fase
- **Estimativa**: 5-7 dias entre Fase 1 e Fase 3 (tempo para apps consumirem o novo campo)

## Resumo

Renomear `users.name` para `users.full_name`. Tabela tem 5M rows; tem 4 services a consumir o campo (web, mobile, billing-worker, search-indexer). Cada um precisa de deploy antes da fase final.

## Por que NÃO `ALTER TABLE ... RENAME COLUMN`

```sql
-- ABORDAGEM ERRADA
ALTER TABLE public.users RENAME COLUMN name TO full_name;
```

Problemas:
- App antiga ainda escreve em `name` → falha imediata após `rename`
- App nova precisa esperar deploy de todos os consumers
- Sem janela para rollback gradual

**Solução**: expand/contract em 3 fases.

## Fase 1 — Expand (additive, safe)

### Migração 1A — `20260511_120000_add_users_full_name.sql`

```sql
-- Migration: 20260511_120000_add_users_full_name.sql
-- Risk: GREEN (additive)
-- Description: Add nullable full_name column + sync trigger.

BEGIN;

-- 1. Adicionar coluna nullable
ALTER TABLE public.users ADD COLUMN full_name text;

-- 2. Trigger para manter as duas colunas sincronizadas
--    (writes a `name` ou `full_name` populam ambas)
CREATE OR REPLACE FUNCTION public.sync_users_name_full_name()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.full_name IS NULL AND NEW.name IS NOT NULL THEN
    NEW.full_name := NEW.name;
  ELSIF NEW.name IS NULL AND NEW.full_name IS NOT NULL THEN
    NEW.name := NEW.full_name;
  ELSIF NEW.full_name IS DISTINCT FROM NEW.name THEN
    -- Se ambos preenchidos mas diferentes, prefere full_name (write recente)
    NEW.name := NEW.full_name;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_users_sync_name
BEFORE INSERT OR UPDATE OF name, full_name ON public.users
FOR EACH ROW EXECUTE FUNCTION public.sync_users_name_full_name();

COMMIT;
```

**Rollback**:
```sql
-- 20260511_120000_add_users_full_name.down.sql
BEGIN;
DROP TRIGGER IF EXISTS trg_users_sync_name ON public.users;
DROP FUNCTION IF EXISTS public.sync_users_name_full_name();
ALTER TABLE public.users DROP COLUMN IF EXISTS full_name;
COMMIT;
```

### Migração 1B — Backfill em batches (script à parte, não como migration)

```sql
-- Correr via SQL Editor ou job, em batches para não segurar lock prolongado
DO $$
DECLARE n int;
BEGIN
  LOOP
    WITH batch AS (
      SELECT id FROM public.users
      WHERE full_name IS NULL AND name IS NOT NULL
      ORDER BY id LIMIT 5000 FOR UPDATE SKIP LOCKED
    )
    UPDATE public.users u
    SET full_name = u.name
    FROM batch
    WHERE u.id = batch.id;
    GET DIAGNOSTICS n = ROW_COUNT;
    EXIT WHEN n = 0;
    PERFORM pg_sleep(0.5);  -- alivia carga
  END LOOP;
END $$;

-- Verificar: deve resultar 0
SELECT count(*) FROM public.users WHERE full_name IS NULL AND name IS NOT NULL;
```

**Verificação pós-Fase 1**:
```sql
-- Coluna nova existe
SELECT column_name FROM information_schema.columns
WHERE table_name = 'users' AND column_name = 'full_name';

-- Trigger ativo
SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.users'::regclass;

-- Backfill completo
SELECT
  count(*) AS total,
  count(*) FILTER (WHERE full_name IS NOT NULL) AS with_full_name,
  count(*) FILTER (WHERE full_name IS DISTINCT FROM name) AS divergent
FROM public.users;
-- Esperado: total = with_full_name; divergent = 0
```

### Deploy aplicacional após Fase 1

Cada um dos 4 services faz deploy a:
- **Ler** ainda `name` (compatibilidade)
- **Escrever** em `full_name` (a nova coluna)

A trigger garante que `name` continua a ter o valor por enquanto.

---

## Fase 2 — Aplicações totalmente migradas (verification window)

**Duração mínima**: 5-7 dias após Fase 1 estar em todos os ambientes.

Durante este tempo, verificar:
- Logs não mostram referências a `users.name` em queries da app
- Métricas de erro estáveis
- Search-indexer está a usar `full_name`
- Billing-worker validado

### Verificação activa

```sql
-- Capturar queries que ainda usam users.name (Supabase Logs ou pg_stat_statements)
SELECT query, calls FROM pg_stat_statements
WHERE query ILIKE '%users.name%' OR query ILIKE '%FROM users%name%'
ORDER BY calls DESC LIMIT 20;
```

Se aparecer query antiga, identificar app e fixar.

---

## Fase 3 — Contract (destructive)

Apenas correr **depois** de garantir que nenhuma app escreve/lê `users.name`.

### Migração 3 — `20260518_140000_drop_users_name.sql`

```sql
-- Migration: 20260518_140000_drop_users_name.sql
-- Risk: RED (destructive — drop column)
-- Description: Drop legacy users.name column. Requires Fase 1+2 complete.
-- Pre-condition: no app reads/writes users.name (verified for 7 days)
-- Rollback: NOT REVERSIBLE — restore from backup taken pre-migration

BEGIN;

-- 1. Remover trigger primeiro (não precisa mais sync)
DROP TRIGGER IF EXISTS trg_users_sync_name ON public.users;
DROP FUNCTION IF EXISTS public.sync_users_name_full_name();

-- 2. Drop coluna legacy
ALTER TABLE public.users DROP COLUMN name;

-- 3. Tornar full_name NOT NULL (agora que é o único)
ALTER TABLE public.users ALTER COLUMN full_name SET NOT NULL;

COMMIT;
```

**Rollback** — NÃO reversível:
```sql
-- NOT REVERSIBLE.
-- Restore via Supabase PITR para timestamp imediatamente antes da migration.
-- Comando approximate (UI do Supabase):
--   Dashboard → Database → Backups → Restore at point in time → <ts antes da migration>
```

### Pré-condições antes de correr Fase 3

- [ ] Fase 1 aplicada há ≥7 dias em produção
- [ ] Nenhuma referência a `users.name` em pg_stat_statements nos últimos 7 dias
- [ ] Code review de todos os repos confirma ausência de `name` (grep)
- [ ] Backup PITR confirmado ≤1 hora antes
- [ ] Janela de baixo tráfego (3-5am UTC)
- [ ] Equipa em standby para 30 min

### Verificação pós-Fase 3

```sql
-- Coluna name removida
SELECT column_name FROM information_schema.columns
WHERE table_name = 'users' AND table_schema = 'public';
-- Esperado: full_name presente, name ausente

-- full_name NOT NULL
SELECT column_name, is_nullable FROM information_schema.columns
WHERE table_name = 'users' AND column_name = 'full_name';
-- Esperado: is_nullable = 'NO'

-- Trigger removido
SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.users'::regclass;
-- Esperado: trg_users_sync_name não na lista
```

---

## Plano de deploy completo

### Cronograma sugerido

| Dia | Acção | Responsável |
|---|---|---|
| D-7 | Code review da migration | Tech lead |
| D-3 | Deploy Fase 1 em staging | DevOps |
| D-2 | Smoke test staging + métricas | QA |
| **D-0** | Deploy Fase 1 em produção (durante janela 3-5am UTC) | DevOps |
| D-0 | Backfill em produção (batches, ~1h para 5M rows) | DevOps |
| D-0 a D-5 | Deploy app updates: usar `full_name` em writes; ler ambos | Dev teams |
| D-5 | Verificar pg_stat_statements: zero queries usam `name` | DevOps |
| D-7 | Code grep final: zero referências a `users.name` | Tech lead |
| **D-7** | Deploy Fase 3 em produção (durante janela 3-5am UTC) | DevOps |
| D-8 | Validação pós-Fase 3 | DevOps + QA |

### Comunicação

- Anunciar Fase 1 em #engineering 1 dia antes
- Anunciar Fase 3 em #engineering 24h e 1h antes
- Bloquear janela em calendar (compartilhado)

## Anti-patterns evitados

| Anti-pattern | Como esta migration evita |
|---|---|
| Drop column sem deprecação prévia (V10) | Fase 2 dá 7 dias de window |
| Backfill como parte da DDL migration | Backfill é separado, em batches com SKIP LOCKED |
| Rename direto que parte writes | Trigger mantém ambas as colunas sincronizadas |
| NOT NULL adicionado antes de backfill (V09) | NOT NULL só na Fase 3, após dados completos |

## Heurísticas aplicáveis

- **H23** — `ALTER ... NOT NULL` sem `DEFAULT` evitado: full_name começa nullable
- **H24** — `DROP COLUMN` direto evitado: 3 fases com window
- **H25** — `UPDATE` em massa evitado: backfill em batches
- **H26** — Drift evitado: tudo versionado em migrations

## Notas

- Esta abordagem é **template** para qualquer rename de coluna em tabela média/grande.
- Para tabelas <50k rows, pode-se considerar abordagem mais simples (1 migration com `ALTER ... RENAME` em janela de manutenção), mas só se a downtime de 2-5 segundos for aceitável.
- Para mudar **tipo** em vez de nome, mesmo pattern (expand: add column novo tipo; sync trigger; contract: drop antiga).
```

---

## Notas — uso deste example

- Mostra **caso clássico** de migration complexa: rename em tabela grande com múltiplos consumers
- 3 fases com timeline temporal **explicita**
- Verificação SQL **antes e depois** de cada fase
- Pre-conditions checklist para Fase 3 (a única destrutiva)
- Anti-patterns referenciados (V09, V10) — rastreabilidade
- Heurísticas H23–H26 evitadas, explicitamente
- Cronograma com responsáveis e janelas
