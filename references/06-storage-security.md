# Supabase Storage Security

Buckets, policies, signed URLs, upload size limits, ownership por path.

## Modelo

- **Buckets** — namespaces de armazenamento, `public` ou `private`
- **`storage.objects`** — tabela com 1 linha por ficheiro. Tem RLS própria.
- **`storage.buckets`** — metadata dos buckets.

Operações são REST API mas o controlo de acesso é via policies em `storage.objects`.

## Public vs Private bucket

```sql
INSERT INTO storage.buckets (id, name, public) VALUES ('avatars', 'avatars', true);
INSERT INTO storage.buckets (id, name, public) VALUES ('documents', 'documents', false);
```

| Tipo | URL para GET | Ideal para |
|---|---|---|
| Public | `/storage/v1/object/public/<bucket>/<path>` — sem auth | Avatares, logos, assets de marketing |
| Private | `/storage/v1/object/sign/<bucket>/<path>` — signed URL com TTL | Faturas, documentos, exports, qualquer PII |

### Quando é seguro um bucket público?

- Conteúdo é mesmo público (vai a CDN, pode aparecer em redes sociais)
- Paths são **não-enumeráveis** (UUID, não `user_42/avatar.jpg`)
- Tamanho aceitável de risco se um path for adivinhado

### Quando NUNCA é seguro um bucket público?

- Contém invoices, contratos, exports de dados, médicos, financeiros
- Paths previsíveis (`user_<id>/profile.pdf`)
- Conteúdo de utilizador que escreveu na expectativa de privacidade

## Storage policies — anatomia

Policies vivem em `storage.objects`. Filtra-se por `bucket_id` e por `name` (path do ficheiro).

Helper de path:
```sql
storage.foldername(name)  -- text[], partes do path
storage.filename(name)    -- text, último segmento
storage.extension(name)   -- text, ext do filename
```

## Padrão 1 — Bucket user-owned (avatars privados)

Estrutura: `<bucket>/<user_id>/<file>.jpg`

```sql
-- Bucket privado
INSERT INTO storage.buckets (id, name, public)
VALUES ('user_files', 'user_files', false);

-- READ: cada user lê os seus
CREATE POLICY "user_files_read_own" ON storage.objects
FOR SELECT TO authenticated
USING (
  bucket_id = 'user_files'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- INSERT: upload só para a própria pasta
CREATE POLICY "user_files_upload_own" ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'user_files'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- UPDATE (rename, replace): só os seus
CREATE POLICY "user_files_update_own" ON storage.objects
FOR UPDATE TO authenticated
USING (
  bucket_id = 'user_files'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- DELETE
CREATE POLICY "user_files_delete_own" ON storage.objects
FOR DELETE TO authenticated
USING (
  bucket_id = 'user_files'
  AND (storage.foldername(name))[1] = auth.uid()::text
);
```

## Padrão 2 — Bucket organization-owned (multi-tenant)

Estrutura: `<bucket>/<organization_id>/<user_id>/<file>`

```sql
INSERT INTO storage.buckets (id, name, public)
VALUES ('documents', 'documents', false);

CREATE POLICY "documents_read_org" ON storage.objects
FOR SELECT TO authenticated
USING (
  bucket_id = 'documents'
  AND public.is_member(((storage.foldername(name))[1])::uuid)
);

CREATE POLICY "documents_upload_org" ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'documents'
  AND public.is_member(((storage.foldername(name))[1])::uuid)
  AND (storage.foldername(name))[2] = auth.uid()::text
);

CREATE POLICY "documents_delete_admin" ON storage.objects
FOR DELETE TO authenticated
USING (
  bucket_id = 'documents'
  AND public.has_role(((storage.foldername(name))[1])::uuid, 'admin')
);
```

## Padrão 3 — Public bucket com upload restrito

Avatares: leitura pública, upload só do próprio.

```sql
INSERT INTO storage.buckets (id, name, public)
VALUES ('avatars', 'avatars', true);

-- Não precisa policy de SELECT (bucket público)

CREATE POLICY "avatars_upload_self" ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'avatars'
  AND (storage.foldername(name))[1] = auth.uid()::text
  AND storage.extension(name) IN ('jpg','jpeg','png','webp','gif')
);

CREATE POLICY "avatars_update_self" ON storage.objects
FOR UPDATE TO authenticated
USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "avatars_delete_self" ON storage.objects
FOR DELETE TO authenticated
USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);
```

## Signed URLs

Para servir conteúdo privado, gerar URL temporária:

```ts
const { data, error } = await supabase
  .storage
  .from('documents')
  .createSignedUrl(`${orgId}/${userId}/invoice.pdf`, 60 * 5)  // 5 min
// data.signedUrl é o URL temporário
```

Boas práticas:
- TTL curto (segundos a minutos), não horas
- Não fazer cache dos URLs assinados (são temporários)
- Validar autorização antes de gerar (a RLS já valida read, mas confirma se podes mostrar)

### Signed upload URL

Para uploads diretos do cliente sem passar pela tua API:

```ts
const { data } = await supabase.storage.from('documents').createSignedUploadUrl(
  `${orgId}/${userId}/${filename}`
)
// Cliente faz PUT para data.signedUrl
```

Útil para grandes ficheiros. Validar limites na policy de INSERT.

## Limites e validação

### Tamanho máximo por bucket (Supabase Dashboard)
- Por defeito 50MiB. Subir conforme caso de uso.
- Para vídeo/imagens grandes, ativar **resumable uploads**.

### Validar MIME type
Não confiar em extensão. Validar no servidor (Edge Function ou backend):

```ts
const allowedMimeTypes = ['image/jpeg','image/png','image/webp','application/pdf']
if (!allowedMimeTypes.includes(file.type)) reject()
```

A policy também pode forçar extensão:
```sql
AND storage.extension(name) IN ('jpg','jpeg','png','webp')
```

Mas extension não garante mime. Para garantir conteúdo:
- Validar magic bytes no cliente / Edge Function
- Usar `image_transform` do Supabase Storage para validar imagens
- Quarentena: bucket de upload + scan + mover para bucket final

### Image transformations
```ts
const { data } = supabase.storage.from('avatars').getPublicUrl(`${userId}/avatar.jpg`, {
  transform: { width: 200, height: 200, resize: 'cover', quality: 80 }
})
```
Reduz custo de bandwidth e bloqueia ficheiros corruptos (transformação falha em ficheiros inválidos).

## Path traversal / injection

`storage.foldername()` segmenta por `/`. Patterns problemáticos:
- Path com `..` (Supabase normaliza, mas testar)
- Path com `null bytes` ou caracteres de controle
- Paths muito profundos (avaliar custo de filesystem)

Validar do lado do cliente/Edge Function antes de upload:
```ts
function safePath(input: string): string {
  return input
    .replace(/\.\.+/g, '')
    .replace(/[^a-zA-Z0-9._\-\/]/g, '_')
    .replace(/\/+/g, '/')
    .slice(0, 255)
}
```

## Detecção de problemas

```sql
-- Buckets públicos
SELECT id, name, public, file_size_limit, allowed_mime_types
FROM storage.buckets
WHERE public = true;

-- Buckets sem policies (em modo private)
SELECT b.id
FROM storage.buckets b
LEFT JOIN pg_policies p ON p.tablename = 'objects'
  AND p.schemaname = 'storage'
  AND b.id::text = ANY(string_to_array(p.qual::text, ''''))
WHERE b.public = false
GROUP BY b.id
HAVING count(p.policyname) = 0;
-- (heurística — verificar manualmente)

-- Policies de storage existentes
SELECT policyname, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'storage' AND tablename = 'objects';

-- Tamanho ocupado por bucket
SELECT bucket_id, count(*), pg_size_pretty(sum(metadata->>'size')::bigint::numeric)
FROM storage.objects
GROUP BY bucket_id;
```

## Auditoria de storage (checklist)

Para cada bucket:

- [ ] `public` está correto para o tipo de conteúdo?
- [ ] Tem policies SELECT/INSERT/UPDATE/DELETE definidas (ou justificadamente ausentes)?
- [ ] Path strategy é `<tenant>/<user>/<file>` ou `<user>/<file>`?
- [ ] Policies usam `storage.foldername` para isolar?
- [ ] `file_size_limit` definido?
- [ ] `allowed_mime_types` definido (quando aplicável)?
- [ ] Signed URLs com TTL curto?
- [ ] Validação de MIME / magic bytes no upload?
- [ ] Filenames sanitizados antes de chamar `upload()`?

## Anti-patterns

### A1. Path sem prefixo de tenant
```
documents/invoice_2026_01.pdf  ← sem isolation; qualquer policy é frágil
```

### A2. Bucket público com filenames previsíveis
```
public/invoices/INV-001.pdf, INV-002.pdf...  ← enumerable
```

### A3. Mesma path para upload e read sem ownership
```sql
-- Policy de read que permite o user ler tudo da org E qualquer um fazer upload
USING (bucket_id = 'docs')
-- (sem filtros adicionais)
```

### A4. Esquecer DELETE policy
Bucket privado sem policy de DELETE = nada apaga. Storage cresce indefinidamente.

### A5. service_role usado para "simplificar" uploads
```ts
// Cliente faz POST para a API que usa service_role para upload
// → user não autenticado pode chamar API se a API não validar
```

## Cleanup e retenção

Para dados temporários (exports, screenshots, uploads não confirmados):

```sql
-- Política de retenção via pg_cron + função
CREATE OR REPLACE FUNCTION public.cleanup_old_temp_files()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = storage, public, pg_temp
AS $$
BEGIN
  DELETE FROM storage.objects
  WHERE bucket_id = 'temp_exports'
    AND created_at < now() - interval '7 days';
END;
$$;

SELECT cron.schedule('cleanup-temp-files', '0 3 * * *',
  $$SELECT public.cleanup_old_temp_files()$$);
```

Atenção: `DELETE` em `storage.objects` apaga só o registo. O ficheiro físico é apagado pelo worker do Supabase Storage. Confirmar se está a acontecer.
