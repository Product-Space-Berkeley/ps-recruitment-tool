# Alex: rounds, rubrics, grading and progression

Implemented October 5, 2026. Configuration is managed on the website; no PS criteria or scoring formula are supplied by this implementation.

Follow-up inspection and corrections are recorded in [Alex's PS gap analysis](alex-ps-gap-analysis.md). They protect nested rubric/raw-review history, include frozen assignments in balancing, enforce cycle/round lifecycle and grader eligibility, and make setup controls reflect server lock state.

## Website workflow

Open `/admin/rounds` from **PS Round Setup** on the dashboard. Existing leadership/admin permissions apply. The grader source reads AuthorizedUser email/role fields; it does not grant or change authorization.

1. Choose a cycle or create one using the existing cycle API.
2. Add named rounds with evaluation type, eligible graders and reviews required. Reorder before enrollment begins. These are arbitrary names and counts, not a fixed four-stage pipeline.
3. Configure a rubric with team-supplied criteria, scales/options and optional weight metadata. Publish creates and assigns an immutable version. Existing versions can be assigned or copied into a new version; a rubric can also be duplicated from another round in the selected cycle.
4. Preview assignments, inspect per-grader workload and generate. Generation automatically enrolls cycle applicants in the first active configured round. Enrollment is also available as an explicit action. Later rounds accept only explicit CandidateRound enrollments.
5. Graders use `/grade/ps`. The form renders the assigned rubric and stores raw ratings and its version. Application responses and resumes use existing protected read APIs. No configured rubric means “Rubric not configured,” with no legacy fallback.
6. Leadership can transfer pending assignments to another selected eligible grader. Completed work and duplicate applicant/grader pairs are rejected. Manual transfers may change workload balance.
7. For nonfinal rounds, use Advance/Hold/Reject under Enrollment and progression. Advance upserts enrollment into the next nonarchived PS round by order. Hold and Reject do not create enrollment; repeated Advance preserves the same target and history. An advanced/rejected enrollment cannot be reversed in this foundation; Hold can later advance or reject.
8. View raw grading history per round. PS score outputs are explicitly `unconfigured` with `score: null`. Final-round decisions remain with Jason's existing workflow.

Archive/restore is restricted to rounds without enrollment, assignments, sessions or review evidence. Reordering and grading configuration freeze after activity begins. Names remain editable. Rubric replacement is permitted until the first review; subsequent changes require a future round. Ending a round makes grading/progression read-only while preserving evidence. Cycle closure still uses the existing infrastructure.

The setup page reports configuration/rubric locks and disables unavailable actions. Refresh configuration preserves the selected cycle/round and reloads their state. Enrollment refreshes after generation; only the first configured round offers cycle enrollment. Graders can refresh their queue after load failures. Only grading rounds in active cycles where the grader is selected appear in that queue.

## Storage and service boundaries

- Existing Round gains additive `workflow`, `evaluation_type`, `reviews_required`, `eligible_grader_emails`, `rubric_version_id`, `scoring_engine`, `configuration_version`, and `archived` fields. Old rounds default to legacy; no old data is rewritten.
- New models are isolated in `src/lib/ps/models.ts`: CandidateRound, immutable RubricVersion, immutable GenericReview, and the future calculated-output CandidateRoundScore.
- RubricVersion and GenericReview reject model updates/replacements/deletions, modified saves, and noninsert bulk operations. Nested fields are also immutable. New published versions/submissions are inserts; earlier raw evidence is never overwritten.
- Services live in `src/lib/ps/`. Every PS mutation locks the active cycle and round in a Mongo transaction. Assignment generation also guards authorized-user updates; submissions guard assignment ownership and rubric association.
- Assignment generation preserves **all** existing assignments, not just completed ones. A changed or incompatible historical set returns a conflict rather than deleting/rebalancing evidence. Fresh unconstrained generation differs by at most one assignment per grader. Preview tokens detect stale enrollments, review completions and configuration changes.
- Advanced/held/rejected candidates' frozen assignments count toward workload when distributing new work, but those candidates receive no new assignments. Preview and generation require an active cycle and a pending/grading round; they cannot reopen deliberation.
- Round PATCH rejects unknown settings and requires a valid configuration version. Ordering and rubric changes use their dedicated endpoints. Website lock flags are read-only metadata, not stored configuration.
- The scoring interface accepts raw reviews, rubric and configuration context. No new PS module imports `evaluateResults()`. The score model exists for future versioned outputs; current unconfigured score responses are read-only and do not write fake calculation records.
- Template import has a parser interface and a UI entry point. It explicitly rejects imports until a reviewed PS parser is supplied. No uploaded code is executed.

## APIs

All routes below use existing requireRole checks and return JSON errors.

| Endpoint | Purpose |
| --- | --- |
| `/api/ps/cycles/[id]/rounds` | Leadership GET list; POST create; PATCH atomic reorder with cycle version |
| `/api/ps/graders` | Leadership read-only authorized-user selection source |
| `/api/ps/rounds/[id]` | GET round; leadership PATCH settings/archive/end with round version |
| `/api/ps/rounds/[id]/assignments` | Leadership GET preview; POST commit the preview |
| `/api/ps/rounds/[id]/reassign` | Leadership GET pending work; POST guarded transfer |
| `/api/ps/rounds/[id]/enrollments` | Leadership GET enrollments/history/next round; POST enroll/advance/hold/reject |
| `/api/ps/rounds/[id]/rubrics` | Leadership GET immutable versions; POST publish or assign |
| `/api/ps/grading` | Current grader's pending assignments and active rubric/application summaries |
| `/api/ps/reviews` | GET raw reviews (graders see their own); POST assignment-owned immutable submission |
| `/api/ps/rounds/[id]/scores` | Leadership GET explicit null/unconfigured scoring outputs |

## Shared-file compatibility and team handoff

Likely merge-conflict files: `src/lib/models/index.ts`, `src/lib/types.ts`, admin/dashboard/grade page navigation, and the existing round/cycle/assignment/review/statistics routes. Changes there are additive fields, navigation/filtering, and small PS guards.

- Legacy admin and grading screens exclude PS rounds and link to the separate new pages.
- Legacy round PATCH/DELETE refuses PS rounds. Cycle DELETE refuses cycles containing PS rounds; cycle closure remains available. The cycle deletion transaction now touches its parent to conflict with concurrent creation.
- Legacy assignment POST and reassignment refuse PS rounds, preventing bypass of N/eligibility rules. Legacy review POST refuses PS rounds; existing legacy Review remains untouched.
- Legacy grading-statistics GET refuses PS rounds before invoking its scorer. Existing session score merging already checks response success, so no session UI change was needed.
- No authentication, access administration, intake fields/forms, interview/behavioral imports or sync, voting, session UX, or final-decision implementation was changed.

Jason can read CandidateRound enrollment/state through the new enrollment API and reuse its applicant/round IDs to connect session candidates. Final-round Advance/Hold/Reject actions are intentionally refused by Alex's endpoint; a final-decision integration is Jason's responsibility. Krithin can continue creating applicants as before; first-round enrollment consumes that model without modifying submission logic.

Existing legacy cycles are not auto-converted. PS rounds form their own ordered sequence in a cycle; on a mixed cycle they occupy positions after existing legacy rounds. Administrators should create a new cycle for a clean PS workflow. Historical tracks, reviews and imports retain their old behavior.

## Deployment and verification

Restart `npm run dev` after schema changes so the Mongoose model cache reloads. Production automatic index creation is already disabled in this project. Before deploying, use the additive PS index preflight/apply scripts against an explicitly named database:

```sh
npm run db:ps:preflight -- --database=YOUR_DATABASE_NAME
npm run db:ps:apply -- --database=YOUR_DATABASE_NAME
```

These scripts create only new PS indexes, do not drop legacy indexes, and reject duplicate unique keys. They are engineering deployment steps; semester-specific round settings remain website configuration. No real database migration/index apply was run during implementation.

Checks:

```sh
npm run typecheck
npm run lint
npm run test:ps
npm run test:ps:integration
npm run test:ps:http
npm run build
```

Integration tests use mongodb-memory-server and an automatically cleaned disposable local replica set. HTTP tests additionally start an isolated app copy using the existing dev test-auth mechanism; they never load the developer's .env or connect to Atlas. The first run may download a MongoDB binary. Unit tests cover exact/uneven balancing, distinct eligible assignments, ordering, progression rules, variable criteria, rating validation and unconfigured scoring. Database tests cover immutable raw data/rubrics, enrollment/advancement retries and concurrency, history preservation, completed-review protection and reassignment. HTTP tests cover actual route authorization, JSON failures and legacy-bypass guards. Existing legacy suites remain applicable to their legacy paths.

Deferred by scope: actual PS rubric template/parser, actual PS Z-score engine, specialized social/submission experiences, and Jason's final-decision/session integration.
