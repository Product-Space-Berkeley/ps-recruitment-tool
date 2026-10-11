# Alex PS end-to-end QA and polish

Completed October 5, 2026 on the running `http://localhost:5173` application and the development database `ps_recruitment_dev`.

## Workflow tested through the website

Created a clearly labeled development cycle in `/admin/rounds` and configured, in order:

1. Resume Screening
2. Behavioral / Technical Interview
3. Social Round
4. Final Take-Home

Used the website to select graders, change review counts, reorder rounds before activity, create/copy/publish rubrics, reorder criteria, set numeric scales and labeled options, persist optional weights, preview/generate assignments, inspect raw reviews, and choose human round decisions.

The primary cycle used six synthetic applicants, three graders and two reviews per applicant. Resume Screening generated twelve assignments, balanced four per grader. All twelve reviews were submitted through `/grade/ps`, one candidate at a time. The next candidate appeared after submission; completed assignments stayed absent after refresh and browser reload. A second grader retained their independent assignment after the first grader submitted. All six candidates reached two submitted reviews, with distinct review records and grader identities. Duplicate review submission returned 409.

Tested resume retrieval, PDF opening in a new tab, profile details, application responses, rubric order/options/scales, valid zero ratings, comments, round progress and completion states. The mobile viewport was 390 × 844; desktop was 1200 × 900. Both grading and round setup had no horizontal document overflow. One candidate form was visible at a time.

Injected browser-local API failures without interrupting MongoDB or changing server credentials: queue refresh failure, review submission failure, and successful review submission followed by queue refresh failure. Errors were readable, drafts survived failed submission/refresh, and a saved review stayed disabled until retry restored the queue. No uncaught page runtime exceptions occurred in the successful workflow or failure/recovery checks. Isolated HTTP tests separately exercised actual server database-failure responses.

After all Resume Screening reviews completed, the next round still had zero enrollments. Through the website, explicitly advanced Candidate 1, held Candidate 2, and rejected Candidate 3. Only Candidate 1 entered the next round. Repeating Advance returned the existing result without another enrollment or another advance event.

Candidate 1 then completed two browser-submitted reviews in each of Behavioral / Technical Interview, Social Round, and Final Take-Home. Each intermediate human Advance created exactly one enrollment in the configured next round. Final Take-Home remained ready for human review, exposed no advancement controls, and rejected an Advance API request with 409. There was no fifth round, calculated score, legacy Candidate record, or final acceptance decision.

Compared the twelve Resume Screening review responses and original rubric response before and after progression and a future Final Take-Home rubric change: both were byte-for-byte unchanged under JSON serialization. History retained the earlier enrollments and explicit decisions. Rubric publication/assignment after reviews was rejected with 409. A future round accepted a new four-criterion version with changed weight metadata while preserving previous versions and earlier reviews.

The scoring API returned `status: unconfigured` and `score: null` for every tested enrollment. Source inspection confirmed the PS score endpoint calls only `unconfiguredScores`; it imports no Plex scoring and writes no advancement. Grader identities, rubric version IDs, criterion IDs/raw scores and criterion weights remain available for a future PS engine.

## Defects and targeted fixes

| Finding | Correction |
| --- | --- |
| Round settings, rubric, progression and history siblings reused React keys. Creating/switching rounds produced duplicate-key errors and stale panels. | Give each sibling panel a distinct key prefix; verified one settings panel and no duplicate-key console errors after switching. |
| Grading progress showed a global completed count without a per-round denominator. Same-named rounds from different cycles lacked context. | Return per-round total/completed/pending counts and cycle name; show current cycle/round and `completed / total` progress. |
| Submit button did not communicate the next-candidate behavior, and completion text was minimal. | Use `Submit & Next`, explicit saved-review recovery and a useful no-assignments-remaining state. |
| The existing application response contained profile details that the PS form discarded. | Display the authorized response's applied role, transfer status, links and information sessions alongside responses. |
| Inline PDF framing was blocked by existing CSP/X-Frame-Options; visual inspection showed a failed browser frame. | Remove the broken frame; provide an authenticated new-tab PDF link. Verified the opened PDF endpoint returned 200, application/pdf and a valid PDF signature. Security headers and access policy are unchanged. |
| Advancement UI exposed storage-state wording without the required-review count. | Show `Ready for human review`, submitted/required review counts and an explicit human-decision reminder. |

Queue refresh now has a busy state and preserves the current form while fetching. Rating/comment fields are disabled while submitting or after a saved review awaiting refresh. Weights remain visibly labeled metadata with scoring unconfigured. These changes preserve existing data and permission rules.

Application files changed in this QA pass:

- `src/app/admin/rounds/page.tsx`
- `src/app/grade/ps/page.tsx`
- `src/components/PSProgression.tsx`
- `src/app/api/ps/grading/route.ts`
- `src/app/api/ps/rounds/[id]/enrollments/route.ts`
- `scripts/ps-workflow-http.mjs` — regression assertions for round/cycle context, progress, review counts, pending removal and no automatic enrollment.

No authentication, permission, applicant-intake, interview-import, deliberation/voting, or final-decision implementation was changed.

## Development-only records left for inspection

These records are deliberately retained for manual QA. No pre-existing recruitment records were changed or deleted, and no production database was used. All rubrics/criteria are labeled TEST ONLY and are not an official PS rubric.

| Cycle | ID | Purpose/current state |
| --- | --- | --- |
| DEVELOPMENT ONLY - Alex QA 2026-10-05 | `6ac36b0a23cdd4d01ad37efe` | Completed multi-grader/history/progression QA; Candidate 1 is ready for human review in Final Take-Home. |
| DEVELOPMENT ONLY - Alex QA Practice 2026-10-05 | `6ac3718b23cdd4d01ad37f55` | Dev-login practice queue: one of four Resume Screening reviews saved, three pending for dev-admin@example.test. |

| Cycle | Round | ID |
| --- | --- | --- |
| Primary QA | Resume Screening | `6ac36b6423cdd4d01ad37f02` |
| Primary QA | Behavioral / Technical Interview | `6ac36be123cdd4d01ad37f03` |
| Primary QA | Social Round | `6ac36be223cdd4d01ad37f04` |
| Primary QA | Final Take-Home | `6ac36be323cdd4d01ad37f05` |
| Practice | Resume Screening | `6ac3718c23cdd4d01ad37f56` |
| Practice | Behavioral / Technical Interview | `6ac3718e23cdd4d01ad37f58` |
| Practice | Social Round | `6ac3719023cdd4d01ad37f5a` |
| Practice | Final Take-Home | `6ac3719223cdd4d01ad37f5c` |

Primary applicant IDs, in Candidate 1–6 order:

- `6ac36c73540270a6809ac61e`
- `6ac36c73540270a6809ac61f`
- `6ac36c73540270a6809ac620`
- `6ac36c73540270a6809ac621`
- `6ac36c73540270a6809ac622`
- `6ac36c73540270a6809ac623`

Their emails are `alex-qa-20261005-a1@example.test` through `alex-qa-20261005-a6@example.test`. Practice applicants use `alex-qa-practice-20261005-a1@example.test` through `alex-qa-practice-20261005-a4@example.test`; IDs are `6ac371c8c2ef9064e2a15a3c`, `6ac371c8c2ef9064e2a15a3d`, `6ac371c8c2ef9064e2a15a3e`, `6ac371c8c2ef9064e2a15a3f`.

Created synthetic authorized grader records through the existing API:

- `alex-qa-20261005-g1@example.test` — `6ac36b4223cdd4d01ad37eff`
- `alex-qa-20261005-g2@example.test` — `6ac36b4223cdd4d01ad37f00`
- `alex-qa-20261005-g3@example.test` — `6ac36b4223cdd4d01ad37f01`

Registered the existing dev-login identity `dev-admin@example.test` as an authorized admin record (`6ac3718a23cdd4d01ad37f54`) through the existing API so it can be selected as an eligible grader. Its existing development-login role was already admin. Practice future rounds select that identity only, with one review required. Practice Resume Screening initially balanced assignments between that identity and QA Grader 3; two pending assignments were transferred through the website so all four are available to dev login. Completed-work transfer was rejected with 409, and regeneration added zero duplicates.

Cycles, rounds, authorized users, prompts, rubrics, assignments, decisions and reviews used existing website/API paths. Synthetic applicants/PDFs/responses were inserted only into the new guarded development cycles because the intake API requires verified applicant OAuth. Their identity-verification fields remain null; they are not represented as verified submissions. Multi-grader browser tests used short-lived locally signed sessions for the synthetic authorized identities; actual Google OAuth was not tested or changed. Temporary session files were removed after QA.

Combined fixture footprint: two cycles, eight rounds, ten applicants, six prompts, thirty responses, ten rubric versions, thirteen CandidateRound records, twenty-two assignments and nineteen raw reviews. Calculated-score records and legacy Candidate records for these applicants: zero. The development PS uniqueness indexes for enrollments, raw reviews and rubric versions were verified present.

## Scope status and blocked inputs

| Alex area | Status | Notes |
| --- | --- | --- |
| Cycle/round setup | COMPLETE | Four stages configured, ordered and editable through the website before activity. |
| Grader configuration | COMPLETE | Eligible identities and review counts configured through the website; structural settings freeze after activity as designed. |
| Assignment balancing | COMPLETE | Exactly N distinct graders; four reviews per grader in the primary cycle; pending transfers/regeneration verified. |
| Grading queue | COMPLETE | One candidate, Submit & Next, progress, saved reviews, reload, error/retry and completion tested. |
| Rubric architecture | COMPLETE | Variable criteria/order, scales/options, versioning and immutability tested. Official content/template still required. |
| Rubric weights | COMPLETE | Stored/displayed as metadata; no unsupported calculation. |
| Raw review preservation | COMPLETE | Separate immutable raw reviews, grader identities, comments and version references preserved across progression. |
| Scoring architecture | COMPLETE | Separate calculated-output model and versioned engine input interface retain necessary raw information. |
| PS Z-score | BLOCKED | Actual normalization population, harshness/generosity adjustment, aggregation/weighting, edge cases and engine version rules are not supplied. |
| Results presentation | COMPLETE | Raw history, review completion and explicit unconfigured/null scoring shown. Calculated/ranked results depend on the missing PS scoring methodology. |
| Human advancement | COMPLETE | Explicit Advance/Hold/Reject only; no score threshold or automatic next enrollment. |
| Round transitions | COMPLETE | All four stages, ordering, retry idempotency and historical preservation verified. |
| Final-round handoff | COMPLETE | Alex's enrollment/grading/history boundary works; no nonexistent next round or final acceptance decision. |

Official PS rubric/template and its import format remain blocked inputs. Test rubrics must not be used for real recruitment. PS Z-score implementation and calculated results remain blocked on the actual methodology. Specialized interview/import/deliberation and final acceptance behavior are deferred to Jason as requested; his integration must consume the PS enrollment/review/rubric information without treating it as legacy Plex scoring. Krithin remains responsible for real verified applicant intake and member authentication/access; no compatibility blocker was found in the existing development record contracts.

## Validation

All requested commands passed after the changes:

- `npm run typecheck`
- `npm run lint`
- `npm run test:ps`
- `npm run test:ps:integration`
- `npm run test:ps:http`
- `npm run build`

All seven existing legacy unit suites passed: security, assignments, grader statistics, scoring, coffee chats, interview imports and behavioral parsing.

Also ran the existing index verification, TOCTOU race suite and load-test script against an isolated temporary app and disposable loopback replica set. Index verification passed across seventeen collections. Race profile: five concurrent unique-create attempts, two state-transition repetitions, two hierarchy repetitions covering both launch orders, and one hundred candidate rows per import. All assertions passed. Load smoke profile: five users × twenty actions, five candidates, one hundred actions, 100% success, p95 37 ms and p99 46 ms. This is a small regression profile, not a production capacity benchmark. Temporary servers/databases were removed; the live development database was not used for destructive suites.

`git diff --check` passed. Expected console HTTP errors from deliberately injected/rejected requests are distinct from uncaught runtime exceptions; the latter were absent in the completed browser checks.

## Manual localhost checklist

1. Use the existing **Dev login (admin)**, then open `/admin/rounds` and choose **DEVELOPMENT ONLY - Alex QA Practice 2026-10-05**. Inspect all four rounds in order, their graders, one required review and TEST ONLY rubrics.
2. Open `/grade/ps`. Select **Resume Screening · DEVELOPMENT ONLY - Alex QA Practice 2026-10-05**. It starts at **1 / 4 completed · 3 remaining**, showing Practice Candidate 2.
3. Click **View resume**, then **Open resume PDF in a new tab**. Return to the form and inspect **View application responses**. Enter a 0–2 rating and a TEST ONLY comment; click **Submit & Next**. Confirm the next candidate and updated progress. Reload to confirm the submitted candidate stays absent.
4. Finish the remaining practice candidates. Confirm the useful completion state. In round setup, use **Refresh raw reviews** and inspect ratings, comments, rubric versions and **1 / 1 reviews submitted** per candidate. Scores remain unconfigured.
5. Explicitly **Advance** Practice Candidate 1 from Resume Screening. Try **Hold** and **Reject** on other practice candidates. Only the advanced candidate should enter Behavioral / Technical Interview. Refresh the enrollment list and inspect round history.
6. Select Behavioral / Technical Interview; **Preview assignments**, then **Generate assignments**. Wait for the generated message. Its eligible grader is dev-admin@example.test. Open `/grade/ps`, select that practice round, submit its review, then explicitly advance the candidate in setup.
7. Repeat the same assignment → grade → human Advance sequence for Social Round. Grade Final Take-Home, then confirm no Advance button/next round and no automatic acceptance. Earlier raw reviews and history remain visible.
8. Inspect the primary **DEVELOPMENT ONLY - Alex QA 2026-10-05** cycle to see the preserved three-grader/two-review results, held/rejected applicants and complete four-round history.

Practice actions persist in the development database. After using this checklist, counts and current candidates will naturally change. Normal Alex operations use the website; no code or database editing is needed. Initial intake test-data seeding is a QA-only exception, outside Alex's applicant-intake ownership.
