# Template — SUPABASE_BRANCHING.md

Estrutura fixa para output de setup/auditoria de branching e ambientes Supabase.

---

```markdown
# SUPABASE_BRANCHING — <project_name>

> Setup / auditoria de Supabase Branching e ambientes gerada por **Supabase Architect** em <YYYY-MM-DD>.
> Modelo escolhido: <branching nativo | 3 projetos separados | híbrido>.

## Sumário

- **Branching nativo**: <ativado | não disponível em plano atual>
- **Ambientes em uso**: <dev | dev + staging | dev + staging + prod | só prod>
- **OAuth apps separadas por ambiente**: <sim | não — RISCO>
- **Secrets separados por ambiente**: <sim | não — RISCO>
- **Seeding strategy**: <documentada | ad-hoc>

## 1. Estado atual

### Projetos Supabase
| Ambiente | Project ref | Plano | Backups | Auth providers |
|---|---|---|---|---|
| development | `<ref>` | Free | off | email + Google test |
| staging | `<ref>` | Pro | semanal | email + Google staging app |
| production | `<ref>` | Team | diário + PITR | email + Google prod + SSO |

### Branching
- Activado: <sim | não>
- Repo conectado: <org/repo | não>
- `supabase/config.toml` tem `[experimental.branching]`: <sim | não>

## 2. Achados

### [CRÍTICO] Mesmo OAuth app em dev/staging/prod
- **Problema**: Cliente OAuth verificado a aceitar redirects de `localhost` + `staging` + `prod`. Leak de tokens entre ambientes.
- **Fix**: criar 3 OAuth apps no Google/GitHub provider (test mode, staging app, prod verified).

### [ALTO] `service_role` partilhado entre ambientes
- **Problema**: mesma key em CI e em local dev. Comprometimento de uma = comprometimento de todas.
- **Fix**: rotar keys, configurar separação estrita.

### [MÉDIO] Sem seeding documentado para staging
- **Fix**: criar `supabase/seeds/staging-realistic.sql` com dados sintéticos (Faker).

## 3. Modelo recomendado

### Opção A — Branching nativo (Pro+)
```toml
# supabase/config.toml
[experimental.branching]
enabled = true

[experimental.branching.git]
provider = "github"
repository = "<org>/<repo>"
production_branch = "main"
```

Workflow:
1. Developer cria branch git + PR
2. Supabase cria projeto efémero automaticamente
3. Aplica migrations do branch
4. Comenta URL+keys no PR
5. CI corre testes contra o branch project
6. Merge → migrations vão para produção

### Opção B — 3 projetos separados
```
acme-dev      → developers locais sincronizam
acme-staging  → smoke tests + dados sintéticos
acme-prod     → tráfego real
```

Promoção:
```bash
# Aplicar a staging
supabase link --project-ref $STAGING_REF && supabase db push

# Smoke tests
SUPABASE_URL=$STAGING_URL pnpm test:e2e

# Promover a produção
supabase link --project-ref $PROD_REF && supabase db push
```

## 4. Separação de credenciais

| Var | dev | staging | production |
|---|---|---|---|
| `SUPABASE_PROJECT_REF` | dev_ref | staging_ref | prod_ref |
| `SUPABASE_URL` | dev URL | staging URL | prod URL |
| `SUPABASE_ANON_KEY` | dev anon | staging anon | prod anon |
| `SUPABASE_SERVICE_ROLE_KEY` | dev service | staging service | **prod service (cofre)** |
| Stripe webhook secret | sk_test_dev | sk_test_staging | sk_live_prod |
| Google OAuth client_id | test app | staging app | verified app |

## 5. Seeding strategy

```
supabase/
├── seed.sql                       # dev local mínimo (1 user, 1 org)
└── seeds/
    ├── staging-realistic.sql      # ~10k rows sintéticos
    ├── load-test.sql              # 1M+ rows para perf
    └── README.md
```

**Anti-pattern**: importar dump de produção para staging sem **scrubbing de PII**. Usar `pg_anonymizer` ou script `sed`/SQL próprio.

## 6. Auth por ambiente

### Redirect URLs (CLI)
```bash
# Production
supabase config set auth.url.allowlist "https://acme.com"

# Staging
supabase config set auth.url.allowlist "https://staging.acme.com,https://*.vercel.app"

# Dev
supabase config set auth.url.allowlist "http://localhost:3000"
```

### JWT secret
Cada projeto tem o seu — comportamento desejado (cookies de prod não funcionam em staging).

## 7. Realtime e Database Webhooks

Capturar via migrations (não Studio):
```sql
-- supabase/migrations/<ts>_enable_realtime.sql
ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
```

`supabase db push` para qualquer ambiente liga o realtime nas tabelas certas.

## 8. CI integrado

```yaml
# .github/workflows/pr.yml
# Ver references/14-branching-environments.md — secção "CI integrado com branching"
```

## 9. Plano de aplicação

### Fase 1 — Separação básica (1 semana)
- [ ] OAuth apps separadas por ambiente
- [ ] Stripe / providers externos com chaves separadas
- [ ] `SUPABASE_SERVICE_ROLE_KEY` rotada e separada
- [ ] Redirect URLs configuradas por ambiente
- [ ] Backups configurados (PITR só em prod)

### Fase 2 — Workflow (2 semanas)
- [ ] Branching nativo activado (se plano Pro+)
- [ ] Ou: workflow de promoção dev → staging → prod
- [ ] CI corre contra branch project (não só local)
- [ ] Seed sintético em staging documentado

### Fase 3 — Operacional
- [ ] `supabase db diff --linked` em PR como comentário
- [ ] Migration ordering enforcement em CI
- [ ] Cleanup automático de branches efémeros

## 10. Checklist

(do `references/14-branching-environments.md` — secção "Checklist branching / environments")

- [ ] Production branch (`main`) protegida
- [ ] Pelo menos 2 ambientes (staging + prod) se não usar branching
- [ ] OAuth apps separadas por ambiente
- [ ] Secrets separados por ambiente
- [ ] `service_role` keys nunca atravessam ambientes
- [ ] Redirect URLs por domínio
- [ ] Seeding strategy documentada
- [ ] CI corre testes contra branch project
- [ ] `supabase db diff` em PR review
- [ ] Cleanup automático de branches efémeros
- [ ] Backups: PITR só em prod
```
