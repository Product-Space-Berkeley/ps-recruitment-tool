# Alex PS rubric V2 implementation and validation

Implemented October 5, 2026 on `alex/rounds-grading`. No commits, pushes, branch changes, resets, stashes, or removal of existing work. The existing V1 implementation, assignment/progression guards, checked-fetch behavior, and legacy/auth/deliberation responsibilities are preserved.

## Delivered workflow

XLSX/CSV or previous published rubric → canonical client preview → admin-confirmed persistent draft → manual editing → categories and category percentages → grader preview → transactional publish/assign → typed raw grading → Submit & Next → reload/history.

Import is structure-only. Upload bytes and historical rows are never written to disk or MongoDB by the application. There is no import-preview collection. Import-preview answers also remain client-only. Only explicitly confirmed drafts are persisted. Header-only templates and response workbooks produce the same preview shape; bounded observed numeric/Yes-No values can suggest configuration but do not become reviews. Free-text historical examples are not returned or stored.

All imported questions remain unconfirmed, with required status unknown. Publication requires explicit confirmation of purpose, response format, scales/options and required status. The observed range is not treated as the full official scale. Similar/duplicate headers remain separate questions with source column provenance; long labels are preserved.

## Exact file inventory for this implementation

This inventory describes this V2 change, not the earlier uncommitted Alex implementation already present at the start.

Added:

- `src/lib/ps/rubricV2.ts` — canonical types, publication/weight validation, typed raw response validation.
- `src/lib/ps/rubricCompatibility.ts` — V1/V2 discrimination and nonmutating copy projection.
- `src/lib/ps/rubricImport.ts` — stateless bounded XLSX/CSV parsing, structure preview and upload validation.
- `src/lib/ps/rubricDraftService.ts` — draft creation/copy, revision CAS, transactionally immutable publication.
- `src/components/PSRubricFields.tsx` — shared typed grader/preview rendering.
- `src/app/api/ps/rounds/[id]/rubric-imports/route.ts`
- `src/app/api/ps/rounds/[id]/rubric-drafts/route.ts`
- `src/app/api/ps/rubric-drafts/[draftId]/route.ts`
- `src/app/api/ps/rubric-drafts/[draftId]/publish/route.ts`
- `docs/alex-ps-rubric-v2.md` — this handoff.

Modified:

- `package.json`, `package-lock.json` — pinned ExcelJS 4.4.0; ExcelJS UUID override to 11.1.1. No framework/auth version changes.
- `src/lib/ps/models.ts` — additive V2 fields, drafts and immutable scoring snapshots.
- `src/lib/ps/reviewService.ts` — version-matched V2 typed review submission, preserving raw values/comments.
- `src/lib/ps/scoring.ts` — typed/raw compatibility at the existing unconfigured scoring boundary.
- `src/lib/ps/records.ts` — serialization of the new version/draft/configuration references.
- `src/lib/ps/client.ts` — checked multipart upload support without overriding the browser boundary.
- `src/components/PSRubricEditor.tsx` — saved drafts, structure upload/confirmation, editing, ordering, category moves, category weights, cross-cycle version copying, preview and publication.
- `src/components/PSReviewHistory.tsx` — V1 ratings and category-grouped V2 typed raw evidence, using the exact historical version.
- `src/app/grade/ps/page.tsx` — V1/V2 grader rendering and typed submission; existing queue/error/reload safeguards retained.
- `scripts/ps-index-manifest.mjs`, `scripts/ps-indexes.mjs` — additive indexes and partial-index-aware duplicate preflight.
- `scripts/ps-workflow-unit.mjs`, `scripts/ps-workflow-integration.mjs`, `scripts/ps-workflow-http.mjs` — V2 regression coverage, optional supplied-material verification, isolated browser and legacy validation fixtures.

## Database and index additions

New collections:

- `rubricdrafts`: round, schema_version 2, revision, editing/published status, categories/questions, weighting, source/copy provenance, authors/timestamps, published version reference. Index `{ round_id: 1, status: 1, updated_at: -1 }`.
- `rubricscoringconfigurations`: immutable rubric/version reference, category basis-point weights, weighting status and engine `unconfigured`. Unique index `{ rubric_version_id: 1, version: 1 }`.

Additive fields on existing collections:

- `rubricversions`: optional schema_version, V2 categories/questions/weighting, source_draft_id and scoring_configuration_id. Unique partial `{ source_draft_id: 1 }` index restricted to ObjectId values. Old missing/null source IDs do not collide.
- `genericreviews`: optional schema_version and typed `responses` containing question_id, format and exact raw value. Existing review uniqueness and rubric-version references remain.

Publication uses the existing cycle → round lock ordering, then draft revision/status checks. The rubric snapshot, scoring snapshot, active round reference and published-draft marker commit in one transaction. Retried/concurrent publication returns the same published version. Versions, scoring snapshots and raw reviews reject update/delete/replacement/nested-array/bulk mutation through the models. Submitted reviews retain the existing round-rubric freeze.

No actual development/Atlas database migration was applied during this work. Replica-set tests use disposable local databases. Development keeps its existing automatic index behavior. Production remains an explicit additive index rollout: `npm run db:ps:preflight -- --database=<exact database>` followed by the existing reviewed `db:ps:apply` procedure before deploying.

Restart an already-running dev server once after this schema change; Mongoose's existing model cache retains old schemas across hot reloads.

## API contracts

New leadership-protected routes:

| Route | Methods | Behavior |
| --- | --- | --- |
| `/api/ps/rounds/[id]/rubric-imports` | POST multipart | Parse one file, return nonpersisted canonical preview; optional visible worksheet name. |
| `/api/ps/rounds/[id]/rubric-drafts` | GET, POST JSON | List drafts; persist confirmed structure/manual draft or copy a published version. |
| `/api/ps/rubric-drafts/[draftId]` | GET, PATCH JSON | Read or update an editing draft with revision CAS. |
| `/api/ps/rubric-drafts/[draftId]/publish` | POST JSON | Validate, snapshot and assign using draft revision and round configuration_version. |

Existing `/api/ps/reviews` accepts V1 ratings or schema_version 2 typed responses matching the active rubric; actor ownership, eligibility, enrollment, duplicate and lifecycle guards are unchanged. Existing `/api/ps/grading` and rubric/history readers serialize either schema. The existing V1 publication/assignment route remains available for compatibility. No auth/intake/operational decision routes were changed by V2.

## Compatibility and scoring boundary

Missing schema_version means V1. No historical RubricVersion or GenericReview is migrated, replaced or rewritten. Old numerical criteria, scales/options and raw ratings continue to render and validate. Copying a V1 rubric creates a new V2 draft without changing the source; old per-criterion weights do not turn into invented category percentages.

V2 purposes: SCORED_CRITERION, PENALTY, BONUS, QUALITATIVE, DECISION_SIGNAL, RED_FLAG. Purpose and format are independent. Formats: number, numeric_choice, single_choice, multiple_choice, boolean, short_text, long_text, url. Optional omitted responses remain absent; zero, false, arrays and exact text remain distinguishable. HTTP(S) URLs and scale steps/options are validated on the server.

Categories and questions have stable IDs and configurable order; questions can move between categories. Weights use integer basis points, displayed as percentages. Only categories containing SCORED_CRITERION fields receive weights. Configured weights must total 100% on publication; an explicitly unconfigured/null-weight rubric can publish for raw grading. Drafts can save incomplete configured totals during editing.

Category weights are configuration only. Official PS scoring remains unconfigured and all candidate scores remain null. No weighted candidate total, numerical bonus/penalty/flag effect, Z-score or PlexTech calculation exists. RED_FLAG and DECISION_SIGNAL answers are evidence only; they do not reject, advance, vote or accept. Existing readiness after N reviews remains distinct from human progression.

## Import behavior and limitations

- XLSX and UTF-8 CSV only. No archive uploads, XLS, PDF, images, macros, external links, formulas or Google Forms API.
- Actual upload bound 3 MB; multipart envelope bounded separately. XLSX central directory and actual bounded inflation checked before ExcelJS; at most 512 entries and 24 MB expanded content.
- At most 2000 rows, 200 columns, 200 questions, 50 categories; labels up to 4000 characters. The first row must contain nonempty text headers. Export a header-only/values-only sheet for larger workbooks.
- Multi-sheet workbooks require a visible worksheet name. Duplicate headings are not merged; branching relationships and categories are not invented.
- Identity, timestamp, academic-grade, administrative and historical-total columns appear in the excluded-column preview. Interview-note URLs remain qualitative evidence questions.
- Known application-intake and operational vouch/red-flag source filenames are rejected as outside Alex's scope. Administrators must review headings and purposes before publishing any grading structure.
- No free-text historical samples, grader/candidate identities or submitted-response rows are persisted by import. Source provenance stores only file metadata/fingerprint and question-heading/column information.

Verified supplied materials:

| Workbook | Questions | Excluded columns | Evidence |
| --- | ---: | ---: | --- |
| FA26 Written App Scoring Form (Responses) | 16 | 5 | Similar heading blocks preserved separately. |
| FA26 Take Home Scoring Form (Responses) | 32 | 6 | 237-character heading preserved; interview-note URL retained. |
| TEST PS FA26 PD Scoring Form (Responses) | 27 | 6 | Duplicate disagreement headings retain column-16 and column-20 IDs; URL evidence retained. |
| Written App Grading Backup | 12 | 9 | Numeric/Yes-No suggestions only; no historical response ingestion. |

The first three files were tested through real browser uploads and saved draft reloads. The backup was parsed directly from the supplied archive in unit verification without creating response files on disk.

## Validation results

Passed:

- `npm run typecheck`
- `npm run lint`
- `npm run test:ps` including XLSX/CSV bounds/privacy, all typed response formats, false/zero, required/optional, category weights, V1 compatibility and checked JSON/multipart fetching.
- Supplied-material extension: `PS_MATERIALS_ZIP='<supplied archive path>' npm run test:ps`.
- `npm run test:ps:integration`: disposable replica set, draft revision races, concurrent/idempotent publication, atomic scoring/rubric snapshots, raw-value persistence, nested immutability, V1 copy/history, lifecycle/review/progression guards.
- `npm run test:ps:http`: isolated Next application and disposable database; upload auth/origin/type/error responses, preview nonpersistence, draft conflicts/publication, typed raw grading, evidence/scoring boundaries and existing sessions/database-failure contracts.
- All seven legacy unit suites: security, assignments, grader-stats, scoring, coffee-chats, interview-import, behavioral.
- Legacy index verification across 17 collections and PS additive index preflight/application on disposable data, complete race matrix with create fanout 5 / state repetitions 2 / activity repetitions 2 / import size 100, plus smoke load 5 concurrent users × 20 actions: 100/100 successful, p95 143 ms, p99 184 ms (final run). Disposable data only; this is not a production-scale load certification.
- `npm run build`: production webpack build, TypeScript and all routes successful.

Browser QA on a fresh isolated server:

- All three real source imports, canonical previews, confirmation and saved drafts.
- Written App field editing/confirmation, category creation/moves, 100% test category configuration, save, reload, grader preview, publish and assignment generation.
- Three candidate submissions with Submit & Next, authenticated reload, progress 3/3, caught-up state after reload.
- Injected review failure retained the entered zero; injected queue failure after successful save disabled resubmission until refresh.
- Stored raw responses include `[0, false]` and `[3, true]`; exact comment whitespace preserved. All candidate states remained ready_for_deliberation and all official scores remained null.
- Cross-cycle V1 copying produces numeric and numeric-choice questions; V1 history still displays original 3.5/10 values. V2 history groups evidence by its original categories/version.
- Mobile preview/history checked at width 390; no horizontal overflow. No browser runtime exceptions from the application.

Browser numeric scales/weights are explicitly test configuration, not an assertion of the official PS rubric.

## Remaining inputs, risks and team dependencies

PS must supply/confirm actual form choices, required flags, numerical scales, category boundaries/percentages, branch relationships and canonical rubric definitions; the supplied response sheets do not establish these completely. Admin confirmation prevents those gaps from becoming silently official configuration. PS must separately specify the official score and Z-score methodology before a scoring engine is implemented.

Google Forms API integration, historical-response migration, speculative scorer plugins and any automatic decision effects remain unimplemented. Krithin continues to own application/auth/access; Jason continues to own operational vouch/red flags, interview operations, deliberation/voting and final decisions. Their integration can consume immutable versioned evidence without changing raw submissions.

Additional dependency audit still reports vulnerabilities in the existing Next.js/tooling graph; the newly introduced ExcelJS UUID advisory was removed with the targeted override. Dependency upgrades require a separate deployment review; this implementation did not change Next.js or auth versions. The required code/test/build gates above pass, but this is not a clean dependency-audit claim.
