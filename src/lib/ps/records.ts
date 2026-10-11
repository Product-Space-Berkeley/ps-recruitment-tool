import { WorkflowError } from './domain'
export function objectId(id: string) { if (!/^[a-f\d]{24}$/i.test(id)) throw new WorkflowError('Invalid ID.') }
export function serialize(row: Record<string, unknown>) {
  const result: Record<string, unknown> = { ...row, id: String(row._id) }
  delete result._id; delete result.__v
  for (const key of ['cycle_id', 'round_id', 'applicant_id', 'rubric_version_id', 'source_enrollment', 'next_enrollment', 'source_draft_id', 'published_version_id', 'scoring_configuration_id', 'evaluation_id', 'supersedes_id']) if (result[key]) result[key] = String(result[key])
  return result
}
