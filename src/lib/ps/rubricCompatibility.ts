import type { Rubric } from './rubrics'
import type { RubricV2, Structure } from './rubricV2'
export type AnyRubric = Rubric | RubricV2
export function isV2(r: AnyRubric): r is RubricV2 { return 'schema_version' in r && r.schema_version === 2 }
// A read-only projection; the V1 record and its historical weights are never rewritten.
export function copyStructure(r: AnyRubric): Structure {
  if (isV2(r)) return { schema_version: 2, name: r.name, description: r.description, scoring_policy: r.scoring_policy, categories: structuredClone(r.categories), questions: structuredClone(r.questions), weighting: r.weighting }
  return { schema_version: 2, name: r.name, weighting: 'unconfigured', categories: [{ id: 'legacy', name: 'Scoring', order: 0, weight_bps: null, kind: 'scoring', description: '' }], questions: r.criteria.map(c => ({ id: c.id, category_id: 'legacy', label: c.name, description: c.description, order: c.order, purpose: 'SCORED_CRITERION', format: c.options.length ? 'numeric_choice' : 'number', required: true, confirmed: true, scale: c.scale, options: c.options })) }
}
