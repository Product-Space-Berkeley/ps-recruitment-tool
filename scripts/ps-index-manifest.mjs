// Additive indexes only. Existing legacy indexes are not altered or dropped.
export const PS_INDEXES = [
  { collection: 'psevaluationrevisions', key: { round_id: 1, applicant_id: 1, grader_email: 1, revision: 1 }, unique: true },
  { collection: 'psevaluationrevisions', key: { grader_email: 1, round_id: 1 } },
  { collection: 'psevaluationcontributions', key: { round_id: 1, applicant_id: 1, grader_email: 1 }, unique: true },
  { collection: 'psevaluationcontributions', key: { grader_email: 1, round_id: 1 } },
  { collection: 'candidaterounds', key: { round_id: 1, applicant_id: 1 }, unique: true },
  { collection: 'candidaterounds', key: { cycle_id: 1, applicant_id: 1 } },
  { collection: 'rubricdrafts', key: { round_id: 1, status: 1, updated_at: -1 } },
  { collection: 'rubricscoringconfigurations', key: { rubric_version_id: 1, version: 1 }, unique: true },
  { collection: 'rubricversions', key: { source_draft_id: 1 }, unique: true, partialFilterExpression: { source_draft_id: { $type: 'objectId' } } },
  { collection: 'rubricversions', key: { round_id: 1, version: 1 }, unique: true },
  { collection: 'genericreviews', key: { round_id: 1, applicant_id: 1, grader_email: 1 }, unique: true },
  { collection: 'genericreviews', key: { grader_email: 1, round_id: 1 } },
  { collection: 'candidateroundscores', key: { round_id: 1, applicant_id: 1, created_at: -1 } },
]
