# Examples — Supabase Architect

Exemplos few-shot do tipo de output que a skill deve produzir. **Ler 1 antes** de gerar o relatório final para alinhar formato e tom.

## Audit completos (5 domínios)

| Exemplo | Tipo de projeto | Padrões únicos demonstrados |
|---|---|---|
| [`audit-example-saas-multi-tenant.md`](audit-example-saas-multi-tenant.md) | SaaS B2B / CRM com Next.js | organizations + memberships, role-based RLS, attack chains, full audit completo |
| [`audit-example-marketplace.md`](audit-example-marketplace.md) | Marketplace 2-sided | sellers + buyers, stock atomicity, listings públicos vs drafts, Stripe Connect |
| [`audit-example-b2c.md`](audit-example-b2c.md) | B2C (Expo + web) user-as-tenant | profiles públicos vs privados, share links com TTL, optimistic locking mobile sync |
| [`audit-example-hotel.md`](audit-example-hotel.md) | Hotel / booking system | `tstzrange` + EXCLUDE GiST, multi-property hierarchy, RPC cancelation atómica |
| [`audit-example-lms.md`](audit-example-lms.md) | LMS / learning platform | enrollment como gate, quiz answers isolados, signed video URLs, anti-cheat audit |

## Outputs específicos standalone

| Exemplo | Output | Quando usar |
|---|---|---|
| [`rls-example-saas.md`](rls-example-saas.md) | `SUPABASE_RLS.md` | Geração de policies para tabela nova + audit das existentes |
| [`performance-example-saas.md`](performance-example-saas.md) | `SUPABASE_PERFORMANCE.md` | Diagnóstico EXPLAIN + indexes + N+1 + materialized views |
| [`migration-example-rename.md`](migration-example-rename.md) | `SUPABASE_MIGRATIONS.md` | Migração breaking (rename) com expand/contract 3 fases |
| [`rag-example-saas.md`](rag-example-saas.md) | `SUPABASE_RAG.md` | Setup novo de pgvector multi-tenant com Voyage + hybrid search |

## Quando usar cada exemplo

A skill escolhe **o exemplo mais próximo** do domínio do projeto a auditar:

- Detectou `memberships`, `organizations` → **SaaS multi-tenant**
- Detectou `listings`, `sellers`, `orders`, `payouts` → **Marketplace**
- Detectou `profiles` 1:1 + sem `organizations` → **B2C user-as-tenant**
- Detectou `bookings`, `rooms`, `properties`, `tstzrange`/`daterange` → **Hotel/booking**
- Detectou `courses`, `enrollments`, `lessons`, `quiz_*` → **LMS**

Para domínios **não cobertos** (HR, healthcare, fintech, etc.), o SaaS multi-tenant é o melhor ponto de partida e adaptar.

## Padrão de uso

Cada exemplo segue a estrutura de `templates/audit.md` mas **destaca patterns únicos** do domínio:
- Modelo de dados específico (não copia o "organizations + memberships" genérico)
- Achados que **só fazem sentido** naquele tipo de projeto (não repete RLS missing universal)
- Helpers de autorização adaptados (`is_seller`, `is_order_participant`, `is_enrolled`, etc.)
- SQL copy-paste pronto, sem placeholders

A skill **não cola o exemplo** — usa-o como guia de formato/tom/profundidade.
