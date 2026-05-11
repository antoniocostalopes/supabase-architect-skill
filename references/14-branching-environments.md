# Supabase Branching & Environments

Preview environments por pull request, ambientes staging/production e workflow de migrations com branches.

## O que é Supabase Branching

Mecanismo nativo (plano Pro+) que cria um **projeto Supabase efémero por PR/branch**, com:
- Postgres isolado (cópia do schema, sem dados de produção)
- Edge Functions, Storage, Auth próprios (vazios)
- URL e keys próprios
- Migrações aplicadas automaticamente do branch git

Custo: cobrado por compute hours do branch (paragem automática quando inativo).

## Setup

### 1. Activar no projeto
Dashboard → Branches → Enable branching. Aprovar custo.

### 2. Configurar repo
Connect GitHub repo no Dashboard. Supabase passa a observar PRs e a criar branches Postgres correspondentes.

### 3. `supabase/config.toml`
```toml
[experimental.branching]
enabled = true

[experimental.branching.git]
provider = "github"
repository = "org/repo"
production_branch = "main"
```

## Workflow recomendado por PR

```
git checkout -b feat/multi-tenant-billing
# 1. Desenvolvimento local
supabase migration new add_billing_tables
# editar a migração
supabase db reset                          # aplica localmente
# correr testes pgTAP localmente

git push origin feat/multi-tenant-billing
gh pr create
```

Ao abrir o PR:
1. Supabase deteta a branch
2. Cria projeto efémero `<project>-<branch-hash>`
3. Aplica todas as migrations do branch
4. Comenta no PR com URL + keys
5. CI corre testes contra o branch project (não local)

Ao fechar o PR (merge ou close):
- Branch project é eliminado (~24h depois)
- Se merge para `main`, as migrations são aplicadas em produção automaticamente

## Variantes: ambientes (sem branching nativo)

Para projetos em plano Free ou setups que preferem isolamento explícito:

### 3 projetos separados
```
acme-dev          → developers locais sincronizam com este
acme-staging      → smoke tests pré-prod, dados sintéticos
acme-production   → tráfego real
```

| Var | dev | staging | production |
|---|---|---|---|
| `SUPABASE_PROJECT_REF` | `dev_ref` | `staging_ref` | `prod_ref` |
| `SUPABASE_URL` | `https://dev_ref.supabase.co` | `https://staging_ref.supabase.co` | `https://prod_ref.supabase.co` |
| Auth providers | Google/email test | Google/email | OAuth corporativo + SSO |
| Storage size | min | small | conforme uso |
| Backups | desligado | semanal | diário + PITR |

### Promoção entre ambientes

```bash
# Aplicar a staging
supabase link --project-ref $STAGING_REF
supabase db push

# Smoke test (correr suite contra staging)
SUPABASE_URL=$STAGING_URL pnpm test:e2e

# Promover a produção
supabase link --project-ref $PROD_REF
supabase db push
```

## Seeding por ambiente

`supabase/seed.sql` é aplicado em `supabase db reset` local. Para staging com dados sintéticos:

```bash
# Seed apenas em staging
psql "$STAGING_DB_URL" -f supabase/seeds/staging-realistic.sql
```

Estrutura recomendada:
```
supabase/
├── seed.sql                       # dados mínimos para dev local (1 user, 1 org)
└── seeds/
    ├── staging-realistic.sql      # ~10k rows, dados sintéticos (Faker)
    ├── load-test.sql              # 1M+ rows para perf testing
    └── README.md
```

### Anti-pattern: seed com dados reais
Nunca importar dump de produção para staging sem **scrubbing de PII** (emails, nomes, dados financeiros).

```sql
-- Scrub via dump + script
pg_dump $PROD_URL --data-only --table=public.users | \
  sed -E "s/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/scrubbed@example.com/g" | \
  psql $STAGING_URL
```

(Solução robusta: usar [pg_anonymizer](https://gitlab.com/dalibo/postgresql_anonymizer).)

## Auth em branch / staging

Pontos de atenção quando se replica auth para um ambiente novo:

### Redirect URLs
Cada projeto Supabase tem a sua lista. Adicionar `https://<branch>.vercel.app` ao staging/branch:
```bash
supabase config set auth.url.allowlist "https://acme.com,https://staging.acme.com,https://*.vercel.app"
```

### OAuth providers
- Em **dev**: app OAuth de teste (Google "test mode", etc.)
- Em **staging**: app OAuth separada (não a de produção)
- Em **production**: app OAuth verificada

Misturar = potencial leak de tokens entre ambientes.

### JWT secret
Cada projeto tem o seu. Cookies de auth de prod **não funcionam** em staging — comportamento desejado.

## Storage por ambiente

Cada projeto Supabase tem o seu storage. Não partilhar buckets entre ambientes.

Para evitar acumulação em branches efémeros:
- `auto_cleanup` em buckets de branch
- Bucket size limits agressivos em dev/staging

## Edge Functions por ambiente

```bash
# Deploy só do branch link atual
supabase functions deploy --project-ref $BRANCH_REF

# Secrets por ambiente
supabase secrets set STRIPE_SECRET_KEY=sk_test_xxx  # em staging
supabase secrets set STRIPE_SECRET_KEY=sk_live_xxx  # em prod
```

**Nunca** copiar `service_role_key` ou secrets de prod para staging — chaves separadas por ambiente.

## Realtime e Database Webhooks

Não há "espelhamento" automático. Em cada ambiente:
- Tabelas em `pg_publication_tables` para `supabase_realtime`
- Webhook configurations em `supabase_functions.hooks`

Capturar via migrations:
```sql
-- supabase/migrations/20260201_enable_realtime.sql
ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
```

Assim `supabase db push` para qualquer ambiente liga o realtime nas tabelas certas.

## CI integrado com branching

```yaml
# .github/workflows/pr.yml (excerpt)
jobs:
  e2e-on-branch:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Get branch credentials
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
        run: |
          # Supabase API devolve o branch ref+keys para este PR
          branch_info=$(curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
            "https://api.supabase.com/v1/projects/${{ secrets.MAIN_PROJECT_REF }}/branches/${{ github.head_ref }}")
          echo "BRANCH_URL=$(echo $branch_info | jq -r .api_url)" >> $GITHUB_ENV
          echo "BRANCH_ANON_KEY=$(echo $branch_info | jq -r .anon_key)" >> $GITHUB_ENV

      - name: Run e2e tests against PR branch
        env:
          SUPABASE_URL: ${{ env.BRANCH_URL }}
          SUPABASE_ANON_KEY: ${{ env.BRANCH_ANON_KEY }}
        run: pnpm test:e2e
```

## Limitações conhecidas

| Limitação | Workaround |
|---|---|
| Branch não copia dados, só schema | Seed via `seed.sql` ou `seeds/staging-realistic.sql` |
| OAuth providers não são copiados | Definir em config.toml versionado |
| Storage objects não copiados | Não confiar em assets em PR previews |
| Custo de compute | Configurar pause-on-idle |
| Edge Functions têm cold start | OK para PR review; n/a para perf |
| Cron jobs (pg_cron) replicados? | Sim, via migrations |

## Patterns úteis

### P1. Schema-first reviews
Reviewer **lê o `db diff`** comentado pelo Supabase no PR, não só o código. Catches que código teria deixado passar:
- ALTER TABLE destrutivo
- Policies removidas
- Indexes drop

### P2. Migration ordering enforcement
CI rejeita PRs com migrations cujos timestamps são mais antigos que o último em main. Previne conflitos de ordering ao fazer merge.

```bash
last_main=$(git ls-tree origin/main -- supabase/migrations/ | awk '{print $4}' | sort -r | head -1)
my_oldest=$(git diff origin/main..HEAD --name-only -- supabase/migrations/ | sort | head -1)
if [[ "$(basename "$my_oldest")" < "$(basename "$last_main")" ]]; then
  echo "::error::Migration timestamp $my_oldest is older than latest in main ($last_main). Renumber."
  exit 1
fi
```

### P3. Production "dry-run"
Antes de merge para `main`, correr `supabase db diff --linked` contra produção em modo read-only. Compara migrations pendentes vs production schema.

### P4. Reset frequente em dev
Em desenvolvimento local, `supabase db reset` é barato. Use-o sempre que rebase, em vez de aplicar migrations pendentes uma a uma.

## Anti-patterns

### A1. Editar schema via Studio em produção
Bypassa branching. Gera drift. Sempre fazer alterações em PR (branch).

### A2. Push direto para projeto de produção
`supabase link --project-ref $PROD_REF && supabase db push` numa máquina dev = sem revisão. Limitar essa ação a CI deploy job com manual approval.

### A3. Mesmo OAuth app em dev/staging/prod
Cliente OAuth verificado em google → leak de tokens entre ambientes. Sempre apps separadas.

### A4. Seeding com dados de produção sem scrubbing
GDPR violation + risco de leak.

### A5. Branch sem cleanup
Branches Supabase abandonados acumulam custo. Configurar auto-delete ao fechar PR.

## Checklist branching / environments

- [ ] Production branch (`main`) protegida com required checks
- [ ] Pelo menos 2 ambientes (staging + prod) se não usar branching
- [ ] OAuth apps separadas por ambiente
- [ ] Secrets (Stripe, etc.) separados por ambiente
- [ ] `service_role` keys nunca atravessam ambientes
- [ ] Redirect URLs configuradas para o domínio de cada ambiente
- [ ] Seeding strategy documentada (dev mínimo, staging sintético)
- [ ] CI corre testes contra branch project (não só local)
- [ ] `supabase db diff` em PR review
- [ ] Cleanup automático de branches efémeros
- [ ] Backups: PITR só em prod, semanal em staging, off em dev
