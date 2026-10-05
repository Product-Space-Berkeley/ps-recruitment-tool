// Fixed review fields used for each essay question (index 0 → Q1, 1 → Q2, 2 → Q3).
// A cycle has 1–3 prompts; slots for questions it doesn't have stay null.
export const ESSAY_REVIEW_SLOTS = [
  { commentKey: 'comment1', rKeys: ['r4', 'r5'] },
  { commentKey: 'comment2', rKeys: ['r8', 'r9'] },
  { commentKey: 'comment3', rKeys: ['r6', 'r7'] },
] as const
