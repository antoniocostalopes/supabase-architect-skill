# Template — SUPABASE_RAG.md

Estrutura fixa para output de desenho/auditoria/tuning de pgvector + RAG.

---

```markdown
# SUPABASE_RAG — <project_name>

> Setup / auditoria de pgvector + RAG gerada por **Supabase Architect** em <YYYY-MM-DD>.
> Stack detectado: <Next.js | Remix | ...> · Modelo embedding: <text-embedding-3-small | voyage-3 | ...> · Dimensão: <1024 | 1536 | ...>.
> Escopo: <setup novo | audit do existente | tuning | hybrid search>.

## Sumário

- **Estado pgvector**: <não instalado | v0.7.0 | desatualizado>
- **Tabelas com `vector`**: <n>
- **Indexes ANN**: <n> HNSW / <n> IVFFlat
- **Hybrid search**: <sim | não | parcial>
- **RLS em embeddings**: <ok | gap em N tabelas>

## 1. Estado atual

### Extensão
```sql
SELECT extversion FROM pg_extension WHERE extname = 'vector';
-- Resultado: <versão | NOT INSTALLED>
```

### Tabelas vectoriais detectadas
| Tabela | Coluna | Dimensão | Index ANN | Op class | RLS | Tenant filter |
|---|---|---|---|---|---|---|
| documents | embedding | 1536 | HNSW | `vector_cosine_ops` | ✅ | ✅ |
| memos | content_emb | 768 | **none** | — | ❌ | ❌ |

### Modelo de embedding em uso
- Provider: `<openai | voyage | cohere | local>`
- Modelo: `<text-embedding-3-small | voyage-3 | embed-v3 | ...>`
- Onde é gerado: `<server-side Edge Function | cliente — RISCO>`

## 2. Achados

### [CRÍTICO] OPENAI_API_KEY no bundle do cliente
- **Localização**: `src/lib/embeddings.ts:12`
- **Problema**: chave de embedding exposta no JS do browser. Custo + risco de abuse.
- **Correção**: mover para Edge Function `embed-document` com auth check. Ver `references/12-pgvector-rag.md` secção "Geração de embeddings".

### [ALTO] Tabela `documents` sem RLS
…

### [ALTO] Index ANN com operator class errada
- **Problema**: index criado com `vector_l2_ops` mas queries usam `<=>` (cosine). Index não é usado.
- **Fix**:
  ```sql
  DROP INDEX idx_documents_emb_l2;
  CREATE INDEX idx_documents_emb_cosine
    ON public.documents USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
  ```

### [MÉDIO] Hybrid search ausente
Queries factuais ("o que diz o artigo X sobre Y") beneficiam de FTS + vector com RRF.

## 3. Schema completo proposto

```sql
-- Extensão
CREATE EXTENSION IF NOT EXISTS vector;

-- Tabela
CREATE TABLE public.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  source_id uuid NOT NULL,
  chunk_index int NOT NULL,
  content text NOT NULL,
  content_tsv tsvector
    GENERATED ALWAYS AS (to_tsvector('portuguese', content)) STORED,
  embedding vector(1024) NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  token_count int,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, chunk_index)
);

-- Indexes
CREATE INDEX idx_documents_org ON public.documents(organization_id);
CREATE INDEX idx_documents_tsv ON public.documents USING gin (content_tsv);
CREATE INDEX idx_documents_emb_hnsw
  ON public.documents USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
CREATE INDEX idx_documents_metadata_gin ON public.documents USING gin (metadata);

-- RLS
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "documents_select" ON public.documents
FOR SELECT TO authenticated
USING (public.is_member(organization_id));

CREATE POLICY "documents_insert" ON public.documents
FOR INSERT TO authenticated
WITH CHECK (public.has_role(organization_id, 'member'));

CREATE POLICY "documents_delete" ON public.documents
FOR DELETE TO authenticated
USING (public.has_role(organization_id, 'admin'));
```

## 4. RPCs de busca

### Semantic search
```sql
CREATE OR REPLACE FUNCTION public.search_documents(
  query_embedding vector(1024),
  org_id uuid,
  match_count int DEFAULT 10,
  similarity_threshold float DEFAULT 0.0
)
RETURNS TABLE (id uuid, content text, metadata jsonb, similarity float)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT d.id, d.content, d.metadata,
         1 - (d.embedding <=> query_embedding) AS similarity
  FROM public.documents d
  WHERE d.organization_id = org_id
    AND public.is_member(org_id)
    AND 1 - (d.embedding <=> query_embedding) >= similarity_threshold
  ORDER BY d.embedding <=> query_embedding
  LIMIT match_count;
$$;

REVOKE EXECUTE ON FUNCTION public.search_documents FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_documents TO authenticated;
```

### Hybrid search (RRF)
Ver `references/12-pgvector-rag.md` — secção "Hybrid search". RPC `public.hybrid_search` completa.

## 5. Edge Function — geração server-side

```ts
// supabase/functions/embed-document/index.ts
// Ver references/12-pgvector-rag.md — secção "Geração de embeddings (padrão server-side)"
```

Resumo: auth check → membership check → embed em batch (OpenAI/Voyage) → insert via `userClient` (RLS aplicada).

## 6. Chunking strategy

- **Tamanho**: <200-400 | 500-800 | 1000-1500> tokens
- **Overlap**: <10-20%>
- **Metadata por chunk**: `title`, `breadcrumbs`, `section`, `source_url`

## 7. Cost & storage

| Item | Estimativa |
|---|---|
| 1M chunks × `vector(1024)` payload | ~4 GB |
| HNSW index | ~3-6 GB |
| Embedding 1M chunks @ 500 tokens (3-small) | ~$10 |
| Re-embed ao mudar modelo | mesmo custo + storage temporário |

## 8. Tuning recomendado

| Volume | HNSW `m` | `ef_construction` | `ef_search` |
|---|---|---|---|
| <100k vectors | 16 | 64 | 40 |
| 100k–1M | 16-24 | 64-128 | 80-100 |
| 1M–10M | 24-32 | 128-200 | 100-200 |
| >10M | considerar quantização (halfvec/binary) | | |

## 9. Plano de aplicação

### Fase 1 — Fundação
- [ ] `CREATE EXTENSION vector`
- [ ] Schema base + indexes + RLS
- [ ] RPCs `search_documents`, `hybrid_search`
- [ ] Edge Function `embed-document` com auth

### Fase 2 — Pipeline
- [ ] Chunking strategy aplicada
- [ ] Pipeline de ingestão (job ou Edge Function por documento criado)
- [ ] Re-embedding plan caso mude o modelo

### Fase 3 — Otimização
- [ ] Hybrid search se queries são factuais
- [ ] Reranking opcional (Cohere Rerank, Voyage Rerank)
- [ ] Quantização se >10M vectors

## 10. Checklist

(do `references/12-pgvector-rag.md` — secção "Checklist pgvector")

- [ ] `CREATE EXTENSION vector` aplicada
- [ ] Dimensão corresponde ao modelo de embedding
- [ ] Index ANN (HNSW) com operator class correta
- [ ] `organization_id` (ou tenant_id) + index a suportar
- [ ] RLS ativa + policies multi-tenant
- [ ] Embedding server-side (Edge Function), nunca no cliente
- [ ] Hybrid search se há queries factuais
- [ ] Threshold de similaridade configurável
- [ ] Chunking strategy documentada
- [ ] Plano para re-embedding ao trocar de modelo

## Apêndice — Queries de diagnóstico

```sql
-- Linhas embedidas por organização
SELECT organization_id, count(*), pg_size_pretty(sum(pg_column_size(embedding))::bigint)
FROM public.documents GROUP BY organization_id ORDER BY count(*) DESC;

-- Indexes ANN
SELECT indexrelname, indexdef FROM pg_indexes
JOIN pg_class c ON c.relname = indexname
WHERE indexdef ~ '(hnsw|ivfflat)';

-- Tabelas com colunas vector
SELECT n.nspname || '.' || c.relname, a.attname, format_type(a.atttypid, a.atttypmod)
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE a.atttypid = (SELECT oid FROM pg_type WHERE typname = 'vector')
  AND n.nspname = 'public';
```
```
