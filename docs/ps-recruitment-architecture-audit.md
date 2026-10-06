# Product Space recruitment architecture audit

Audit date: October 5, 2026. Scope: repository source and local unit checks; no production data inspection, database migrations, secret changes, or application code changes.

Goal: administrators configure a semester's recruitment process without changing application code. Foundation success means configurable ordered rounds, N distinct eligible graders per applicant, balanced assignments, preserved raw reviews and history, and no implicit Plex scoring in new PS rounds.

## 1. CURRENT ARCHITECTURE

Next.js App Router and React client pages call route handlers under `src/app/api`. MongoDB/Mongoose models are centralized in `src/lib/models/index.ts`; browser-facing interfaces are in `src/lib/types.ts`. `connectDB()` caches connections and clears rejected promises. Many writes use transactions and lifecycle counters to fence concurrent closure, deletion, or review submission.

| Domain | Current implementation |
| --- | --- |
| Cycles | `RecruitmentCycle`: application opening, deadline, lifecycle status, configuration version, import/sync configuration. `/api/cycles` and `/api/cycles/[id]`. |
| Rounds | `Round`: cycle reference, name, `order_index`, `grading_type`, status, interview URL, legacy role. Already separate ordered documents; no need to embed an array into cycles. `/api/rounds`, `/api/rounds/[id]`, `/api/cycles/[id]/rounds`. |
| Members | Global `AuthorizedUser` allowlist with grader/leadership/admin permissions; session participation is `SessionMember`. No per-round eligible-grader configuration. |
| Applicants | `Applicant` is cycle-scoped identity/application data; `EssayPrompt` and `EssayResponse` store application questions/responses. Resumes are stored separately from ordinary query results. |
| Assignments | `GraderAssignment`: round/applicant/email, unique triple, submission counter. `buildGraderAssignments()` in `src/lib/graderAssignments.ts` generates rows in the browser; POST `/api/grader-assignments` validates and upserts transactionally. |
| Reviews | `Review`: unique round/applicant/email, ten fixed ratings, five required comments, submission timestamp. POST `/api/reviews` fences round closure and assignment removal before inserting. |
| Scoring | `evaluateResults()` in `src/lib/scoring.ts`, called from admin deliberation creation and `/api/admin/grading-stats`. Raw reviews survive scoring, but derived values have no explicit engine/version provenance. |
| Deliberations | `Session`, session-local `Candidate`, `Vote`, `CandidateNote`, `SessionMember`, `SessionBan`. A candidate can link to an applicant, or be a standalone imported row. `Candidate.data` stores mixed metadata and scores. |
| Advancement | `AdminPanel` creates a new interview round after checking accepted session candidates; it does not create next-round enrollment records. Interview imports later infer eligibility from accepted candidates in previous track sessions. |
| Imports | `interviewImport.ts`, `behavioralImport.ts`, `behavioralSync.ts`, and coffee-chat helpers/routes. Behavioral sync uses a Mongo lease and preserves existing scores on unresolved names. |
| Frontend | `/admin`: cycles, prompts, assignment generation, imports, deliberation creation. `/grade`: fixed rubric form. `/admin/grading`: statistics/reassignment. `/session/[id]`: live deliberation, votes, notes, decisions. `/apply/form`: application intake. |

Deliberation updates use polling, not a WebSocket event stream: `src/app/session/[id]/page.tsx` polls a small `/api/sessions/[id]/live` snapshot every 2–3 seconds and heavy data every 30–35 seconds while visible. Preserve the small/heavy split.

## 2. PLEX-SPECIFIC ASSUMPTIONS FOUND

### Fixed ratings and rubric semantics

- `models/index.ts` requires `r0` in 1–3, `r1`–`r9` in 1–4, and five comments. `types.ts` duplicates the fixed representation in `Review` and `EvaluatedApplicant`.
- `/api/reviews/route.ts` validates exactly ten integer ratings and five nonempty comments.
- `/grade/page.tsx`: `ESSAY_RATING_KEYS`, default ratings, submission payload, resume questions, time-commitment concern, and three-essay/two-criteria mappings.
- `/admin/page.tsx`: `startDeliberation()` writes normalized r-fields into candidate metadata.
- `/api/admin/grading-stats/route.ts`, `/admin/grading/page.tsx`, and `/session/[id]/page.tsx` enumerate ratings in payloads, tables, sort controls, score merging, and display groups. The session UI reconstructs concern ratings by multiplying normalized `r0` by 15.
- `graderStats.ts` summarizes only `r1`–`r9` on a fixed 1–4 scale.
- Test/fixture references: `scripts/scoring-unit.mjs`, `grader-stats-unit.mjs`, `loadtest.mjs`, `race-toctou.mjs`, and `behavioral-unit.mjs`. Legacy tests must remain meaningful during transition.

### Tracks, round behavior, and assignment policy

- `ApplicantRole`, Round/Session schemas and API validation allow only curriculum/developer/null. Round ordering uniqueness is `(cycle_id, role, order_index)`.
- `/api/rounds/route.ts` rejects creation if any same-track round exists at or after the requested order. PATCH changes one order at a time; it is not an atomic reorder operation.
- `/admin/page.tsx` automatically creates “Application Review” at position 1. Assignment generation draws from all globally authorized users and demands one regular plus one leadership/admin reviewer.
- `buildGraderAssignments()` balances each pool independently, producing exactly two reviews. Global workload is not necessarily balanced when pool sizes differ.
- `/api/grader-assignments/reassign/route.ts` includes pool restrictions and an explicit exactly-two-reviewers check. Preserve completed-review protection, replace these policies.
- `startDeliberation()` splits applicants into two sessions using exact `desired_roles === 'Industry Developer'`; other values fall into Curriculum. It proceeds once reviews exist, without enforcing a configurable completion threshold for each candidate.
- `AdminPanel` advancement inherits track, assumes the next round is interview, and rejects an already configured later round.
- `/api/interview-responses/import/route.ts::getEligibleApplicants()` requires a track; `behavioralSync.ts::behavioralRoster()` requires exactly one Curriculum and one Developer interview round.
- `/apply/form/page.tsx` and `/api/applicants/route.ts` restrict selected roles to Curriculum Student/Industry Developer. `/api/cycles/[id]/prompts`, cycle opening, and applicant submission require exactly three prompts with two grading criteria each.
- Other track dependencies: `BehavioralSyncPanel.tsx`, `behavioralDisplay.ts`, session API role validation/reparenting, and `coffeeChats.ts` compatibility header aliases. Aliases recognizing legacy CSVs are useful adapter behavior, not a reason to retain core track rules.

### Legacy scoring and import formulas

- `scoring.ts`: per-grader/per-criterion population Z-scores for `r1`–`r9`; `r0 / 15`; average across graders; fixed `CURRICULUM_WEIGHTS` or `DEV_WEIGHTS` selected by desired role; NaN fallback contribution and total scaling/rounding. None is established PS methodology.
- `interviewImport.ts`: fixed FA26 questions/columns; Developer criterion averages are averaged into an overall score, Curriculum criterion averages are summed; certain blank/unattempted Curriculum values become zero.
- `behavioralImport.ts`: fixed positional PlexTech form headers, fourteen criteria, latest-response-per-interviewer selection, complete-only averaging, and a named-candidate/two-interviewer no-show exception. `behavioralDisplay.ts` has fixed question text, scales, and `(13 * 4 + 6) / 14` display maximum. Existing Product Space labels do not make these generic rules.

## 3. KEEP

Keep cycle/applicant identity, application responses/resume access, authentication and permission hierarchy (`authOptions.ts`, `serverAuth.ts`), session membership/bans, votes/notes, raw review records, CSV parsing/size limits, identity-resolution previews, Mongo leases, unique assignment/review indexes, rate limits, and transaction guards.

Keep `Applicant` as canonical cycle candidate identity. Keep session-local `Candidate` for deliberation compatibility; do not rename or repurpose every existing candidate row.

## 4. REFACTOR

Refactor Round configuration, assignment generation/persistence/reassignment, admin round setup, review validation, completion tracking, candidate decision writes, and score presentation. Retain their access checks and concurrency protections.

Separate application questions from scoring criteria. Make new PS application role choices configurable/optional without erasing legacy desired-role values. Isolate existing CSV formats and corrections as explicit versioned legacy adapters.

## 5. REPLACE

Replace the new-round path's fixed review form with rubric-driven rendering; replace core track splitting and one-member/one-leader assignment policy; replace frontend advancement with transactional enrollment into the next configured round; replace implicit `evaluateResults()` calls with engine selection.

For new PS rounds, scoring is explicitly unconfigured: return null scores and an explanatory status. Do not substitute zero, average, or legacy Z-score as PS's result. Deliberation must support reviewing raw evidence without a calculated score.

## 6. DELETE

Nothing immediately. After replacements are functional, remove legacy constants, forms, automatic track splitting, and implicit legacy scoring from the PS execution path. Retain adapters and readers necessary for historical data. Move named-person corrections out of shared core logic into legacy import configuration before removing that behavior.

Replace destructive delete/re-split actions for rounds with history by archive/restrict behavior. Existing standalone session use must remain supported.

## 7. PROPOSED DATA MODEL CHANGES

Use existing snake_case conventions and matching TypeScript types.

| Model | Proposed additive changes |
| --- | --- |
| Cycle | Explicit workflow version/mode distinguishes legacy cycles from configured PS cycles; reuse configuration version for optimistic concurrency. |
| Round | `evaluation_type` registry keys initially rubric/interview/social_feedback/submission_rubric; `reviews_required`; `eligible_grader_emails`; optional immutable `rubric_version_id`; scoring engine/version/config reference; configuration version and archive marker. Preserve legacy fields. |
| CandidateRound | Unique `(round_id, applicant_id)`, cycle reference, pending/in_review/ready_for_deliberation/advanced/hold/rejected/accepted state, source enrollment, decision actor/time, and transition events. Enrollment exists before a deliberation session. |
| RubricVersion | Immutable criteria with stable criterion IDs, name, description, order, weight metadata, explicit numeric scales or rating options, and round association. Weights are data, not an automatic scoring formula. No invented criteria. |
| GenericReview | Add a separately versioned model/collection initially: round/applicant/grader, rubric version, `ratings[{criterion_id, raw_score}]`, comments, timestamps, unique round/applicant/grader key. Keep existing Review intact until compatibility readers are ready. |
| CandidateRoundScore | Separate calculated output with engine/version, rubric version, input review IDs/revisions and cohort/config fingerprint, calculation timestamp, status, nullable score, and optional criterion results. Preserve recalculation history. |

An additive collection avoids making every required legacy r-field optional before the new submission contract works. Reviews and scores share applicant/round IDs; session candidates optionally link to CandidateRound. Review counts derive from valid distinct completed reviewers; counters alone are not authoritative.

## 8. PROPOSED API CHANGES

- Extend round create/PATCH with configuration validation and explicit legacy/new workflow dispatch. Reject unsupported evaluation handlers without pretending they are implemented.
- Add atomic cycle round reorder accepting the full ordered round IDs and expected configuration version. Validate membership/uniqueness; guard active history from semantic reorder. Use a collision-safe transaction strategy for unique positions.
- Add round assignment preview/generate endpoint. Server loads eligible round enrollments, graders, existing assignments and completed reviews, then validates and commits the plan in one guarded transaction. Existing row POST cannot bypass eligible-grader or N-review constraints.
- Add rubric-version and generic-review endpoints validating unique criterion IDs, complete required ratings, allowed raw values, round enrollment, assignment ownership, immutable rubric association, and round state.
- Add transactional round decision/advance endpoint. Find the next configured round by order, upsert one enrollment, record the source decision/event, and preserve prior evidence. Retrying must not create duplicates. Final acceptance is distinct from advancement; HOLD is not automatically advanced.
- Add protected candidate history endpoint joining applicant, enrollments, reviews, scores and decisions. Route existing linked-session decisions through the same canonical service.
- Extend scoring/statistics endpoints to expose unconfigured/scored state and provenance; keep legacy adapters explicit. Normalize database failures to JSON and add checked-fetch/error states to affected pages.

## 9. PROPOSED UI CHANGES

Foundation admin UI: create/name/reorder rounds, choose evaluation type, select eligible graders, set reviews required, preview workload, and see rubric/scoring configuration status. Assignment generation is disabled with a concrete reason when N exceeds the eligible pool or configuration is incomplete.

Grading UI: dynamic rubric criteria only when configured; otherwise show a setup state. Preserve queue progress and lazy resume loading. Deliberation shows raw evidence and “Scoring not configured” without fabricated rankings; advancement previews the existing target round. Keep current voting/focus/notes behavior.

No sophisticated social, take-home, analytics, rubric-authoring, or conflict UI in this foundation. Adding evaluation identifiers does not imply these complete experiences exist.

## 10. MIGRATION RISKS

- Track rounds can share orders. Do not drop the role-scoped unique index or flatten historical tracks without a reviewed mapping. Add PS-specific uniqueness only after classifying workflow mode and preflighting duplicates.
- Repeated existing assignment generation upserts rows but can add extra graders after user/order changes. Generic generation must preserve completed assignments, calculate deficits, and reject overfilled/ineligible historical sets for explicit resolution. Fresh unrestricted assignment load spread should be at most one; frozen history/exclusions may prevent that and require reporting.
- Legacy session `accepted` can mean passed a round or final acceptance. Do not infer final decisions during backfill. Unlinked standalone candidates cannot be safely joined by name.
- Candidate metadata contains score snapshots; the session page also overlays recalculated legacy scores. Both readers must dispatch by workflow/engine to avoid silently overwriting PS or historical outputs.
- Generic review addition needs coordinated statistics, grade queue and authorization readers. Separate uniqueness indexes do not prevent cross-format duplication without a guarded submission service.
- Reordering, N changes, eligibility changes, rubric changes and closure must conflict with in-flight generation/submission/advancement. Freeze or version configuration once evidence exists.
- Round/cycle DELETE currently cascades reviews, candidates, votes and notes. Session re-splitting also discards evidence. Archive/restrict used workflow records before relying on permanent history.
- Existing application-opening prerequisites couple intake to legacy grading. Decouple only in the new workflow, preserving legacy intake behavior.
- Test scripts transpile selected modules rather than proving end-to-end Mongo transactions. Add focused service/integration coverage; do not claim existing suites validate generic progression.
- Do not run index/migration scripts against a database during this audit. `scripts/migrate-security-indexes.mjs` provides a useful preflight/apply pattern; production automatic index creation is disabled in `mongodb.ts`.

## 11. IMPLEMENTATION ORDER

1. Add workflow discrimination and generic Round fields/types/validation, ordered-round admin setup, atomic ordering, and configuration states. Preserve legacy paths.
2. Add per-round eligibility and N configuration. Refactor the deterministic assignment builder to use one normalized, stably ordered pool. For fresh assignments, rotate a global grader cursor for N distinct assignments per applicant. Keep existing records fixed on reruns; plan deficits server-side and report conflicts.
3. Add CandidateRound enrollment and history events, then wire assignment eligibility to enrollments. First-round enrollment derives from cycle applicants; later rounds derive from explicit advancement.
4. Implement idempotent progression to the next configured round and synchronize linked deliberation decisions; protect history from destructive actions.
5. Add immutable generic rubrics/reviews and dynamic grading, leaving PS rubrics unconfigured until supplied. Keep legacy readers and raw fields.
6. Add scoring interface and provenance model; register only explicit legacy scoring for legacy rounds. PS scoring remains unconfigured until its actual specification arrives. Remove new-workflow dependence on scores when opening deliberation.
7. Switch new PS deliberation to canonical enrollment/raw evidence; retire implicit track splitting. Isolate FA26 import adapters and complete optional preflight/backfill work.

Focused acceptance tests: 120 applicants × 3 reviews / 12 graders gives 360 assignments and 30 per grader; uneven divisions differ by at most one for fresh unconstrained plans; N unique eligible graders per applicant; normalization/determinism; impossible N rejected; reruns never alter completed reviews; concurrent generation/submission protected; unique ordered rounds; advancement retries idempotent; final-round and HOLD behavior; previous reviews/decisions remain intact; unconfigured scoring never calls legacy formulas.

### Local baseline verification

Typecheck, lint, and all seven unit suites passed: security, assignments, grader statistics, scoring, coffee-chat import, interview import, and behavioral import. These verify existing legacy behavior, not the proposed foundation. Lint passed when rerun separately after its initial concurrent scan encountered a removed test temporary directory. No DB-backed race/load/index checks or production build were performed for this documentation-only audit.
