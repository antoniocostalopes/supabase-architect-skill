---
description: Production readiness assessment para projeto Supabase — relatório completo de bloqueadores e gaps
argument-hint: [ambiente: staging | production | path]
---

Aplica a skill **Supabase Architect** em modo readiness check sobre `$ARGUMENTS` (default: o projeto atual configurado para produção).

Carrega:
- `references/09-production-checklist.md`
- Todas as `references/*.md` (auditoria abrangente)

Workflow:
1. Reconhecimento de stack
2. Aplica as 11 secções do checklist (A–K):
   - A. Security
   - B. Performance
   - C. Migrations & schema
   - D. Data integrity
   - E. Observability
   - F. Backups & DR
   - G. Environment hygiene
   - H. App-level
   - I. Rate limiting
   - J. Compliance & privacy
   - K. Documentation
3. Para cada item, verifica estado:
   - `[x]` — confirmado OK
   - `[ ]` — falta / problema (com fix proposto)
4. Identifica **bloqueadores** (impedem ship)
5. Identifica **riscos altos** (resolver antes de tráfego significativo)
6. Calcula score por secção e global

Output: `SUPABASE_PRODUCTION.md` seguindo `templates/production.md`:
- **Veredicto**: READY / NOT READY com justificação em 1 frase
- Score por secção + global
- Lista de bloqueadores (com fix)
- Lista de riscos altos
- Status detalhado por secção (A–K) com checkboxes
- Plano de remediação em 3 ondas (pré-ship, 1ª semana, 1º mês)
- Queries SQL para re-verificação automatizada
- Sign-off (tech lead, security, EM)
