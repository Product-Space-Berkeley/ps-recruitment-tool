# Alex PS form-style rubric builder

Implemented on `alex/rounds-grading`; no commits, pushes, branch changes, resets, stashes or removal of existing work. Browser/test data stayed in disposable local databases. Existing recruitment records were preserved. Localhost was restarted to load the optional section fields; dashboard returned HTTP 200, unauthenticated grading returned HTTP 401, and the actual admin page loaded without errors.

## Product changes

The normal workflow is now Open Round → Edit Rubric → sections/questions → Save Draft → Preview → Publish Rubric. Import, import previews and a separate weights screen are absent from normal administration. Duplication and older drafts remain secondary.

The round workspace uses a centered content column and small Rubric / Setup & graders / Reviews & progression controls. Settings, assignments and progression remain available without crowding the builder. Editing locks workspace switching until Save Draft or Cancel so local edits do not disappear on a round change.

Sections and question cards use the existing PS light/dark surfaces, borders and accent colors. Instructions support paragraphs, bullet lists and safe HTTP(S) links. Candidate and signed-in interviewer appear automatically in basic-information sections. Numeric scales with at most eleven values render as radio choices; larger scales retain numeric inputs. Required fields have an asterisk. Questions support title/helper text, separate purpose/format, scales/options, required status, duplicate/delete/reorder, and section moves.

Save Draft persists editable changes without publishing. Cancel returns to the saved form. Preview responses remain client-only. Publish remains a separate action subject to validation and lifecycle/history guards.

## Exact files

Added:

- `src/lib/ps/rubricBuilder.ts`: section presets/labels and stable-ID builder operations.
- `docs/alex-ps-rubric-builder-ux.md`: this report.

Modified:

- `src/lib/ps/rubricV2.ts`: optional section metadata validation; empty-question drafts; informational/scored boundaries.
- `src/lib/ps/models.ts`: optional category `kind` and `description` fields.
- `src/lib/ps/rubricCompatibility.ts`: familiar section naming/preset when projecting a V1 copy.
- `src/components/PSRubricEditor.tsx`: form builder, inline weights, Save/Cancel/Preview/Publish and secondary duplication; no import controls.
- `src/components/PSRubricFields.tsx`: shared section content, automatic context, numeric radio choices and typed controls.
- `src/components/PSReviewHistory.tsx`: original section instructions/weights and human-readable question purposes.
- `src/app/admin/rounds/page.tsx`: centered round workspace and separated setup/history panels.
- `src/app/grade/ps/page.tsx`: section rendering and automatic interviewer context; existing grading/recovery flow retained.
- `src/app/api/ps/grading/route.ts`: returns the already-authorized actor's email for display. Authentication behavior is unchanged.
- `scripts/ps-workflow-unit.mjs`: builder operations, section boundaries, shared rendering and missing/false/zero coverage.
- `scripts/ps-workflow-integration.mjs`: section-content persistence and immutable publication.
- `scripts/ps-workflow-http.mjs`: manual form/draft/section/weight publication checks, preserving importer and existing suites.

No package/dependency, authentication, intake, deliberation or voting changes were necessary for this simplification.

## Additive schema changes

A section remains an existing V2 category. Two optional embedded fields were genuinely needed:

- `kind`: instructions, basic_information, interview_guide, scoring or general. These are presentation presets on one category structure; repeated sections and arbitrary titles remain supported.
- `description`: informational text, up to 10,000 characters.

Missing fields remain valid. Older categories infer their display preset from scored-question membership and show no body. V1 records still use their original reader. No schema version bump, migration, record rewriting, new collection or new index was required.

Drafts may save sections before adding questions. Publication requires at least one response question. Informational/basic-information/guide sections do not accept SCORED_CRITERION questions; other evidence formats remain available. General sections can contain scored criteria and then participate in weights. This preserves old V2 general/imported categories.

Section percentages are stored in the existing integer `weight_bps` field. Only scored categories have non-null weights; configured weights must total 10,000 basis points at publication. Incomplete totals can be saved while editing. Clearing every weight explicitly leaves weighting unconfigured. No candidate total or normalized score is computed.

The existing draft revision CAS, publication transaction, immutable rubric/scoring snapshots, exact review-version references, assignments, human progression and final-round safeguards are retained.

## Internal import compatibility

XLSX/CSV parser, upload route, provenance support and importer tests remain intact. No importer control is rendered in the normal rubric UI. No Google Forms API, OAuth, external API or Google dependency was added.

## Shared preview and grading

Editor preview and actual V2 grading both use `PSRubricFields`. Informational text stays outside review responses. The grader receives candidate identity from the existing assignment/applicant data and interviewer identity from the authenticated queue response. Additional co-interviewer/date/notes context can be configured as ordinary unscored typed fields; applicant intake is untouched.

Raw numbers, false, missing optional responses, arrays and exact text remain distinct. Failure recovery, progress, resume/application access, Submit & Next and saved-review retry guards are retained. Historical review displays use the precise published section/question snapshot used for submission.

## Validation

Passed:

- `npm run typecheck`
- `npm run lint`
- `npm run test:ps`
- `npm run test:ps:integration`
- `npm run test:ps:http`
- `npm run build`
- All legacy unit suites: security, assignments, grader-stats, scoring, coffee-chats, interview-import and behavioral.
- Disposable legacy index verification, PS additive index preflight/apply, race suite (fanout 5, state repetitions 2, activity repetitions 2, 100-row imports), and smoke load (5 users × 20 actions): 100% success, p95 42 ms / p99 52 ms.

Unit tests cover manual sections/questions, editing, duplication, removal without dangling references, ordering, moves, informational/scored boundaries, inline percentage validation, safe text/link rendering, automatic context and missing/false/zero responses. Existing assignment/progression/final-round/import coverage remains.

Integration/HTTP checks cover instructions-only draft save/reload, section text persistence, incomplete 85% weights, correction to 100%, immutable publication/body snapshots, V1 compatibility and typed immutable raw reviews.

## Browser QA

Created a PD-style form through the actual interface with:

1. Instructions for Conducting the Interview: before-interview bullets, behavioral guidance, Product Design guidance and wrap-up text.
2. Product Design Question: interviewer guidance and the supplied 0–3 scale explanation.
3. Basic information: automatically shown candidate/interviewer and an optional notes URL field.
4. Product Design Scoring: OVERALL easy to follow, OVERALL breadth of ideas, CLARIFYING QUESTIONS, USER GROUPS and PAIN POINTS; required 0–3 inputs and a 100% test category weight.

Verified section/question creation, editing, deletion, duplication, reordering, section moves, Save Draft, Cancel, reload, preview, publication, grader view, three submissions, Submit & Next, completed progress after reload, and historical review. An 85% draft saved successfully but publication failed until corrected. Save Draft did not activate a rubric.

Preview and grading exposed identical section headings and twenty 0–3 radio choices for five criteria. Basic information showed the actual assigned candidate and signed-in interviewer. Mobile width 390 had no horizontal overflow; desktop and mobile screenshots were visually inspected.

Injected review failure kept selected zeros. Injected queue failure after saving disabled resubmission until refresh. The three submitted reviews referenced the same exact published version; stored values included five zeros, the optional notes URL, and exact comment whitespace. Missing optional notes stayed absent. All candidates remained ready_for_deliberation, with official scores null. No automatic advancement or final decision occurred.

QA configuration was test-only; no PD rubric was written into FA2026 or another existing recruitment cycle.

## Remaining PS information

PS must confirm canonical rubric text, choices/scales, required fields and category percentages before real use. Official scoring and Z-score population/aggregation/edge-case rules remain unavailable, so normalized scores stay null/unconfigured. Krithin's authentication/intake and Jason's operational interview, vouch/red-flag, deliberation, voting and final-decision responsibilities are unchanged.
