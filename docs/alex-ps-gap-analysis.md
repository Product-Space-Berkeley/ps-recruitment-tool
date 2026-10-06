# Alex PS workflow gap analysis and corrections

Reviewed October 5, 2026 against the original requirements, narrowed team ownership specification, and `alex-rounds-implementation.md`.

## Already satisfied

The existing cycle and Round models are reused. PS configuration is additive and website-managed. Round names/counts are arbitrary; selected AuthorizedUsers and configurable N replace legacy reviewer pools. The assignment planner and existing GraderAssignment storage preserve frozen work. CandidateRound enrollment/progression is transactional, ordered, idempotent, and retains earlier evidence. RubricVersion and GenericReview support variable criteria and raw scores. No PS service invokes the Plex scorer; calculated scores remain null/unconfigured. Legacy data, authentication, intake, interview imports, and final decisions retain their existing contracts.

## Corrections

| Gap found in the existing implementation | Correction |
| --- | --- |
| Mongoose immutability allowed nested rubric changes and entire rating-element replacements; actual database regressions changed a criterion's meaning and a raw score. | Mark nested fields immutable and reject updates/replacements/deletions, modified saves, and noninsert bulk operations on published rubrics/submitted reviews. Regression tests cover these write paths. |
| `assignmentService.snapshot()` checked only archived/ended rounds. Preview could succeed for a closed cycle; generation could reopen a deliberating round. | Require an active cycle and a pending/grading round for both preview and commit. Keep all assignments/reviews intact on rejection. |
| Preview excluded advanced/held/rejected candidates' preserved assignments from the workload used to distribute new work. | Include frozen work in workload balancing while refusing to add assignments to those candidates. |
| `/api/ps/grading` selected grading rounds without checking the parent cycle or the actor's round eligibility. | Limit the queue to active cycles and rounds where the current grader is selected. |
| `updateRound()` silently ignored unsupported settings such as order/rubric/scoring changes. | Reject unsupported fields and invalid/missing configuration versions with useful JSON errors. Preserve the dedicated ordering and rubric boundaries. |
| Configuration/progression/rubric/assignment controls did not consistently reflect closed-cycle or frozen-round state, and grading load failures had no retry control. | Propagate read-only/activity state, retain configuration selection on refresh, expose queue retry, and refresh enrollment state after assignment generation. |

Regression checks extend the existing PS database/HTTP suites to cover lifecycle closure, round eligibility, rejected configuration mutations, preserved evidence, and rubric/raw-rating immutability.

## Scope and remaining dependencies

Changes stay in Alex-owned PS services/pages/components and their tests. Shared auth, applicant intake, interview/behavioral import/sync, voting, deliberation, and final-decision implementation are unchanged. Actual PS criteria/scales/template and its parser still require the real rubric. Actual PS Z-score engine still requires the methodology specification. Krithin continues to supply authorized users/applicants; Jason integrates session/final decisions with canonical CandidateRound IDs and raw evidence.

## Validation result

All passed after the final application changes:

- `npm run typecheck`
- `npm run lint`
- `npm run test:ps`
- `npm run test:ps:integration`
- `npm run test:ps:http`
- `npm run build` (39 static pages plus dynamic API/session routes)
- Existing security, assignments, scoring, grader statistics, coffee-chat, interview-import, and behavioral suites.
- `git diff --check`

Database/HTTP tests used disposable local replica sets and an isolated app copy; no live migration, index application, or secret change was performed. Restart the development server to reload cached Mongoose schemas and the new append-only hooks.
