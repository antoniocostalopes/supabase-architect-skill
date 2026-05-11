---
description: Desenhar, auditar ou otimizar setup de RAG / pgvector / semantic search em Supabase
argument-hint: ["setup" | "audit" | "tune" | "hybrid" | path]
---

Aplica a skill **Supabase Architect** em modo pgvector / RAG sobre `$ARGUMENTS`.

Modos:
- `setup` — gera schema completo com `vector`, indexes, RPCs, Edge Function de embedding
- `audit` — revê setup existente (dimensão correta? RLS? hybrid search? cost?)
- `tune` — ajusta HNSW/IVFFlat parameters, tamanho de chunk, threshold
- `hybrid` — adiciona FTS + RRF para hybrid search a um setup vector-only
- `<path>` — analisa setup específico

Carrega:
- `references/12-pgvector-rag.md`
- `references/01-rls-patterns.md` (RLS aplicada à tabela de embeddings)
- `references/02-multi-tenant-patterns.md` (filtro por tenant em ANN)
- `references/03-postgresql-performance.md` (cost de scan + index)
- `references/08-edge-functions-security.md` (Edge Function que chama provider de embedding)

Workflow:
1. Detecta presença e versão de `pgvector` (`SELECT extversion FROM pg_extension WHERE extname='vector'`)
2. Identifica modelo de embedding em uso (procura no código: `text-embedding-3-*`, `voyage-*`, `embed-v3`, etc.)
3. Para `setup`:
   - Pergunta dimensão, multi-tenant ou single-tenant, língua FTS
   - Gera schema, indexes (HNSW preferido), RPC `search_documents`, RPC `hybrid_search`, Edge Function de embedding
4. Para `audit`:
   - Tabelas com `vector(N)` — verifica RLS, indexes ANN com operator class correta
   - Procura embedding-no-cliente (anti-pattern A2)
   - Verifica que queries usam o operador correspondente ao index
   - Avalia cost (storage + recall vs latência)
5. Para `tune`:
   - Sugere `m`, `ef_construction`, `hnsw.ef_search` conforme volume
   - Sugere quantização (halfvec/binary) se >10M vectors
6. Para `hybrid`:
   - Adiciona `content_tsv` generated column + GIN index
   - Gera RPC `hybrid_search` com RRF

Output: `SUPABASE_RAG.md` seguindo `templates/rag.md`:
- Sumário (estado pgvector, tabelas vectoriais, hybrid search, RLS coverage)
- Achados Críticos/Altos/Médios (RLS missing, op class errada, API key no cliente)
- Schema completo (CREATE TABLE + indexes ANN + RLS + policies)
- RPCs `SECURITY DEFINER` para search e hybrid_search
- Edge Function `embed-document` template
- Chunking strategy + cost estimation
- Tuning HNSW por volume
- Plano de aplicação em 3 fases
- Checklist completa e queries de diagnóstico
