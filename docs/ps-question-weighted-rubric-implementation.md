# Round-specific question-weighted rubric implementation

Implemented on `alex/rounds-grading`. No commits, pushes, resets or stashes.

This document supersedes the earlier section-weighted/unconfigured design for **new question-weighted publications**. Existing V1 records (missing `schema_version`) and earlier V2 versions/reviews retain their original behavior. The source package's `IMPLEMENTATION.md` and `sections.js` supplied the section editor behavior; the latest user prompt supplies round isolation and question weights instead of the prototype's single rubric and equal-weight scoring.

## Behavior

- Existing round navigation, creation, renaming and ordering guards remain. Every visited round keeps a separate mounted editor, including during saves and cycle/tab switches. A failed hidden editor reports its failure in the parent workspace.
- Backend autosave uses draft revision compare-and-swap. A response cannot overwrite newer local text. Save errors pause autosave, retain edits, and offer retry, JSON export and explicit confirmed reload. Browser navigation warns while edits are unsaved.
- Title/description, section title/instructions, four question types, required state, scales and endpoint labels, option rows, duplication/moves/deletion and interactive preview are supported. Deleting a section explicitly confirms removal of its questions. At most 20 sections and 200 questions.
- New drafts use the additive `scoring_policy: question_weighted_0_3` on schema V2. Question weights are integer basis points; all linear scales need positive weights totaling 10000. Legacy scoring questions initialize equal weights when copied into this editor. New or duplicated scales have missing weights; other weights never rebalance automatically.
- Publish validates all sections/questions, whole-number scale bounds 0–10, step 1, and at least two distinct nonempty choice labels. Snapshot and scoring configuration publish in one transaction. New weighted versions can publish after grading begins; prior versions and evaluations never change. Legacy publication freezing is preserved.
- Grading uses the exact published version. Raw answers are keyed by stable question IDs. The server normalizes answered scales to 0–3 and divides their weighted sum by answered weights. Optional missing scales are excluded; zero is valid; whitespace-only required text is empty. Notes and meaningful raw text remain exact.
- Updates create immutable evaluation revisions and atomically replace the latest contribution pointer. Completion/assignment counters count distinct graders, never revisions. Readiness still means human review is available; scores/evidence never automatically advance, reject or decide a candidate. Aggregates are means of latest grader contributions **grouped by rubric version**. Existing evaluations reopen on their original rubric; new pending work uses the current publication.
- Admins alone write/import/publish rubrics. Grading still requires an owned assignment, current eligibility, active cycle/round and an accepting enrollment state. Existing auth, intake and final-decision implementations remain unchanged.

## Import

`POST /api/ps/rounds/[id]/rubric-json` returns a stateless canonical preview. Accepts the mock's nested `{title, description, sections:[{id,title,instructions,questions:[{id,title,description,type,required,min,max,low,high,weight,options}]}]}` JSON and canonical V2 JSON. `weight` is a percent with at most two decimals; canonical `weight_bps` is an integer. Missing weights remain incomplete. Invalid type/structure/title/range/choice imports leave the draft unchanged. Confirmation replaces the selected draft using the normal CAS write path. Export uses canonical V2 JSON to preserve option values, IDs, evidence purposes and all weights.

The existing bounded XLSX/CSV structure importer remains available, without persisting previews, uploaded files or historical responses. Inferred values/types remain suggestions requiring review. Legacy extra types (boolean, URL, numeric/multi choice), evidence purposes and noninteger scales need admin review into the four supported response types before a weighted publication. PDF/Word extraction, Forms API integration and simulated invitations are not implemented.

## Data and indexes

Additive fields on drafts/versions/questions: description, scoring policy, `weight_bps`, minimum/maximum labels. Immutable scoring configurations add engine `question_weighted_0_3` and question weight snapshots. Existing raw review collections are unchanged.

New collections:

- `psevaluationrevisions`: append-only raw responses, complete rubric snapshot, original rubric/scoring-config references, normalized per-question results/weights, score, notes, timestamp, revision and superseded revision ID. Unique `(round_id, applicant_id, grader_email, revision)` plus `(grader_email, round_id)`.
- `psevaluationcontributions`: unique `(round_id, applicant_id, grader_email)` with latest evaluation ID/revision, plus `(grader_email, round_id)`.

Manifest: `scripts/ps-index-manifest.mjs`. Production disables automatic index creation. Before deploying, run the existing read-only `npm run db:ps:preflight -- --database=<expected database>` and reviewed additive `npm run db:ps:apply -- --database=<expected database>`. Migration/index verification was exercised against disposable MongoDB only. Restart a running development server after schema changes because Mongoose caches registered models.

## Routes

Added stateless JSON import preview route above. Rubric draft creation/update, spreadsheet import and publication (including legacy publication) now require admin. Published/draft reads preserve leadership read access. Reviews, grading queue, enrollment counts and score results include the new revision/contribution format. Score responses add `version_scores`; existing legacy `scores` retain null/unconfigured values.

## Exact files for this increment

Added:

- `src/lib/ps/weightedRubric.ts`
- `src/app/api/ps/rounds/[id]/rubric-json/route.ts`
- `docs/ps-question-weighted-rubric-implementation.md`

Modified (including files already untracked from earlier Alex work):

- `src/app/admin/rounds/page.tsx`
- `src/app/grade/ps/page.tsx`
- `src/components/PSRubricEditor.tsx`
- `src/components/PSRubricFields.tsx`
- `src/components/PSReviewHistory.tsx`
- `src/components/PSProgression.tsx` (remove obsolete blanket scoring message)
- `src/lib/ps/api.ts`
- `src/lib/ps/models.ts`
- `src/lib/ps/records.ts`
- `src/lib/ps/rounds.ts`
- `src/lib/ps/assignmentService.ts`
- `src/lib/ps/rubricV2.ts`
- `src/lib/ps/rubricCompatibility.ts`
- `src/lib/ps/rubricDraftService.ts`
- `src/lib/ps/rubricService.ts`
- `src/lib/ps/reviewService.ts`
- `src/app/api/ps/grading/route.ts`
- `src/app/api/ps/reviews/route.ts`
- `src/app/api/ps/rounds/[id]/enrollments/route.ts`
- `src/app/api/ps/rounds/[id]/scores/route.ts`
- `src/app/api/ps/rounds/[id]/rubric-drafts/route.ts`
- `src/app/api/ps/rounds/[id]/rubric-imports/route.ts`
- `src/app/api/ps/rounds/[id]/rubrics/route.ts`
- `src/app/api/ps/rubric-drafts/[draftId]/route.ts`
- `src/app/api/ps/rubric-drafts/[draftId]/publish/route.ts`
- `scripts/ps-index-manifest.mjs`
- `scripts/ps-workflow-unit.mjs`
- `scripts/ps-workflow-integration.mjs`
- `scripts/ps-workflow-http.mjs`

## Validation

Passed TypeScript, ESLint, PS unit/integration/HTTP suites and production build. Also passed all seven legacy unit suites (security, assignments, grader stats, scoring, coffee chats, interview import, behavioral), disposable security/PS index checks, the legacy transaction race matrix and a 5-user/100-action load smoke test (100% success).

New automated coverage: equal-weight rounding, no silent rebalance, stable IDs, invalid publish/import cases, required/zero/optional responses, different-scale weighted scores, version-grouped means, round/draft isolation, immutable snapshots/revisions, concurrent updates, no duplicate counters, publication after grading, original-version updates, terminal-state guards, admin/leadership/grader authorization and JSON database-failure responses.

Browser QA used a disposable database and isolated Next app, not the developer's applicant data. Tested:

- Four round tabs, adding and renaming; round switch during held save and subsequent newer text; no cross-round contamination.
- Hidden-round failed save/retry and CAS conflict with retained local text; autosave maintains text focus and scroll.
- Two sections, instructions, mixed four-type questions, unique duplication without weights, delete/cancel, ordering, choice add/remove, interactive preview and publication.
- JSON import/export, invalid import preservation, saved reload, independent Take Home publication.
- Weighted 0/5 responses on 0–3 and 1–5 scales produce 1.20/3; update to 3 with the optional scale omitted produces 3.00/3 and still one completed grader contribution.
- Application response endpoint, required/whitespace validation, Submit & Next, authenticated grading reload, restored submitted answers and edit/update.
- New publication serves v2 to pending work while an existing evaluation opens with its original v1.
- 390px viewport for editor/import and grading, with no horizontal overflow after correcting the root flex item's width.
- Actual PS Written App (16 questions), Take Home (32) and PD (27) spreadsheet previews, plus Written App backup (12) in unit tests. No historical rows became grading submissions.

Browser evidence files: `/tmp/ps-weighted-preview.png`, `/tmp/ps-weighted-grading.png`, `/tmp/ps-weighted-mobile.png`, `/tmp/ps-weighted-editor-mobile.png`. Build/HTTP/race/load logs are in `/tmp/ps-rubric-*.log`. Deliberate HTTP 500/409 failures were tested; no unhandled browser parsing errors occurred.

## Limits and team dependencies

This implements the user's explicit weighted 0–3 round-score formula, not official PS Z-score normalization or a cross-round/final score. Official rubric wording and weights still need admin confirmation. No Google Forms API, PDF/Word extraction, invitation simulation/delivery, applicant intake, operational vouch/red-flag system, voting or final-decision changes.

Krithin's auth and application-response APIs supply identities and applicant data. Jason's decision/results integration should consume the PS review API's `is_current`/revision metadata and `version_scores` grouped by version; direct queries of only `GenericReview` omit new weighted evaluations. Existing GenericReview/V1/V2 history is preserved. Unsaved edits are retained during in-app round/cycle switches and warned before page exit; closing the browser during an unresolved save failure does not provide offline durability.
