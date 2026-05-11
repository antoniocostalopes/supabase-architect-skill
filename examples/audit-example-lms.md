# Example — SUPABASE_AUDIT.md (LMS — Learning Management)

Exemplo few-shot para plataforma educacional. Padrões únicos: courses + enrollments + grades, conteúdo privado vs preview, progresso por aluno, certificates, instructor vs student access boundaries.

---

```markdown
# SUPABASE_AUDIT — academy-pro

> Auditoria gerada por **Supabase Architect** em 2026-05-11.
> Stack: Next.js + Supabase + Mux (vídeo) · Project: `acdm321`.
> Modelo: multi-tenant (cada escola = `organization`); roles internos (instructor / student / admin).

## Sumário

- **Score**: 58 / 100 — Pre-produção
- **Críticos**: 2 · **Altos**: 6 · **Médios**: 9 · **Baixos**: 5

## Modelo de dados

```
public.organizations (escola)
    │
    ├──N:M── public.memberships (role: admin | instructor | student)
    │
    ├──1:N── public.courses
    │            │
    │            └──1:N── public.lessons (vídeo, texto, quiz)
    │
    └──1:N── public.enrollments (student → course)
                 │
                 ├──1:N── public.lesson_progress (concluído / score)
                 ├──1:N── public.quiz_attempts
                 └──1:1── public.certificates (post-completion)
```

## Achados destacados (únicos do domínio)

### [CRÍTICO · 95%] Students acedem a conteúdo de cursos sem enrollment

- **Localização**: `pg_policies` → `lessons_select`
- **Problema**:
  ```sql
  CREATE POLICY "lessons_select" ON public.lessons
  FOR SELECT TO authenticated
  USING (public.is_member(organization_id));
  ```
  Permite a qualquer membro (incluindo students não enrolled) ler todas as lessons da escola.
- **Impacto**: Student pode aceder a cursos pagos sem ter pagado, vídeos privados de outros programas, etc.
- **Fix** — distinguir preview vs full content e enrollment:
  ```sql
  -- Helper
  CREATE OR REPLACE FUNCTION public.is_enrolled(target_course uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.enrollments
      WHERE course_id = target_course
        AND student_id = auth.uid()
        AND status IN ('active', 'completed')
    );
  $$;

  -- Preview público (anon + authenticated) — só lessons marcadas
  CREATE POLICY "lessons_preview" ON public.lessons
  FOR SELECT TO anon, authenticated
  USING (is_preview = true AND deleted_at IS NULL);

  -- Conteúdo completo — só enrolled ou staff
  CREATE POLICY "lessons_enrolled" ON public.lessons
  FOR SELECT TO authenticated
  USING (
    deleted_at IS NULL
    AND (
      public.is_enrolled(course_id)
      OR public.has_role(organization_id, 'admin')  -- inclui instructor
    )
  );

  -- Index a suportar
  CREATE INDEX IF NOT EXISTS idx_enrollments_student_course
    ON public.enrollments(student_id, course_id)
    WHERE status IN ('active', 'completed');
  ```

### [CRÍTICO · 95%] Quiz answers visíveis aos students antes da submissão

- **Problema**: Tabela `quiz_questions` tem coluna `correct_answer`. Policy permite SELECT a student enrolled → cliente pode ler as respostas via DevTools.
- **Fix** — separar em duas tabelas:
  ```sql
  -- Tabela pública (sem correct_answer)
  CREATE TABLE public.quiz_questions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
    organization_id uuid NOT NULL,
    prompt text NOT NULL,
    choices jsonb NOT NULL,
    points int NOT NULL DEFAULT 1
  );

  -- Tabela "secreta" (só service_role acede)
  CREATE TABLE public.quiz_answers (
    question_id uuid PRIMARY KEY REFERENCES public.quiz_questions(id) ON DELETE CASCADE,
    correct_choice_index int NOT NULL
  );

  ALTER TABLE public.quiz_answers ENABLE ROW LEVEL SECURITY;
  -- Sem policies = só service_role/postgres acede

  -- Submissão via RPC SECURITY DEFINER
  CREATE OR REPLACE FUNCTION public.submit_quiz_attempt(
    course_id uuid,
    answers jsonb  -- {question_id: choice_index}
  ) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE
    score numeric := 0;
    total int := 0;
    item record;
  BEGIN
    IF NOT public.is_enrolled(submit_quiz_attempt.course_id) THEN
      RAISE EXCEPTION 'not_enrolled' USING ERRCODE = '42501';
    END IF;

    FOR item IN
      SELECT q.id, q.points, a.correct_choice_index,
        (answers->>q.id::text)::int AS submitted
      FROM public.quiz_questions q
      JOIN public.quiz_answers a ON a.question_id = q.id
      WHERE q.course_id = submit_quiz_attempt.course_id
    LOOP
      total := total + item.points;
      IF item.submitted = item.correct_choice_index THEN
        score := score + item.points;
      END IF;
    END LOOP;

    INSERT INTO public.quiz_attempts (course_id, student_id, score, max_score, answers)
    VALUES (submit_quiz_attempt.course_id, auth.uid(), score, total, answers);

    RETURN jsonb_build_object('score', score, 'max', total, 'pct', round(score / nullif(total,0) * 100, 1));
  END;
  $$;
  ```

### [ALTO · 90%] Video URLs (Mux) embebidos em policy SELECT pública

- **Problema**: `lessons.video_url` está em `SELECT *` da policy de preview. Mesmo lessons não preview têm URL no payload se o student está noutro curso.
- **Fix** — não passar URL bruto; gerar signed URL via Edge Function:
  ```ts
  // supabase/functions/get-lesson-video/index.ts
  // 1. Validar auth + enrollment
  // 2. Pedir a Mux/Cloudflare Stream um signed playback URL com TTL curto
  // 3. Devolver
  ```

### [ALTO · 85%] Grades visíveis a outros students

- **Problema**: `lesson_progress` tem policy `is_member(organization_id)` — outros students leem progresso uns dos outros.
- **Fix**:
  ```sql
  CREATE POLICY "lesson_progress_select_own_or_instructor" ON public.lesson_progress
  FOR SELECT TO authenticated
  USING (
    student_id = auth.uid()
    OR public.has_role(organization_id, 'admin')  -- inclui instructor
  );
  ```

### [ALTO] Certificates geram via Edge Function sem signature

- Risco: student pode gerar certificate diretamente via API com `course_id = X` mesmo sem completion. Validar `enrollment.status = 'completed'` na Edge Function (não confiar no payload).

### [MÉDIO] Realtime em `lesson_progress` write-heavy

- Cada vídeo gera updates a cada 10s. Em escola com 500 students ativos → carga alta.
- Fix: cliente faz throttling local + flush periódico; tabela não está em `supabase_realtime` (RLS protege; cliente refresca por pull).

## Plano

### Fase 1 — Conteúdo seguro (1 semana)
- [ ] Helper `is_enrolled` + reescrever policies de `lessons`
- [ ] Separar `quiz_answers` em tabela isolada + RPC `submit_quiz_attempt`
- [ ] Edge Function `get-lesson-video` com signed URL

### Fase 2 — Grades / progress (1 semana)
- [ ] Fix policy de `lesson_progress`
- [ ] Audit log de cheating attempts (RPC chamada sem enrollment, etc.)
- [ ] Certificate generation com validação completa

### Fase 3 — Operacional (1 mês)
- [ ] Materialized view `student_progress_per_course`
- [ ] Reports de instrutor (dashboard de turma)
- [ ] Storage `course_materials` privado com signed URLs
```

---

## Notas — padrões únicos LMS

- **Enrollment como gate**: helper `is_enrolled(course_id)` é o equivalente a `is_member` para acesso a conteúdo pago.
- **Preview vs full content**: 2 policies SELECT na mesma tabela — uma para preview público (`is_preview = true`), outra para enrolled.
- **Quiz answers**: tabela separada com **sem policies = só service_role**. Frontend nunca vê. Submissão via RPC `SECURITY DEFINER`.
- **Video URLs**: gerar signed URLs via Edge Function (Mux Playback ID + signing) com TTL curto. Não armazenar URL bruto em coluna acessível por RLS.
- **Grades / progress** são per-student. Policy `student_id = auth.uid() OR has_role('admin')`. Instructor é tipicamente role `admin`.
- **Certificates**: gerar em Edge Function que valida `enrollment.status = 'completed'`. PDF assinado, armazenado em bucket privado com signed URL.
- **Anti-cheat**: audit log de RPC calls (submit_quiz_attempt sem enrollment, tentativas repetidas, etc.).
