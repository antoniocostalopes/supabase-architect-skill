# CI/CD & Testing para Supabase

Como integrar Supabase no pipeline: testar migrations, validar RLS, prevenir drift e bloquear regressões antes de chegarem a produção.

## Princípio: a base é código

Schema + RLS + policies vivem em `supabase/migrations/`. CI corre como qualquer outro código:
1. Aplicar migrations num Postgres limpo
2. Correr testes (pgTAP / SQL assertions)
3. Verificar diff vs branch principal
4. Bloquear merge se falhar

## Estrutura de testes recomendada

```
supabase/
├── migrations/
│   └── *.sql
├── seed.sql
└── tests/
    ├── helpers.sql          -- factories, fixtures
    ├── rls/
    │   ├── 001_documents_rls_test.sql
    │   └── 002_memberships_rls_test.sql
    ├── functions/
    │   ├── 001_is_member_test.sql
    │   └── 002_has_role_test.sql
    └── integration/
        └── 001_onboarding_flow_test.sql
```

## pgTAP — basics

Extensão de testing nativa para Postgres. Pre-instalada no Supabase local.

### Activação
```sql
CREATE EXTENSION IF NOT EXISTS pgtap;
```

### Anatomia de um teste
```sql
BEGIN;
SELECT plan(N);  -- N = número de assertions

-- ... assertions ...

SELECT * FROM finish();
ROLLBACK;
```

### Assertions principais
```sql
SELECT ok(<bool>, '<descrição>');
SELECT is(<actual>, <expected>, '<descrição>');
SELECT isnt(<actual>, <expected>, '<descrição>');
SELECT throws_ok($$ <SQL> $$, '<sqlstate>', '<message>', '<descrição>');
SELECT lives_ok($$ <SQL> $$, '<descrição>');
SELECT has_table('public', 'documents', 'tabela existe');
SELECT has_column('public', 'documents', 'organization_id', 'tem coluna');
SELECT col_not_null('public', 'documents', 'organization_id', 'coluna NOT NULL');
SELECT policies_are('public', 'documents', ARRAY['documents_select', 'documents_insert', ...]);
```

## Helpers para testes de RLS

O grande truque: simular `auth.uid()` dentro do teste.

```sql
-- supabase/tests/helpers.sql

-- Helper para fazer "login" como user
CREATE OR REPLACE FUNCTION tests.authenticate_as(user_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object(
      'sub', user_id::text,
      'role', 'authenticated',
      'email', user_id::text || '@test.local'
    )::text,
    true
  );
  PERFORM set_config('role', 'authenticated', true);
END;
$$;

CREATE OR REPLACE FUNCTION tests.clear_authentication()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', null, true);
  PERFORM set_config('role', 'service_role', true);
END;
$$;

-- Factory para criar user + profile + org + membership
CREATE OR REPLACE FUNCTION tests.create_user_with_org(
  user_email text DEFAULT 'test@example.com',
  org_name text DEFAULT 'Test Org',
  role public.member_role DEFAULT 'owner'
) RETURNS TABLE (user_id uuid, org_id uuid)
LANGUAGE plpgsql AS $$
DECLARE
  new_user_id uuid := gen_random_uuid();
  new_org_id  uuid := gen_random_uuid();
BEGIN
  INSERT INTO auth.users (id, email) VALUES (new_user_id, user_email);
  INSERT INTO public.profiles (id) VALUES (new_user_id) ON CONFLICT DO NOTHING;
  INSERT INTO public.organizations (id, name, slug) VALUES (new_org_id, org_name, 'org-' || substring(new_org_id::text, 1, 8));
  INSERT INTO public.memberships (organization_id, user_id, role) VALUES (new_org_id, new_user_id, role);
  user_id := new_user_id; org_id := new_org_id;
  RETURN NEXT;
END;
$$;
```

(Schema `tests` para isolar helpers — `CREATE SCHEMA tests;` no início.)

## Exemplo: RLS test

```sql
-- supabase/tests/rls/001_documents_rls_test.sql
BEGIN;
SELECT plan(6);
\i supabase/tests/helpers.sql

-- Setup: dois users em duas orgs
SELECT * INTO TEMP user_a_org_a FROM tests.create_user_with_org('a@test.local', 'Org A', 'admin');
SELECT * INTO TEMP user_b_org_b FROM tests.create_user_with_org('b@test.local', 'Org B', 'admin');

DO $$
DECLARE org_a uuid; user_a uuid; org_b uuid;
BEGIN
  SELECT user_id, org_id INTO user_a, org_a FROM user_a_org_a;
  SELECT org_id INTO org_b FROM user_b_org_b;

  -- Como service_role, insere docs nas duas orgs
  PERFORM tests.clear_authentication();
  INSERT INTO public.documents (organization_id, created_by, title)
  VALUES
    (org_a, user_a, 'A''s doc'),
    (org_b, user_a, 'Foreign doc');
END $$;

-- T1: user A autenticado vê só docs da Org A
SELECT tests.authenticate_as((SELECT user_id FROM user_a_org_a));

SELECT is(
  (SELECT count(*)::int FROM public.documents),
  1,
  'user A only sees their own org docs'
);

SELECT is(
  (SELECT count(*)::int FROM public.documents WHERE organization_id = (SELECT org_id FROM user_a_org_a)),
  1,
  'user A sees Org A docs'
);

SELECT is(
  (SELECT count(*)::int FROM public.documents WHERE organization_id = (SELECT org_id FROM user_b_org_b)),
  0,
  'user A cannot see Org B docs (RLS isolates)'
);

-- T2: user A não pode inserir docs noutra org
SELECT throws_ok(
  format($$
    INSERT INTO public.documents (organization_id, created_by, title)
    VALUES ('%s', '%s', 'cross-tenant attempt')
  $$, (SELECT org_id FROM user_b_org_b), (SELECT user_id FROM user_a_org_a)),
  '42501',
  null,
  'user A blocked from inserting into Org B'
);

-- T3: user A pode inserir na sua org
SELECT lives_ok(
  format($$
    INSERT INTO public.documents (organization_id, created_by, title)
    VALUES ('%s', '%s', 'own doc')
  $$, (SELECT org_id FROM user_a_org_a), (SELECT user_id FROM user_a_org_a)),
  'user A can insert into Org A'
);

-- T4: user A não autenticado (anon) não vê nada
SELECT tests.clear_authentication();
PERFORM set_config('role', 'anon', true);
SELECT is(
  (SELECT count(*)::int FROM public.documents),
  0,
  'anonymous sees nothing'
);

SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
```

## Correr testes localmente

```bash
# Subir Postgres local + aplicar migrations
supabase start
supabase db reset

# Correr suite via psql
for test in supabase/tests/**/*.sql; do
  psql "postgresql://postgres:postgres@localhost:54322/postgres" -f "$test"
done

# Ou via pg_prove (mais bonito)
pg_prove --psql-bin psql -h localhost -p 54322 -U postgres -d postgres supabase/tests/**/*.sql
```

## supabase-test-helpers (alternativa)

Pacote oficial com helpers prontos. Instalar via SQL:
```sql
CREATE EXTENSION IF NOT EXISTS "basejump-supabase_test_helpers";
```

Usa funções `tests.create_supabase_user('alice')`, `tests.authenticate_as('alice')`, etc. Reduz boilerplate quando o setup é stock.

## Lint de migrations

### Squawk (recomendado)
[`squawk-cli`](https://github.com/sbdchd/squawk) detecta migrations perigosas (NOT NULL sem default, CREATE INDEX sem CONCURRENTLY, etc.).

```bash
npx --yes squawk@latest supabase/migrations/*.sql
```

Em CI:
```yaml
- name: Lint migrations
  run: npx --yes squawk@latest supabase/migrations/*.sql --reporter=github
```

### Regras Squawk relevantes
- `prefer-text-field` (varchar(N))
- `adding-not-nullable-field` (ADD COLUMN NOT NULL sem default)
- `adding-required-field`
- `disallowed-unique-constraint` (ADD CONSTRAINT UNIQUE — usar CONCURRENTLY)
- `require-concurrent-index-creation`
- `renaming-column`
- `changing-column-type`
- `transaction-nesting`

## GitHub Actions — workflow completo

```yaml
# .github/workflows/supabase.yml
name: Supabase CI

on:
  pull_request:
    paths:
      - 'supabase/**'
      - '.github/workflows/supabase.yml'

jobs:
  validate:
    name: Validate migrations + RLS tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: supabase/setup-cli@v1
        with:
          version: latest

      - name: Squawk lint
        run: npx --yes squawk@latest supabase/migrations/*.sql --reporter=github

      - name: Start Supabase
        run: supabase start

      - name: Apply migrations
        run: supabase db reset

      - name: Run pgTAP tests
        run: |
          sudo apt-get install -y postgresql-client libtap-parser-sourcehandler-pgtap-perl
          for test in supabase/tests/**/*.sql; do
            echo "::group::$test"
            psql "postgresql://postgres:postgres@localhost:54322/postgres" -v ON_ERROR_STOP=1 -f "$test"
            echo "::endgroup::"
          done

      - name: Verify generated types match
        run: |
          supabase gen types typescript --local > /tmp/database.types.ts
          diff types/database.types.ts /tmp/database.types.ts || {
            echo "::error::Types out of sync. Run: supabase gen types typescript --local > types/database.types.ts"
            exit 1
          }

      - name: Stop Supabase
        if: always()
        run: supabase stop

  diff-vs-remote:
    name: Diff vs production schema
    runs-on: ubuntu-latest
    if: github.event.pull_request.base.ref == 'main'
    steps:
      - uses: actions/checkout@v4
      - uses: supabase/setup-cli@v1

      - name: Login + link
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
        run: |
          supabase link --project-ref "${{ secrets.SUPABASE_PROJECT_REF }}" --password "${{ secrets.SUPABASE_DB_PASSWORD }}"

      - name: Generate diff
        run: |
          supabase db diff --linked > /tmp/diff.sql
          if [ -s /tmp/diff.sql ]; then
            echo "::warning::Schema drift between branch and production:"
            cat /tmp/diff.sql
            # decidir se falhar consoante política
          fi
```

## Deploy automatizado (production)

```yaml
# .github/workflows/supabase-deploy.yml
name: Supabase Deploy

on:
  push:
    branches: [main]
    paths: ['supabase/**']

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production  # exige approval manual conforme branch protection
    steps:
      - uses: actions/checkout@v4
      - uses: supabase/setup-cli@v1

      - name: Push migrations
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
          SUPABASE_DB_PASSWORD: ${{ secrets.SUPABASE_DB_PASSWORD }}
        run: |
          supabase link --project-ref "${{ secrets.SUPABASE_PROJECT_REF }}"
          supabase db push

      - name: Deploy Edge Functions
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
        run: supabase functions deploy --project-ref "${{ secrets.SUPABASE_PROJECT_REF }}"

      - name: Smoke test
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_ANON_KEY: ${{ secrets.SUPABASE_ANON_KEY }}
        run: |
          # Verifica que a API responde
          curl -fsS -H "apikey: $SUPABASE_ANON_KEY" "$SUPABASE_URL/rest/v1/" > /dev/null
```

### Secrets necessários em GitHub
| Secret | Como obter |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | Dashboard → Account → Access Tokens |
| `SUPABASE_PROJECT_REF` | URL do projeto: `<ref>.supabase.co` |
| `SUPABASE_DB_PASSWORD` | Dashboard → Database → Connection (postgres user) |
| `SUPABASE_URL` | Pública — pode ser variável em vez de secret |
| `SUPABASE_ANON_KEY` | Pública — pode ser variável |

**Nunca** colocar `SUPABASE_SERVICE_ROLE_KEY` no workflow YAML — usar apenas para steps que exigem (raros).

## Smoke tests pós-deploy

Após `supabase db push`, validar:
```sql
-- 1. Migrações esperadas estão aplicadas
SELECT version FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 5;

-- 2. RLS coverage não regrediu
SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND rowsecurity = false;
-- Esperado: <baseline>

-- 3. Policies esperadas existem
SELECT count(*) FROM pg_policies WHERE schemaname = 'public';
-- Esperado: ≥ <baseline>

-- 4. Functions críticas existem
SELECT count(*) FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN ('is_member', 'has_role', 'set_updated_at');
-- Esperado: 3
```

Idealmente embebidos num teste pgTAP `tests/smoke/post_deploy.sql` correto no fim do deploy.

## Branch protection (GitHub)

`Settings → Branches → main`:
- [ ] Require pull request before merging
- [ ] Require status checks: `Validate migrations + RLS tests`, `Lint migrations`
- [ ] Require branches to be up to date
- [ ] Require linear history (recomendado)
- [ ] Restrict who can push to matching branches

## Pre-commit hooks (opcional)

```bash
# .husky/pre-commit ou .git/hooks/pre-commit
#!/bin/sh
files=$(git diff --cached --name-only --diff-filter=ACM | grep '^supabase/migrations/.*\.sql$')
if [ -n "$files" ]; then
  npx --yes squawk@latest $files || exit 1
fi
```

## Anti-patterns CI/CD

### A1. Testes que usam `service_role`
Bypassam RLS — não testam o que importa. Sempre `authenticate_as`.

### A2. Apenas testar happy path
RLS tests precisam de **cross-tenant attempt** (T2 acima) e **anonymous attempt** (T4). Sem esses, regressões passam.

### A3. `supabase db push` direto sem diff review
CI deve correr `supabase db diff --linked` em PR e mostrar o diff como comentário. Merge sem review = drift.

### A4. Sem snapshot de tipos
`database.types.ts` desactualizado faz a app falhar silenciosamente (campos null aceites pelo TS porque o tipo já não os tem). CI deve falhar se diferir.

### A5. Smoke test só verifica HTTP 200
Confirmar que migrations específicas foram aplicadas via `supabase_migrations.schema_migrations`.

### A6. Service role key em CI YAML
Mesmo em secrets, usar service_role no CI permite que qualquer pessoa com permissões de admin do repo cause estragos. Limitar a steps que **mesmo** precisam.

## Checklist CI/CD

- [ ] Migrations versionadas em `supabase/migrations/`
- [ ] `supabase/tests/` com pelo menos:
  - 1 teste por tabela com RLS multi-tenant
  - 1 teste por helper function (`is_member`, `has_role`)
  - 1 teste integration por user flow crítico
- [ ] Squawk lint corre em PR
- [ ] pgTAP suite corre em PR
- [ ] Diff vs production em PR para main
- [ ] Generated types in-sync com schema (verificado em PR)
- [ ] Deploy só do `main` após approval
- [ ] Smoke tests pós-deploy
- [ ] Branch protection ativa em `main`
- [ ] Secrets em GitHub Secrets (nunca commited)
