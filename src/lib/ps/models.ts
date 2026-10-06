import { Schema, model, models } from 'mongoose'
import '@/lib/models'
import { WorkflowError } from './domain'
import { PURPOSES, FORMATS, SECTION_KINDS, SCORING_POLICIES, YEARS } from './rubricV2'
function appendOnly(schema: Schema) {
  // Mongoose immutable fields alone do not block array-element replacement.
  schema.pre(['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete'], function () {
    throw new WorkflowError('Published rubrics and submitted raw reviews cannot be changed or deleted. Create a new record instead.', 409)
  })
  schema.pre('deleteOne', { document: true, query: false }, function () {
    throw new WorkflowError('Published rubrics and submitted raw reviews cannot be deleted.', 409)
  })
  schema.pre('bulkWrite', function (operations) {
    if (operations.some(operation => !('insertOne' in operation))) throw new WorkflowError('Bulk operations may only insert new rubrics or raw reviews.', 409)
  })
  schema.pre('save', function () {
    if (!this.isNew && this.isModified()) throw new WorkflowError('Published rubrics and submitted raw reviews cannot be overwritten.', 409)
  })
}
const EventSchema = new Schema({ action: { type: String, required: true }, actor: { type: String, required: true }, at: { type: Date, required: true }, target_round_id: { type: Schema.Types.ObjectId, default: null } }, { _id: false })
const CandidateRoundSchema = new Schema({
  cycle_id: { type: Schema.Types.ObjectId, ref: 'RecruitmentCycle', required: true },
  round_id: { type: Schema.Types.ObjectId, ref: 'Round', required: true },
  applicant_id: { type: Schema.Types.ObjectId, ref: 'Applicant', required: true },
  state: { type: String, enum: ['pending', 'in_review', 'ready_for_deliberation', 'advanced', 'hold', 'rejected'], default: 'pending' },
  source_enrollment: { type: Schema.Types.ObjectId, ref: 'CandidateRound', default: null },
  next_enrollment: { type: Schema.Types.ObjectId, ref: 'CandidateRound', default: null },
  decision_by: { type: String, default: null }, decision_at: { type: Date, default: null },
  events: { type: [EventSchema], default: [] },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } })
CandidateRoundSchema.index({ round_id: 1, applicant_id: 1 }, { unique: true })
CandidateRoundSchema.index({ cycle_id: 1, applicant_id: 1 })
export const CandidateRound = models.CandidateRound || model('CandidateRound', CandidateRoundSchema)
const ScaleSchema = new Schema({ min: { type: Number, required: true, immutable: true }, max: { type: Number, required: true, immutable: true }, step: { type: Number, required: true, immutable: true } }, { _id: false })
const CriterionSchema = new Schema({
  id: { type: String, required: true, immutable: true }, name: { type: String, required: true, immutable: true }, description: { type: String, default: '', immutable: true },
  order: { type: Number, required: true, immutable: true }, weight: { type: Number, default: null, immutable: true },
  scale: { type: ScaleSchema, default: null, immutable: true },
  options: { type: [{ value: { type: Number, required: true, immutable: true }, label: { type: String, required: true, immutable: true } }], default: [], immutable: true },
}, { _id: false })
const CategorySchema = new Schema({ id: { type: String, required: true }, name: { type: String, default: '' }, order: { type: Number, required: true }, weight_bps: { type: Number, default: null }, kind: { type: String, enum: SECTION_KINDS, default: undefined }, description: { type: String, maxlength: 10000, default: undefined }, show_for_years: { type: [{ type: String, enum: YEARS }], default: undefined } }, { _id: false })
const QuestionSchema = new Schema({
  id: { type: String, required: true }, category_id: { type: String, required: true }, label: { type: String, default: '', maxlength: 4000 }, description: { type: String, default: '' }, order: Number,
  purpose: { type: String, enum: [...PURPOSES, null], default: null }, format: { type: String, enum: [...FORMATS, null], default: null }, required: { type: Boolean, default: null }, confirmed: { type: Boolean, required: true },
  scale: { type: ScaleSchema, default: null }, options: { type: [{ value: { type: Schema.Types.Mixed, required: true }, label: { type: String, default: '' } }], default: [] },
  weight_bps: { type: Number, default: undefined }, min_label: { type: String, maxlength: 300, default: undefined }, max_label: { type: String, maxlength: 300, default: undefined },
  source: { type: new Schema({ sheet: String, column: Number, header: String, suggestion: String }, { _id: false }), default: undefined },
}, { _id: false })
const RubricDraftSchema = new Schema({
  schema_version: { type: Number, enum: [2], required: true }, round_id: { type: Schema.Types.ObjectId, ref: 'Round', required: true },
  name: { type: String, default: '' }, description: { type: String, maxlength: 10000, default: undefined }, scoring_policy: { type: String, enum: SCORING_POLICIES, default: undefined }, categories: { type: [CategorySchema], required: true }, questions: { type: [QuestionSchema], required: true }, weighting: { type: String, enum: ['configured', 'unconfigured'], required: true },
  revision: { type: Number, default: 0 }, status: { type: String, enum: ['editing', 'published'], default: 'editing' }, published_version_id: { type: Schema.Types.ObjectId, ref: 'RubricVersion', default: null },
  provenance: { type: new Schema({ kind: String, fingerprint: String, file_name: String, sheet: String, source_version_id: String }, { _id: false }), required: true },
  created_by: { type: String, required: true }, updated_by: { type: String, required: true },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } })
RubricDraftSchema.index({ round_id: 1, status: 1, updated_at: -1 })
export const RubricDraft = models.RubricDraft || model('RubricDraft', RubricDraftSchema)
const RubricScoringConfigurationSchema = new Schema({
  rubric_version_id: { type: Schema.Types.ObjectId, ref: 'RubricVersion', required: true, immutable: true },
  engine: { type: String, enum: ['unconfigured', ...SCORING_POLICIES], default: 'unconfigured', immutable: true }, version: { type: Number, default: 1, immutable: true },
  weighting: { type: String, enum: ['configured', 'unconfigured'], required: true, immutable: true },
  question_weights: { type: [{ question_id: String, weight_bps: Number }], default: undefined, immutable: true },
  category_weights: { type: [{ category_id: { type: String, required: true }, weight_bps: { type: Number, default: null } }], required: true, immutable: true },
  created_by: { type: String, required: true, immutable: true }, created_at: { type: Date, default: Date.now, immutable: true },
})
RubricScoringConfigurationSchema.index({ rubric_version_id: 1, version: 1 }, { unique: true })
appendOnly(RubricScoringConfigurationSchema)
export const RubricScoringConfiguration = models.RubricScoringConfiguration || model('RubricScoringConfiguration', RubricScoringConfigurationSchema)
const RubricVersionSchema = new Schema({
  round_id: { type: Schema.Types.ObjectId, ref: 'Round', required: true, immutable: true }, name: { type: String, required: true, immutable: true },
  schema_version: { type: Number, enum: [1, 2], immutable: true },
  description: { type: String, maxlength: 10000, immutable: true }, scoring_policy: { type: String, enum: SCORING_POLICIES, immutable: true },
  categories: { type: [CategorySchema], default: undefined, immutable: true }, questions: { type: [QuestionSchema], default: undefined, immutable: true }, weighting: { type: String, enum: ['configured', 'unconfigured'], immutable: true },
  source_draft_id: { type: Schema.Types.ObjectId, ref: 'RubricDraft', immutable: true }, scoring_configuration_id: { type: Schema.Types.ObjectId, ref: 'RubricScoringConfiguration', immutable: true },
  version: { type: Number, required: true, immutable: true }, criteria: { type: [CriterionSchema], required: true, immutable: true },
  created_by: { type: String, required: true, immutable: true }, created_at: { type: Date, default: Date.now, immutable: true },
})
RubricVersionSchema.index({ round_id: 1, version: 1 }, { unique: true })
RubricVersionSchema.index({ source_draft_id: 1 }, { unique: true, partialFilterExpression: { source_draft_id: { $type: 'objectId' } } })
appendOnly(RubricVersionSchema)
export const RubricVersion = models.RubricVersion || model('RubricVersion', RubricVersionSchema)
const GenericReviewSchema = new Schema({
  round_id: { type: Schema.Types.ObjectId, ref: 'Round', required: true, immutable: true }, applicant_id: { type: Schema.Types.ObjectId, ref: 'Applicant', required: true, immutable: true },
  grader_email: { type: String, required: true, immutable: true, lowercase: true, trim: true },
  rubric_version_id: { type: Schema.Types.ObjectId, ref: 'RubricVersion', required: true, immutable: true },
  schema_version: { type: Number, enum: [1, 2], immutable: true },
  responses: { type: [new Schema({ question_id: { type: String, required: true }, format: { type: String, enum: FORMATS, required: true }, value: { type: Schema.Types.Mixed, required: true } }, { _id: false })], default: undefined, immutable: true },
  ratings: { type: [{ criterion_id: { type: String, required: true, immutable: true }, raw_score: { type: Number, required: true, immutable: true } }], required: true, immutable: true },
  comments: { type: String, default: '', immutable: true, maxlength: 10000 }, submitted_at: { type: Date, default: Date.now, immutable: true },
})
GenericReviewSchema.index({ round_id: 1, applicant_id: 1, grader_email: 1 }, { unique: true })
GenericReviewSchema.index({ grader_email: 1, round_id: 1 })
appendOnly(GenericReviewSchema)
export const GenericReview = models.GenericReview || model('GenericReview', GenericReviewSchema)
// Calculated outputs are separate from immutable raw reviews. No PS score is calculated yet.
const CandidateRoundScoreSchema = new Schema({
  round_id: { type: Schema.Types.ObjectId, ref: 'Round', required: true }, applicant_id: { type: Schema.Types.ObjectId, ref: 'Applicant', required: true },
  rubric_version_id: { type: Schema.Types.ObjectId, ref: 'RubricVersion', default: null },
  engine: { type: String, required: true }, engine_version: { type: String, default: null },
  input_review_ids: { type: [Schema.Types.ObjectId], default: [] }, input_fingerprint: { type: String, required: true },
  status: { type: String, enum: ['unconfigured', 'calculated'], required: true }, score: { type: Number, default: null },
  criterion_results: { type: Schema.Types.Mixed, default: null }, calculated_at: { type: Date, default: null },
  created_at: { type: Date, default: Date.now },
})
CandidateRoundScoreSchema.index({ round_id: 1, applicant_id: 1, created_at: -1 })
export const CandidateRoundScore = models.CandidateRoundScore || model('CandidateRoundScore', CandidateRoundScoreSchema)

// Every weighted submission is an immutable revision; only its active pointer changes.
const PSEvaluationRevisionSchema = new Schema({
  round_id: { type: Schema.Types.ObjectId, ref: 'Round', required: true }, applicant_id: { type: Schema.Types.ObjectId, ref: 'Applicant', required: true },
  grader_email: { type: String, required: true, lowercase: true, trim: true }, rubric_version_id: { type: Schema.Types.ObjectId, ref: 'RubricVersion', required: true },
  scoring_configuration_id: { type: Schema.Types.ObjectId, ref: 'RubricScoringConfiguration', required: true },
  schema_version: { type: Number, enum: [2], required: true }, revision: { type: Number, required: true }, supersedes_id: { type: Schema.Types.ObjectId, ref: 'PSEvaluationRevision', default: null },
  rubric_snapshot: { type: Schema.Types.Mixed, required: true }, responses: { type: [new Schema({ question_id: { type: String, required: true }, format: { type: String, enum: FORMATS, required: true }, value: { type: Schema.Types.Mixed, required: true } }, { _id: false })], required: true },
  // question_weighted_0_3 rows store a 0–3 score with weights; points_v1 rows store total points with max_points.
  question_results: { type: [new Schema({ question_id: String, raw_score: Number, normalized_score: Number, weight_bps: Number, purpose: String, points: Number }, { _id: false })], required: true },
  answered_weight_bps: { type: Number, default: null }, score: { type: Number, required: true }, comments: { type: String, maxlength: 10000, default: '' }, submitted_at: { type: Date, default: Date.now },
  max_points: { type: Number, default: null }, percent: { type: Number, default: null }, criteria_points: { type: Number, default: null }, bonus_points: { type: Number, default: null }, penalty_points: { type: Number, default: null },
  section_totals: { type: [new Schema({ category_id: String, points: Number, max: Number }, { _id: false })], default: undefined }, applicant_year: { type: String, default: null },
  panel_emails: { type: [String], default: undefined }, // pair rounds: everyone credited with this evaluation
})
PSEvaluationRevisionSchema.index({ round_id: 1, applicant_id: 1, grader_email: 1, revision: 1 }, { unique: true })
PSEvaluationRevisionSchema.index({ grader_email: 1, round_id: 1 })
appendOnly(PSEvaluationRevisionSchema)
export const PSEvaluationRevision = models.PSEvaluationRevision || model('PSEvaluationRevision', PSEvaluationRevisionSchema)
const PSEvaluationContributionSchema = new Schema({
  round_id: { type: Schema.Types.ObjectId, ref: 'Round', required: true }, applicant_id: { type: Schema.Types.ObjectId, ref: 'Applicant', required: true },
  grader_email: { type: String, required: true }, revision: { type: Number, required: true }, evaluation_id: { type: Schema.Types.ObjectId, ref: 'PSEvaluationRevision', required: true },
})
PSEvaluationContributionSchema.index({ round_id: 1, applicant_id: 1, grader_email: 1 }, { unique: true })
PSEvaluationContributionSchema.index({ grader_email: 1, round_id: 1 })
export const PSEvaluationContribution = models.PSEvaluationContribution || model('PSEvaluationContribution', PSEvaluationContributionSchema)
