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
- [ ] Versioned grader normalization, coverage diagnostics, class-year recommendations and ties.
- [ ] Frozen snapshots, round history view and host-only consensus finalization.
- [ ] Round recommendations are never final decisions; test small cohorts/zero variance/incomplete reviews.

### Phase 4 — Scheduling
- [ ] Configurable slots/locations/capacity, interviewer availability and balanced allocation.
- [ ] Applicant booking/rescheduling, conflict-aware replacement and independent assignments.
- [ ] Concurrency, time-zone and authorization tests.

### Phase 5 — Social feedback
- [x] Colored authored cards, edit/delete/moderate, combined final deliberation.
- [x] Permission and real-time update tests.

### Phase 6 — Google sending and exports
- [ ] Google mailbox connection, recipient/template preview, explicit send and reliable outbox.
- [ ] Final CSV, failure/retry tests, deployment/Google setup instructions.

### Phase 7 — End-to-end release
- [ ] Disposable full-cycle simulation, role/privacy/concurrency tests, responsive browser checks.
- [ ] Migration/preflight guidance, operational README, reviewable commits/PR when requested.

## Current implementation caveats

This checkpoint contains implementation through the email phase, but phases 3, 4, 6 and 7 still have acceptance work. Legacy rounds are preserved. Do not use the Gmail sender for real messages yet: the fake-provider HTTP suite currently fails when reading the encrypted refresh credential. No real mail was sent.

## Resume here

User requested an immediate checkpoint push on 2026-10-14, so feature work stopped.

| Phase | Checkpoint status |
| --- | --- |
| 1 — Assignments | Complete; unit and HTTP tests passed. |
| 2 — Conflicts/privacy | Complete; security, unit and HTTP checks passed. |
| 3 — Scoring/deliberation | Implemented and core tests passed; standard rubric compatibility needs completion. |
| 4 — Scheduling | Implemented; capacity collision, availability replacement, cutoff, link rotation and authorization tests passed. Broader cross-round/time-zone/end-to-end tests remain. |
| 5 — Social cards | Implemented; membership, ownership, stale edit and moderation HTTP tests passed. Visual acceptance belongs to Phase 7. |
| 6 — Google email/CSV | Work in progress. OAuth/preview checks passed, sending test fails at credential read. CSV implemented. |
| 7 — Release | Incomplete. Production build passes; full-cycle and browser acceptance remain. |

Next work, in order:
1. Fix `src/lib/ps/mail.ts`: `sendMail` gets `undefined` for `encrypted_refresh` despite `.sanitizeProjection(false).select('+encrypted_refresh')`. The database contains the encrypted value; inspect `src/lib/mongooseConfig.ts` and Mongoose projection behavior. Keep credentials server-only. Disconnect uses the same lookup and needs the same fix. Run `npm run test:ps:http`; its Google provider is fully faked.
2. Finish the standard-round rubric policy: old written templates still have class-specific sections. New standard rounds must use the same rubric/max points for all years; preserve historical rounds. Enforce the policy on publication/settings. Normalization currently flags incompatible maximum points instead of manufacturing comparable scores.
3. Exercise three complete rounds through the public API, including booking and independent PD/final reviews, normalization freeze, final social cards and host finalization. Add cross-round overlapping interviewer and daylight-saving tests.
4. Review remaining scheduling integration edges: generic assignment generation is blocked once slots exist, but new standard interview rounds should direct admins to scheduling even before slots exist. Verify conflict replacement resolves all coverage alerts and preserves submitted evidence.
5. Complete desktop/mobile browser acceptance. The browser tool was previously blocked by URL policy; no visual acceptance is claimed. Source-level interface detector passed.
6. Validate Gmail rejected/uncertain retry paths after fixing credential access, then manually connect a test Google account and explicitly send a selected test message. Configure `MAIL_TOKEN_KEY` privately first; no env values were changed for this checkpoint.
7. Review and format the new service modules for maintainability, rerun required checks, then mark remaining phase gates complete. No real database migrations have been run.

Checkpoint verification: production build, TypeScript, lint, security tests and PS unit tests passed. Full HTTP regression passed all earlier phases plus scheduling/social tests, then failed in Phase 6 as described. No secrets should be committed; `.env.local` remains ignored.

## Implementation log

- 2026-10-14: Saved agreed requirements and phased acceptance criteria. Phase 1 complete locally: standard rounds require two individual assigned reviews and a Leadership/Admin pool; written assignment planning balances total loads and class-year mix. Typecheck, lint, assignment/scoring unit tests and disposable HTTP regression suite passed. Existing cycles were not migrated. Not committed or pushed. Next: Phase 2 conflict handling and independent-review privacy.

- 2026-10-14: Phase 2 implementation in verification. Conflict declarations are persistent; reassignment excludes conflicted reviewers; unresolved alerts block closing. Submitted conflicted points reviews can be excluded by an admin with immutable evidence retained. Legacy shared-pair rounds require reconfiguration, and legacy raw-review exclusions require migration. Peer history/profile APIs hide unfinished evaluations even from leadership/admin; completed reviews are available to assigned reviewers. Senior removed from shared applicant options/validation; historical records retained.

- 2026-10-14: Phase 2 verified: typecheck, lint, security/unit tests and disposable HTTP suite passed. Phase 3 normalization and provisional host-only finalization implemented; finalization is idempotent, outcome changes cannot be made through the old enrollment endpoint. Finalized rounds cannot be reopened in this release. Phase 4 scheduling, Phase 5 social boards, and Phase 6 Google sending implemented; full late-phase verification is in progress. No live applicant data modified and no real email sent.

- 2026-10-14: User requested immediate push and pause. Saved current implementation, exact phase status, failing mail test and ordered resume checklist. This is a WIP checkpoint, not phase-7 completion.
