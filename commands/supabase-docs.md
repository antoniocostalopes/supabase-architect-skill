---
description: Gerar documentação técnica para o projeto Supabase (arquitetura, RLS, schema, migrações)
argument-hint: [tópico: "all" | "architecture" | "rls" | "schema" | "migrations"]
---

Aplica a skill **Supabase Architect** em modo documentação.

Modos:
- `all` — gera o set completo em `docs/`:
  - `SUPABASE_ARCHITECTURE.md`
  - `SUPABASE_RLS.md`
  - `SUPABASE_SECURITY.md`
- `architecture` — apenas o documento de arquitetura
- `rls` — apenas o documento de RLS (estado + helpers + policies por tabela)
- `schema` — schema completo com convenções e diagramas
- `migrations` — guia de migrações + lista das aplicadas

Carrega:
- Toda a `references/*.md` necessária ao tópico
- Templates correspondentes em `templates/`

Workflow:
1. Faz reconhecimento (Fase 1) e mapeamento (Fase 2) do projeto
2. Lê schema atual (via `supabase db dump --schema public` se disponível, ou ficheiros em `supabase/migrations/`)
3. Extrai:
   - Tabelas, colunas, tipos, defaults
   - FKs e relações
   - Policies existentes
   - Triggers e funções
   - Buckets de storage
   - Edge Functions
4. Gera o documento aplicando o template correspondente

Output: ficheiros em `docs/`:
- Estrutura conforme `templates/<tipo>.md`
- ADRs (Architecture Decision Records) se detetar decisões implícitas
- Diagrama lógico ASCII
- Convenções extraídas (naming, tipos, padrões)
- Apêndices: SQL completo, queries de diagnóstico

Princípio: **não inventar**. Se o schema/RLS está incompleto, documentar o estado real (com gaps marcados) em vez de inventar partes.
