import mongoose, { Schema, model, models } from 'mongoose'
import { configureMongooseSecurity } from '@/lib/mongooseConfig'

configureMongooseSecurity()

// ─── Authorized Users ────────────────────────────────────────
const AuthorizedUserSchema = new Schema({
  email:    { type: String, required: true, unique: true, lowercase: true, trim: true },
  role:     { type: String, enum: ['grader', 'leadership', 'admin'], default: 'grader' },
  added_by: { type: String, default: null, lowercase: true, trim: true },
  added_at: { type: Date, default: Date.now },
  assignment_write_count: { type: Number, default: 0, min: 0, select: false },
})
export const AuthorizedUser = models.AuthorizedUser || model('AuthorizedUser', AuthorizedUserSchema)

// Small singleton documents used to serialize cross-document invariants that
// MongoDB cannot express as a unique index (for example, retaining one admin).
const SecurityLockSchema = new Schema({
  _id:     { type: String },
  version: { type: Number, required: true, default: 0, min: 0 },
}, { _id: false })
export const SecurityLock = models.SecurityLock || model('SecurityLock', SecurityLockSchema)

// ─── Recruitment Cycles ──────────────────────────────────────
const RecruitmentCycleSchema = new Schema({
  name:                   { type: String, required: true },
  status:                 { type: String, enum: ['active', 'ended'], default: 'active' },
  accepting_applications: { type: Boolean, default: false },
  application_deadline:   { type: Date, default: null },
  coffee_chat_sheet_id:   { type: String, default: null, select: false },
  coffee_chat_sheet_gid:  { type: String, default: null, select: false },
  behavioral_source: { type: Schema.Types.Mixed, default: null, select: false },
  behavioral_sync_next_at: { type: Date, default: null, select: false },
  behavioral_sync_lock_until: { type: Date, default: null, select: false },
  behavioral_sync_token: { type: String, default: null, select: false },
  configuration_version:  { type: Number, default: 0, min: 0 },
  submission_count:       { type: Number, default: 0, min: 0 },
  lifecycle_write_count:  { type: Number, default: 0, min: 0, select: false },
  created_at:             { type: Date, default: Date.now },
})
RecruitmentCycleSchema.index(
  { accepting_applications: 1 },
  { unique: true, partialFilterExpression: { accepting_applications: true } },
)
export const RecruitmentCycle = models.RecruitmentCycle || model('RecruitmentCycle', RecruitmentCycleSchema)

// ─── Essay Prompts ───────────────────────────────────────────
const EssayPromptSchema = new Schema({
  cycle_id:        { type: Schema.Types.ObjectId, ref: 'RecruitmentCycle', required: true },
  question_number: { type: Number, required: true },
  prompt:          { type: String, required: true },
  description:     { type: String, default: null },
  criterion1:      { type: String, default: null },
  criterion2:      { type: String, default: null },
})
EssayPromptSchema.index({ cycle_id: 1, question_number: 1 }, { unique: true })
export const EssayPrompt = models.EssayPrompt || model('EssayPrompt', EssayPromptSchema)

// ─── Applicants ──────────────────────────────────────────────
const ApplicantSchema = new Schema({
  cycle_id:       { type: Schema.Types.ObjectId, ref: 'RecruitmentCycle', required: true },
  first_name:     { type: String, required: true },
  last_name:      { type: String, required: true },
  email:          { type: String, required: true, lowercase: true, trim: true },
  // Intentionally nullable on legacy rows. Only submissions created after the
  // hardened Google flow carry verifiable provenance.
  identity_provider:    { type: String, enum: ['google', 'google-berkeley', null], default: null },
  identity_verified_at: { type: Date, default: null },
  phone:          { type: String, default: null },
  year:           { type: String, default: null },  // Freshman | Sophomore | Junior | Senior (legacy rows: grad year e.g. "2027")
  transfer:       { type: Boolean, default: false },
  major:          { type: String, default: null },
  gender:         { type: String, default: null },
  race:           { type: [String], default: [] },
  desired_roles:  { type: String, default: null },
  linkedin:       { type: String, default: null },
  website:        { type: String, default: null },
  time_commitment:{ type: String, default: null },
  infosessions_attended: { type: [String], default: [] },
  resume_base64:  { type: String, default: null, select: false, maxlength: 4_300_000 }, // base64-encoded PDF
  created_at:     { type: Date, default: Date.now },
})
ApplicantSchema.index(
  { cycle_id: 1, email: 1 },
  {
    unique: true,
    name: 'uniq_cycle_email_ci_v1',
    collation: { locale: 'en', strength: 2 },
    partialFilterExpression: { email: { $type: 'string' } },
  },
)
ApplicantSchema.index({ cycle_id: 1, created_at: 1 })
export const Applicant = models.Applicant || model('Applicant', ApplicantSchema)

// ─── Public API Rate Limits ──────────────────────────────────
// One document per HMAC-hashed client/window. MongoDB makes increments atomic,
// and the TTL index clears expired buckets automatically.
const RateLimitSchema = new Schema({
  _id:        { type: String },
  count:      { type: Number, required: true, default: 0 },
  expires_at: { type: Date, required: true },
}, { _id: false })
RateLimitSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 })
export const RateLimit = models.RateLimit || model('RateLimit', RateLimitSchema)

// ─── Essay Responses ─────────────────────────────────────────
const EssayResponseSchema = new Schema({
  applicant_id: { type: Schema.Types.ObjectId, ref: 'Applicant', required: true },
  prompt_id:    { type: Schema.Types.ObjectId, ref: 'EssayPrompt', required: true },
  response:     { type: String, required: true, maxlength: 1500 },
})
EssayResponseSchema.index({ applicant_id: 1, prompt_id: 1 }, { unique: true })
export const EssayResponse = models.EssayResponse || model('EssayResponse', EssayResponseSchema)

// ─── Rounds ──────────────────────────────────────────────────
const RoundSchema = new Schema({
  cycle_id:           { type: Schema.Types.ObjectId, ref: 'RecruitmentCycle', required: true },
  name:               { type: String, required: true },
  order_index:        { type: Number, required: true },
  grading_type:       { type: String, enum: ['rubric', 'interview', null], default: null },
  status:             { type: String, enum: ['pending', 'grading', 'deliberating', 'ended'], default: 'pending' },
  interview_form_url: { type: String, default: null },
  role:               { type: String, enum: ['curriculum', 'developer', null], default: null },
  review_submission_count: { type: Number, default: 0, min: 0 },
  lifecycle_write_count: { type: Number, default: 0, min: 0, select: false },
  created_at:         { type: Date, default: Date.now },
})
RoundSchema.index(
  { cycle_id: 1, role: 1, order_index: 1 },
  { unique: true, name: 'uniq_round_position_v2' },
)
export const Round = models.Round || model('Round', RoundSchema)

// ─── Grader Assignments ──────────────────────────────────────
const GraderAssignmentSchema = new Schema({
  round_id:     { type: Schema.Types.ObjectId, ref: 'Round', required: true },
  applicant_id: { type: Schema.Types.ObjectId, ref: 'Applicant', required: true },
  grader_email: { type: String, required: true, lowercase: true, trim: true },
  assigned_at:  { type: Date, default: Date.now },
  submission_count: { type: Number, default: 0, min: 0 },
})
GraderAssignmentSchema.index({ round_id: 1, applicant_id: 1, grader_email: 1 }, { unique: true })
GraderAssignmentSchema.index({ grader_email: 1, round_id: 1, applicant_id: 1 })
GraderAssignmentSchema.index({ grader_email: 1, applicant_id: 1 })
export const GraderAssignment = models.GraderAssignment || model('GraderAssignment', GraderAssignmentSchema)

// ─── Reviews ─────────────────────────────────────────────────
const ReviewSchema = new Schema({
  round_id:     { type: Schema.Types.ObjectId, ref: 'Round', required: true },
  applicant_id: { type: Schema.Types.ObjectId, ref: 'Applicant', required: true },
  grader_email: { type: String, required: true, lowercase: true, trim: true },
  r0: { type: Number, required: true, min: 1, max: 3 },
  r1: { type: Number, required: true, min: 1, max: 4 },
  r2: { type: Number, required: true, min: 1, max: 4 },
  r3: { type: Number, required: true, min: 1, max: 4 },
  r4: { type: Number, required: true, min: 1, max: 4 },
  r5: { type: Number, required: true, min: 1, max: 4 },
  r6: { type: Number, required: true, min: 1, max: 4 },
  r7: { type: Number, required: true, min: 1, max: 4 },
  r8: { type: Number, required: true, min: 1, max: 4 },
  r9: { type: Number, required: true, min: 1, max: 4 },
  comment0: { type: String, required: true, trim: true, maxlength: 2000 },
  comment1: { type: String, required: true, trim: true, maxlength: 2000 },
  comment2: { type: String, required: true, trim: true, maxlength: 2000 },
  comment3: { type: String, required: true, trim: true, maxlength: 2000 },
  comment4: { type: String, required: true, trim: true, maxlength: 2000 },
  submitted_at: { type: Date, default: Date.now },
})
ReviewSchema.index({ round_id: 1, applicant_id: 1, grader_email: 1 }, { unique: true })
ReviewSchema.index({ grader_email: 1, round_id: 1, applicant_id: 1 })
export const Review = models.Review || model('Review', ReviewSchema)

// ─── Sessions (Deliberation) ─────────────────────────────────
const SessionSchema = new Schema({
  _id:        { type: String },  // 6-char alphanumeric custom ID
  round_id:   { type: Schema.Types.ObjectId, ref: 'Round', default: null },
  name:       { type: String, required: true },
  status:     { type: String, enum: ['active', 'ended'], default: 'active' },
  created_by: { type: String, required: true, lowercase: true, trim: true },
  anonymous:  { type: Boolean, default: false },
  one_vouch_per_member: { type: Boolean, default: false },
  show_vouch_counts: { type: Boolean, default: true },
  focused_candidate_id: { type: Schema.Types.ObjectId, ref: 'Candidate', default: null },
  focus_version: { type: Number, default: 0 },
  role:       { type: String, enum: ['curriculum', 'developer', null], default: null },
  candidate_import_count: { type: Number, default: 0, min: 0 },
  activity_write_count: { type: Number, default: 0, min: 0, select: false },
  created_at: { type: Date, default: Date.now },
}, { _id: false })
SessionSchema.index(
  { round_id: 1, role: 1 },
  {
    unique: true,
    name: 'uniq_active_session_role_v2',
    partialFilterExpression: { status: 'active', round_id: { $type: 'objectId' } },
  },
)
export const Session = models.Session || model('Session', SessionSchema)

// ─── Candidates ──────────────────────────────────────────────
const CandidateSchema = new Schema({
  session_id:   { type: String, ref: 'Session', required: true },
  applicant_id: { type: Schema.Types.ObjectId, ref: 'Applicant', default: null },
  name:         { type: String, required: true },
  data:         { type: Schema.Types.Mixed, default: {} },
  status:       { type: String, enum: ['pending', 'accepted', 'rejected', 'hold'], default: 'pending' },
  activity_write_count: { type: Number, default: 0, min: 0, select: false },
  created_at:   { type: Date, default: Date.now },
})
CandidateSchema.index({ session_id: 1, created_at: 1 })
CandidateSchema.index(
  { session_id: 1, applicant_id: 1 },
  {
    unique: true,
    name: 'uniq_session_applicant_v1',
    partialFilterExpression: { applicant_id: { $type: 'objectId' } },
  },
)
export const Candidate = models.Candidate || model('Candidate', CandidateSchema)

// ─── Votes ───────────────────────────────────────────────────
const VoteSchema = new Schema({
  candidate_id: { type: Schema.Types.ObjectId, ref: 'Candidate', required: true },
  voter_name:   { type: String, required: true },           // display name (UI)
  voter_email:  { type: String, default: null, lowercase: true, trim: true }, // owner (auth) — null on legacy rows
  vote_type:    { type: String, enum: ['vouch', 'anti_vouch', 'red_flag'], required: true },
})
// Sparse unique: only enforced on rows that have a voter_email (i.e. created after the migration).
VoteSchema.index(
  { candidate_id: 1, voter_email: 1, vote_type: 1 },
  { unique: true, partialFilterExpression: { voter_email: { $type: 'string' } } },
)
export const Vote = models.Vote || model('Vote', VoteSchema)

// ─── Candidate Notes ─────────────────────────────────────────
const CandidateNoteSchema = new Schema({
  candidate_id: { type: Schema.Types.ObjectId, ref: 'Candidate', required: true },
  author:       { type: String, required: true },                 // display name (UI)
  author_email: { type: String, default: null, lowercase: true, trim: true }, // owner (auth); null on legacy rows
  content:      { type: String, required: true },
  type:         { type: String, enum: ['note', 'red_flag'], default: 'note' },
  created_at:   { type: Date, default: Date.now },
})
CandidateNoteSchema.index({ candidate_id: 1, created_at: 1 })
export const CandidateNote = models.CandidateNote || model('CandidateNote', CandidateNoteSchema)

// ─── Imported Coffee Chat Notes ─────────────────────────────
// Cycle-scoped so one import is available in every deliberation round.
const CoffeeChatNoteSchema = new Schema({
  cycle_id:       { type: Schema.Types.ObjectId, ref: 'RecruitmentCycle', required: true },
  applicant_id:   { type: Schema.Types.ObjectId, ref: 'Applicant', required: true },
  applicant_name: { type: String, required: true },
  chatter_name:   { type: String, required: true },
  notes:          { type: String, default: '' },
  is_coffee_chat: { type: Boolean, default: true },
  recommended_overall: { type: Boolean, default: null },
  chat_date:      { type: String, default: null }, // YYYY-MM-DD; date-only avoids timezone shifts
  other_notes:    { type: String, default: null },
  imported_by:    { type: String, required: true, lowercase: true, trim: true },
  imported_at:    { type: Date, default: Date.now },
})
CoffeeChatNoteSchema.index({ cycle_id: 1, applicant_id: 1, chat_date: 1 })
export const CoffeeChatNote = models.CoffeeChatNote || model('CoffeeChatNote', CoffeeChatNoteSchema)

// ─── Session Members ─────────────────────────────────────────
const SessionMemberSchema = new Schema({
  session_id: { type: String, ref: 'Session', required: true },
  user_email: { type: String, required: true, lowercase: true, trim: true },
  joined_at:  { type: Date, default: Date.now },
  activity_write_count: { type: Number, default: 0, min: 0, select: false },
})
SessionMemberSchema.index({ session_id: 1, user_email: 1 }, { unique: true })
export const SessionMember = models.SessionMember || model('SessionMember', SessionMemberSchema)

// ─── Session Bans ────────────────────────────────────────────
// Emails barred from joining a specific deliberation session.
const SessionBanSchema = new Schema({
  session_id: { type: String, ref: 'Session', required: true },
  email:      { type: String, required: true, lowercase: true, trim: true },
  banned_by:  { type: String, required: true, lowercase: true, trim: true },
  banned_at:  { type: Date, default: Date.now },
})
SessionBanSchema.index({ session_id: 1, email: 1 }, { unique: true })
export const SessionBan = models.SessionBan || model('SessionBan', SessionBanSchema)

// helper: convert mongoose doc to plain object with id string
export function toJSON<T>(doc: mongoose.Document & T): T & { id: string } {
  const obj = doc.toObject({ virtuals: false }) as Record<string, unknown>
  const id = obj._id?.toString() ?? ''
  delete obj._id
  delete obj.__v
  // Convert ObjectId fields to strings
  for (const key of Object.keys(obj)) {
    if (obj[key] instanceof mongoose.Types.ObjectId) {
      obj[key] = (obj[key] as mongoose.Types.ObjectId).toString()
    }
  }
  return { ...obj, id } as T & { id: string }
}
