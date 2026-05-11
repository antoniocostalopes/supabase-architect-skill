---
description: Modo geral do Supabase Architect — decide o subset adequado consoante o pedido
argument-hint: [pedido específico ou path]
---

Activa a skill **Supabase Architect** sobre o projeto atual (ou sobre `$ARGUMENTS` se especificado).

Comportamento:
1. Lê `~/.claude/skills/supabase/SKILL.md`.
2. Faz reconhecimento (Fase 1 do workflow): detecta stack Supabase no projeto (`supabase/`, `*.sql`, imports `@supabase/*`, types gerados).
3. Pergunta ao developer o subset relevante **se o pedido for ambíguo**; caso contrário decide pelo contexto:
   - Há perguntas sobre policies? → carrega `01-rls-patterns.md` + `02-multi-tenant-patterns.md`
   - Há perguntas sobre performance? → carrega `03-postgresql-performance.md`
   - Há perguntas sobre migrações? → carrega `04-migration-safety.md`
   - Etc.
4. Aplica o template apropriado de `templates/`.

Quando o pedido é genuinamente amplo (ex: "audita o meu Supabase"), executa o workflow das 7 fases completo e devolve `SUPABASE_AUDIT.md`.

Output: ficheiro Markdown estruturado conforme o template, com SQL copy-paste e rollback documentado.
