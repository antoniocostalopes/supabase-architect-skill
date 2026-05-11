---
description: Auditar Supabase Storage — buckets, policies, signed URLs, path strategy, MIME validation
argument-hint: [bucket opcional]
---

Aplica a skill **Supabase Architect** em modo Storage.

Carrega:
- `references/06-storage-security.md`
- `references/10-common-vulnerabilities.md` (V05, V06)
- `references/02-multi-tenant-patterns.md` (para path strategy multi-tenant)

Workflow:
1. Lista buckets (`storage.buckets`) com `public`, `file_size_limit`, `allowed_mime_types`
2. Para cada bucket:
   - Avalia se `public = true` é apropriado ao conteúdo
   - Verifica policies em `storage.objects` (SELECT/INSERT/UPDATE/DELETE)
   - Analisa path strategy (existe prefixo de tenant? de user?)
   - Valida limites de tamanho e MIME
3. Procura uso no código:
   - `getPublicUrl` vs `createSignedUrl`
   - `upload` com paths construídos a partir de input do user (path traversal)
   - Validação MIME / magic bytes do lado da app
4. Detecta cleanup gaps (temp buckets sem retention policy)

Output: `SUPABASE_SECURITY.md` (secção Storage) seguindo `templates/security.md`:
- Tabela de buckets com diagnóstico
- Achados Críticos:
  - Bucket público com PII / faturas / documentos
  - Bucket privado sem policies (= bloqueado, ou aberto?)
  - Path strategy sem isolamento de tenant
- Policies SQL prontas:
  - User-owned (`<user_id>/<file>`)
  - Org-owned (`<org_id>/<user_id>/<file>`)
  - Public read + private write
- Refactor de código:
  - `getPublicUrl` → `createSignedUrl` em buckets que devem ser privados
  - Sanitização de filename antes de `upload()`
  - Validação MIME / magic bytes
- Cleanup policy via `pg_cron` para temp buckets
