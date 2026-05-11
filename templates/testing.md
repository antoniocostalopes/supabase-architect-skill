# Template — SUPABASE_TESTING.md

Estrutura fixa para output de setup/auditoria de CI/CD + testing.

---

```markdown
# SUPABASE_TESTING — <project_name>

> Setup / auditoria de CI/CD + testing gerada por **Supabase Architect** em <YYYY-MM-DD>.
> Escopo: <novo setup | audit | adicionar pgTAP | adicionar GitHub Actions>.

## Sumário

- **pgTAP**: <activado | em falta>
- **Testes existentes**: <n> RLS · <n> functions · <n> integration
- **CI workflow**: <existe | em falta>
- **Squawk lint**: <activado | em falta>
- **Diff vs production em PR**: <sim | não>
- **Smoke tests pós-deploy**: <sim | não>

## 1. Inventário atual

### Estrutura de testes
```
supabase/
├── tests/
│   ├── helpers.sql              <existe | em falta>
│   ├── rls/                     <n ficheiros>
│   ├── functions/               <n ficheiros>
│   └── integration/             <n ficheiros>
```

### CI workflows
| Workflow | Ficheiro | Estado |
|---|---|---|
| Validate (PR) | `.github/workflows/supabase.yml` | <existe | em falta> |
| Deploy (main) | `.github/workflows/supabase-deploy.yml` | <existe | em falta> |
| Diff vs prod | <existe | em falta> | |

## 2. Achados

### [CRÍTICO] Sem testes de RLS
- **Problema**: Policies multi-tenant podem regredir sem deteção.
- **Fix**: criar `supabase/tests/rls/<tabela>_test.sql` para cada tabela de tenant. Ver template abaixo.

### [ALTO] CI não corre lint de migrations
- **Fix**: adicionar Squawk ao workflow.

### [MÉDIO] Generated types out-of-sync em main
- **Fix**: CI falha se `supabase gen types typescript --local` diferir de `types/database.types.ts` commitado.

## 3. Setup pgTAP

### Activar extensão
```sql
CREATE EXTENSION IF NOT EXISTS pgtap;
CREATE SCHEMA IF NOT EXISTS tests;
```

### Helpers (criar uma vez)
```sql
-- supabase/tests/helpers.sql
-- Ver references/13-ci-cd-testing.md — secção "Helpers para testes de RLS"
-- Inclui: tests.authenticate_as, tests.clear_authentication, tests.create_user_with_org
```

## 4. Testes RLS recomendados

Para cada tabela com `organization_id`:

```sql
-- supabase/tests/rls/00X_<tabela>_test.sql
BEGIN;
SELECT plan(6);
\i supabase/tests/helpers.sql

-- Setup: dois users em duas orgs
SELECT * INTO TEMP user_a_org_a FROM tests.create_user_with_org('a@test.local', 'Org A', 'admin');
SELECT * INTO TEMP user_b_org_b FROM tests.create_user_with_org('b@test.local', 'Org B', 'admin');

-- T1: user A vê só docs da Org A
-- T2: user A bloqueado de ler docs Org B
-- T3: user A bloqueado de inserir em Org B (cross-tenant)
-- T4: user A pode inserir na própria org
-- T5: anonymous não vê nada
-- T6: user A não pode mudar organization_id

SELECT * FROM finish();
ROLLBACK;
```

Casos obrigatórios: cross-tenant attempt (T2/T3), anonymous attempt (T5), tenant immutability (T6).

## 5. Squawk lint

### Regras a activar
```yaml
# squawk.toml
excluded_rules = []
# Manter ativas: prefer-text-field, adding-not-nullable-field, require-concurrent-index-creation,
# changing-column-type, transaction-nesting, disallowed-unique-constraint
```

### Em CI
```yaml
- name: Lint migrations
  run: npx --yes squawk@latest supabase/migrations/*.sql --reporter=github
```

## 6. GitHub Actions — workflows propostos

### PR validation
```yaml
# .github/workflows/supabase.yml
# Conteúdo completo em references/13-ci-cd-testing.md — secção "GitHub Actions — workflow completo"
```

Steps:
1. Squawk lint
2. `supabase start` + `supabase db reset`
3. Correr pgTAP suite
4. Verificar generated types in-sync
5. Diff vs production (warning ou error)

### Deploy
```yaml
# .github/workflows/supabase-deploy.yml
# Só corre em push para main, com environment approval
```

Steps:
1. `supabase link --project-ref $PROD_REF`
2. `supabase db push`
3. `supabase functions deploy`
4. Smoke test (HTTP 200 + verificação de migrations aplicadas)

## 7. Smoke tests pós-deploy

```sql
-- supabase/tests/smoke/post_deploy.sql
BEGIN;
SELECT plan(4);

-- 1. Migrações esperadas estão aplicadas
SELECT ok(
  (SELECT count(*) FROM supabase_migrations.schema_migrations) >= <baseline_count>,
  'baseline migrations applied'
);

-- 2. RLS coverage não regrediu
SELECT is(
  (SELECT count(*)::int FROM pg_tables WHERE schemaname = 'public' AND rowsecurity = false),
  0,
  'no tables without RLS'
);

-- 3. Helpers críticos existem
SELECT has_function('public', 'is_member', ARRAY['uuid']);
SELECT has_function('public', 'has_role', ARRAY['uuid', 'public.member_role']);

SELECT * FROM finish();
ROLLBACK;
```

## 8. Branch protection

`Settings → Branches → main`:
- [x] Require pull request before merging
- [x] Require status checks: `Validate`, `Lint`
- [x] Require branches to be up to date
- [x] Restrict who can push

## 9. Plano de aplicação

### Semana 1
- [ ] `CREATE EXTENSION pgtap`
- [ ] `supabase/tests/helpers.sql`
- [ ] 1 teste pgTAP por tabela com RLS multi-tenant

### Semana 2
- [ ] Workflow `supabase.yml` (PR validation)
- [ ] Squawk integration
- [ ] Generated types check

### Semana 3
- [ ] Workflow `supabase-deploy.yml`
- [ ] Smoke tests post-deploy
- [ ] Branch protection ativa

## 10. Checklist

(do `references/13-ci-cd-testing.md` — secção "Checklist CI/CD")

- [ ] Migrations versionadas em `supabase/migrations/`
- [ ] `supabase/tests/` com pelo menos 1 teste por tabela RLS multi-tenant
- [ ] Squawk lint corre em PR
- [ ] pgTAP suite corre em PR
- [ ] Diff vs production em PR para main
- [ ] Generated types in-sync verificado em CI
- [ ] Deploy só do `main` após approval
- [ ] Smoke tests pós-deploy
- [ ] Branch protection ativa em `main`
- [ ] Secrets em GitHub Secrets

## Apêndice — Secrets necessários

| Secret | Como obter |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | Dashboard → Account → Access Tokens |
| `SUPABASE_PROJECT_REF` | URL do projeto: `<ref>.supabase.co` |
| `SUPABASE_DB_PASSWORD` | Dashboard → Database → Connection |

`SUPABASE_SERVICE_ROLE_KEY` **não** deve estar no workflow YAML salvo necessidade absoluta.
```
