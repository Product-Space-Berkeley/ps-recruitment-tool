# Product Space recruitment workflow

Status: work-in-progress checkpoint pushed at user request; not a completed release. See the resume checklist below.
Last updated: 2026-10-14 (America/Los_Angeles).
Owner: Product Space @ Berkeley. This document is the durable source of truth for future work.

## Intended journey

One recruitment cycle contains three scored rounds:
1. Written application and resume review.
2. Product design (PD) interview.
3. Take-home presentation and social night, followed by one combined final deliberation.

Each round uses its own scores for ranking. The candidate history shows all round scores and decisions side by side, without a cumulative numerical ranking. Social feedback is qualitative and never changes rubric scores.

## People and permissions

- Board/leadership graders use Leadership or Admin accounts.
- The same membership pool is normally available each round; an admin confirms the eligible pool before assignment.
- Applicants sign in through the applicant flow and cannot access internal evaluations.
- Only the session host records consensus decisions and finishes decisions. Administrative moderation must not silently grant decision-making privileges.
- Every session member can see social cards, their colors, text, and authors.
- Members can add multiple cards and edit/delete their own; the host can remove inappropriate cards.

## Applications

- Cycle settings control application opening, deadline, essay prompts, meeting/retreat text, conflict instructions and required weekly hours.
- The cycle page links to that cycle's application form.
- Seniors are not offered as an application option. Do not infer this excludes continuing juniors solely from expected graduation dates.
- Junior transfers are grouped with juniors.
- Opening/closing applications does not automatically assign reviews, advance people, or send email.
- Preserve historic records; do not silently migrate existing live rounds to new scoring rules.

## Written assignments

- An explicit Assign reviewers action assigns exactly two distinct eligible people per applicant.
- Preview workload and confirm the pool before committing.
- Balance total assignments as evenly as feasible (difference at most one for unconstrained fresh assignments), and give reviewers a similar mix of freshman/sophomore/junior applicants.
- Use reproducible seeded tie-breaking, not application arrival order.
- Preserve submitted/started work on reruns; repeated generation is idempotent.
- Reviewers declare conflicts. Exclude the conflicted reviewer, automatically reassign unstarted work to an eligible reviewer, and notify leadership if coverage is impossible. Never silently drop completed evidence.
- Both reviewers submit independently; other reviewers' scores/comments remain hidden until both required evaluations are submitted. Enforce this at the API, not only visually.

## Built-in interview scheduling

- Admin configures dates, locations, slot duration, break duration, simultaneous interview capacity and rescheduling cutoff.
- PD and take-home default to 45 minutes; duration is editable.
- Interviewers enter availability. Assign two available, distinct interviewers to each slot, balancing per-round workload as constraints permit.
- Pairs vary by applicant/slot; no fixed pair roster is required.
- Applicants receive secure booking links and choose an available slot.
- Applicants can reschedule before the cutoff. Booking/rescheduling must be atomic: no double booking, capacity overflow, or overlapping interviewer appointments.
- If an interviewer cancels, find an available conflict-free replacement; flag unfilled slots and notify leadership when none exists.
- Store times in UTC and display explicit America/Los_Angeles timezone with correct daylight-saving handling.
- Take-home presentation is in person. Applicants bring slides; no mandatory project upload is part of this scope.
- Interview booking creates two independent review assignments. Scheduling partners do NOT share a rubric submission.

## Rubrics and score visibility

- Same rubric and maximum points for all class years within a round.
- Written, PD and take-home each require two independent rubric submissions.
- Interviewers may discuss afterward; preserve the two individual scores.
- Preserve rubric versions, raw criterion values, authors, timestamps and revisions.
- Display 0/2, 1/2 and 2/2 progress. Do not silently treat missing reviews as zero.
- Grading must finish before normal deliberation close; exceptional incomplete cases remain explicitly unresolved, never auto-recommended.

## Normalization and recommendations

- Normalize within each reviewer and current round, across all comparable applicants they graded, not across rounds.
- For rubric total x, reviewer mean mu, and standard deviation sigma: z = (x - mu) / sigma.
- Applicant normalized score is the mean of their two valid reviewer z-scores.
- Rank separately: Freshmen, Sophomores, Juniors (including junior transfers).
- Freshmen/sophomores: top 5 recommended green, bottom 5 recommended red.
- Juniors/transfers: top 3 recommended green, bottom 3 recommended red.
- Counts are fixed, not admin-editable. When group size is below twice its count, recommend yellow for the whole group. Cutoff ties remain yellow; never resolve ties with names or IDs.
- Recommendations are advisory and separate from recorded decisions; they never send email or advance/reject applicants.
- Keep raw totals, each reviewer's normalized score, aggregate score, cohort rank, coverage and diagnostic warnings inspectable.
- Freeze the dataset and scoring configuration when grading closes. Reopening invalidates recommendations until a new close; preserve previous snapshots.
- No fake z-scores when a reviewer has zero variance or insufficient observations. Flag affected candidates for review.
- Before phase 3 ships, document the technical policy for minimum reviewer sample size and population/sample standard deviation, test it, and disclose it in scoring help. Implementation policy v1 uses at least 3 observations and population standard deviation (divide by N), documented in scoring help. This is an implementation default, not a user-selected statistical parameter.

## Deliberation and progression

- The host records group consensus: green (advance/accept), red (reject), yellow (revisit).
- Yellow is a temporary unresolved decision, not a rejection or final outcome.
- Host can revisit decisions before Finish decisions.
- Finish decisions requires every in-scope candidate to be green/red. Finalization must be transactional, audited and idempotent.
- Intermediate green advances to the next round; final green accepts into the organization.
- Only the host can finalize. Define an explicit audited host-transfer/reopening flow before allowing post-finalization changes.
- No emails are automatically sent on color changes or merely finishing decisions.

## Social night

- Part of final take-home round, preceding the combined final deliberation.
- Applicant boards have green positive observations, yellow mixed feedback/questions, and red concerns.
- Colored text cards are qualitative. Everyone in the session sees authors; do not reuse anonymous legacy red-flag behavior for these cards.
- Cards support multiple entries per member, ownership-checked edits/deletes and host moderation.

## Email and exports

- Admin connects a Google account to send as that authorized mailbox. A typed address alone is not sufficient authorization.
- Use appropriate Google OAuth consent/scopes, server-side protected token storage, disconnect/revoke and reconnect handling. Do not commit tokens or expose them to the browser.
- Editable invitation/rejection templates, merge-field validation, recipient preview and explicit Send.
- Queue with idempotency keys, delivery attempt history, safe retry and partial-failure reporting. Do not promise inbox delivery merely from API acceptance.
- Booking invitations include secure recipient-bound links. Never expose internal comments or scores in mail by default.
- CSV export is always available independently of Google connection. Include finalized outcomes and useful round/cohort fields; escape spreadsheet formula injection.
- Integration testing must use fakes/disposable data. Real connection/consent and sending require the admin's actions.

## Deletion and retained data

- Ended cycles: admin-only typed confirmation, cascade scoped to the cycle.
- Sessions: authorized creator/admin typed-code confirmation; remove session-local roster/votes/notes/memberships while preserving applications, round evaluations and progression decisions.
- Do not delete real user data during implementation or testing.

## Implementation phases and acceptance gates

### Phase 1 — Assignment foundations
- [x] New standard rounds use two independent assigned reviews, not shared-pair/open grading.
- [x] Confirm leadership/admin pool in setup.
- [x] Balance written totals and class-year mix; maintain preview and idempotence.
- [x] Regression tests for uniqueness, load, cohorts and preservation.

### Phase 2 — Conflict handling and independent review privacy
- [x] Persistent conflicts, reassignment endpoint/UI and unresolved-coverage inbox.
- [x] API-enforced blind reviews until both submit; role/host checks and tests.
- [x] No senior option, including server validation and legacy handling.

### Phase 3 — Scoring and deliberation
- [x] Versioned grader normalization, coverage diagnostics, class-year recommendations and ties.
- [x] Frozen snapshots, round history view and host-only consensus finalization.
- [x] Round recommendations are never final decisions; test small cohorts/zero variance/incomplete reviews.

### Phase 4 — Scheduling
- [x] Configurable slots/locations/capacity, interviewer availability and balanced allocation.
- [x] Applicant booking/rescheduling, conflict-aware replacement and independent assignments.
- [x] Concurrency, time-zone and authorization tests.

### Phase 5 — Social feedback
- [x] Colored authored cards, edit/delete/moderate, combined final deliberation.
- [x] Permission and real-time update tests.

### Phase 6 — Google sending and exports
- [x] Google mailbox connection, recipient/template preview, explicit send and reliable outbox.
- [x] Final CSV, failure/retry tests, deployment/Google setup instructions.

### Phase 7 — End-to-end release
- [x] Disposable three-round simulation and role/privacy/concurrency tests.
- [ ] Desktop/mobile browser visual acceptance and real Google consent/test sending.
- [x] Migration/preflight guidance, operational README and reviewable commits.

## Current implementation caveats

Implementation through the email phase is present. Phase 6 now passes automated acceptance, including the fake-provider HTTP suite. Phases 1–6 pass automated acceptance. Phase 7 still needs visual and real-provider acceptance. Legacy rounds are preserved. Real Google consent and a deliberately selected test email remain deployment acceptance tasks; no real mail was sent.

## Resume here

User requested an immediate checkpoint push on 2026-10-14, so feature work stopped.

| Phase | Checkpoint status |
| --- | --- |
| 1 — Assignments | Complete; unit and HTTP tests passed. |
| 2 — Conflicts/privacy | Complete; security, unit and HTTP checks passed. |
| 3 — Scoring/deliberation | Complete automated acceptance: uniform standard rubrics, normalization, snapshots and host-only finalization; full three-round simulation passed. |
| 4 — Scheduling | Complete automated acceptance: capacity collisions, cross-round interviewer overlap, replacement/alert resolution, daylight-saving offsets, cutoffs, private links and full-cycle bookings passed. |
| 5 — Social cards | Implemented; membership, ownership, stale edit and moderation HTTP tests passed. Visual acceptance belongs to Phase 7. |
| 6 — Google email/CSV | Automated acceptance complete: connection/state, encrypted storage, privacy, preview, concurrent sending, duplicate protection, failures/uncertain results and disconnect passed. Real Google setup remains release acceptance. |
| 7 — Release | Automated full cycle and production build pass. Desktop/mobile visual checks and real Google consent/test sending remain. |

Next work, in order:
1. Complete desktop/mobile browser acceptance on the deployment target. Source-level UI checks pass, but no visual acceptance is claimed.
2. Connect a test Google mailbox and explicitly send a selected test email. Set the private `MAIL_TOKEN_KEY` first. Automated Google tests use a fake provider and do not validate Cloud project configuration.
3. Run the documented additive index preflight against the intended deployment database, back up, and apply reviewed indexes before real recruitment. No real database migration has been run here.

Completed since checkpoint: fixed Gmail credential access; new standard rounds enforce one points rubric shared by every class year, two independent Leadership/Admin reviews and booking-based interview assignment. Historical rounds are unchanged. A full three-round API simulation passes, including score privacy, frozen z-scores, junior-transfer grouping, PD/final bookings, qualitative social feedback, idempotent host finalization and applicant history. Cross-round overlapping interviewers and repeated daylight-saving times are covered. Restoring interview coverage clears its unresolved-conflict alert.

Verification: TypeScript, lint, unit/security tests and disposable HTTP suite pass; production build passes. No real emails sent, live applicants modified, or private env files committed.

## Implementation log

- 2026-10-14: Saved agreed requirements and phased acceptance criteria. Phase 1 complete locally: standard rounds require two individual assigned reviews and a Leadership/Admin pool; written assignment planning balances total loads and class-year mix. Typecheck, lint, assignment/scoring unit tests and disposable HTTP regression suite passed. Existing cycles were not migrated. Not committed or pushed. Next: Phase 2 conflict handling and independent-review privacy.

- 2026-10-14: Phase 2 implementation in verification. Conflict declarations are persistent; reassignment excludes conflicted reviewers; unresolved alerts block closing. Submitted conflicted points reviews can be excluded by an admin with immutable evidence retained. Legacy shared-pair rounds require reconfiguration, and legacy raw-review exclusions require migration. Peer history/profile APIs hide unfinished evaluations even from leadership/admin; completed reviews are available to assigned reviewers. Senior removed from shared applicant options/validation; historical records retained.

- 2026-10-14: Phase 2 verified: typecheck, lint, security/unit tests and disposable HTTP suite passed. Phase 3 normalization and provisional host-only finalization implemented; finalization is idempotent, outcome changes cannot be made through the old enrollment endpoint. Finalized rounds cannot be reopened in this release. Phase 4 scheduling, Phase 5 social boards, and Phase 6 Google sending implemented; full late-phase verification is in progress. No live applicant data modified and no real email sent.

- 2026-10-14: User requested immediate push and pause. Saved current implementation, exact phase status, failing mail test and ordered resume checklist. This is a WIP checkpoint, not phase-7 completion.

- 2026-10-14: Resumed Phase 6. Corrected encrypted refresh credential access for sending/revocation using a fixed server-only native projection. Added response privacy assertions. Typecheck, lint, security tests and the full HTTP suite passed, including fake Google send/concurrency/idempotency/failure/disconnect tests. Phase 6 automated acceptance complete; no real email sent. Next: standard-rubric compatibility and remaining Phase 3/4/7 acceptance.

- 2026-10-14: Completed Phase 3/4 automated acceptance. Added standard_stage for new rounds only, uniform written rubric draft, publication/settings guards and scheduling navigation. Added complete three-round simulation, cross-round interviewer-overlap and daylight-saving tests. Fixed stale coverage alerts after replacement. All tests and production build passed. Phase 7 remains open for visual and real-Google acceptance.
