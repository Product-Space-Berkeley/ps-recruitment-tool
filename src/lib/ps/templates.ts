import type { Category, Purpose, Question, SectionKind, Structure } from './rubricV2'
import { POINTS_POLICY } from './points'
// Starting rubrics transcribed from PS's FA26 Google Forms. Identity questions (grader, candidate, email,
// grade) are omitted because the site fills them in. Leadership edits dates and logistics per cycle.
type Q = Partial<Question> & { label: string }
function section(id: string, name: string, description = '', kind: SectionKind = 'scoring', extra: Partial<Category> = {}): Category {
  return { id, name, description, kind, order: 0, weight_bps: null, ...extra }
}
function points(id: string, category_id: string, purpose: Purpose, values: (number | [number, string])[], q: Q): Question {
  return { id, category_id, description: '', order: 0, purpose, format: 'numeric_choice', required: true, confirmed: true, scale: null, options: values.map(v => Array.isArray(v) ? { value: v[0], label: v[1] } : { value: v, label: '' }), ...q }
}
const zeroToThree = [0, 1, 2, 3]
const criterion = (id: string, category_id: string, q: Q, values: (number | [number, string])[] = zeroToThree) => points(id, category_id, 'SCORED_CRITERION', values, q)
const bonus = (id: string, category_id: string, label: string, values: number[] = [1, 0]) => points(id, category_id, 'BONUS', values, { label })
const flag = (id: string, category_id: string, label: string, purpose: Purpose = 'RED_FLAG') => points(id, category_id, purpose, [-1, 0], { label })
function unscored(id: string, category_id: string, format: Question['format'], label: string, required: boolean, extra: Partial<Question> = {}): Question {
  return { id, category_id, label, description: '', order: 0, purpose: 'QUALITATIVE', format, required, confirmed: true, scale: null, options: [], ...extra }
}
function choice(id: string, category_id: string, label: string, options: string[], extra: Partial<Question> = {}): Question {
  return unscored(id, category_id, 'single_choice', label, true, { purpose: 'DECISION_SIGNAL', options: options.map((label, i) => ({ value: `option_${i + 1}`, label })), ...extra })
}
function build(name: string, description: string, categories: Category[], questions: Question[]): Structure {
  return { schema_version: 2, scoring_policy: POINTS_POLICY, weighting: 'unconfigured', name, description, categories: categories.map((c, order) => ({ ...c, order })), questions: questions.map((q, order) => ({ ...q, order })) }
}
const SCALE_NOTE = '0 = no indications of the rubric item\n1 = weak indications\n2 = strong indications\n3 = exceptional (rare)'

export function writtenAppTemplate(): Structure {
  const lowHigh = { min_label: 'No indications of the rubric item', max_label: 'Exceptional' }
  return build('Written App / Resume Screening', 'Scoring scale:\n0: Not applicable, incoherent or no evidence of the rubric item\n1: Needs significant improvement\n2: Meets expectations, but could be stronger\n3: Outstanding\n\nThe key theme of this round is Commitment & Contribution Potential. This round focuses on how much effort and commitment a candidate has shown, both through their past experiences and throughout recruitment. We also want an early sense of whether they would be an engaged, positive contributor to the PS community.', [
    section('resume_freshman', 'Resume Scoring [Freshman]', `Scoring scale (0–3)\n${SCALE_NOTE}\n\nKey things to keep in mind while you are grading:\n- Will they show up and put in the work?\n- When they show up, will they contribute something meaningful?`, 'scoring', { show_for_years: ['Freshman'] }),
    section('resume_upper', 'Resume Scoring [Sophomore, Junior & Senior]', `Scoring scale (0–3)\n${SCALE_NOTE}\n\nKey things to keep in mind while you are grading:\n- Will they show up and put in the work?\n- When they show up, will they contribute something meaningful?`, 'scoring', { show_for_years: ['Sophomore', 'Junior', 'Senior'] }),
    section('written_q1', 'Written Q1', 'Question 1: Tell us about something you once struggled with but have since improved at. What steps did you take to grow, and what did you learn from the process? [250 words max]\n\nCan this person honestly reflect on a weakness, take meaningful steps to improve, and learn from the experience?\n\nWhat to look for:\n- Clearly identifies a real struggle or weakness\n- Takes ownership rather than blaming circumstances or other people\n- Explains specific steps they took to improve\n- Shows persistence, consistency, or willingness to be uncomfortable\n- Demonstrates genuine reflection on what they learned\n\nStrong response: Shows a clear arc of struggle → action → improvement → reflection. The specific struggle does not need to be impressive; the quality of their growth and reflection matters more.\n\nWeak response: Focuses mostly on the story itself, gives vague steps like "I worked harder," exaggerates a minor weakness, or does not explain what they actually learned.\n\nNOTE: take into account the applicant\'s grade level and grade them similarly to others in the same grade.'),
    section('written_q2', 'Written Q2', 'Question 2: If you had an extra 30 minutes in a day, what would you spend it on and why? [50 words max]'),
    section('notes', 'Notes', 'Please include any and all thoughts you may have, in case you forget by the time deliberations roll around.'),
  ], [
    criterion('fr_initiative', 'resume_freshman', { label: 'Initiative & Commitment', description: 'Do they show early signs of taking initiative and committing to the things they care about?\n\nSignals: started a club, project, or small initiative; organized an event; pursued a personal project; stayed involved in an activity over time; early leadership experience.\n\nNOTE: if they removed everything from high school give them a 2 and note that in the Notes section.', ...lowHigh }),
    criterion('fr_impact', 'resume_freshman', { label: 'Impact & Breadth of Engagement', description: "Have they meaningfully contributed to the things they've been involved in, and do they show a range of interests or experiences?\n\nSignals: early outcomes or metrics; involvement across different activities or interests; experiences in different communities; evidence of depth in at least one area. e.g. Organized a fundraiser that raised $2,000.", ...lowHigh }),
    flag('fr_overcommitted', 'resume_freshman', 'Penalty: overcommitted', 'PENALTY'),
    flag('fr_exaggerated', 'resume_freshman', 'Penalty: exaggerated / unclear claims', 'PENALTY'),
    criterion('up_initiative', 'resume_upper', { label: 'Initiative & Demonstrated Commitment', description: "Have they consistently taken ownership and demonstrated sustained commitment as they've gained more opportunities?\n\nSignals: founded or led an organization/initiative; owned a significant project; took on increasing responsibility; independently pushed work forward; demonstrated leadership beyond a title; sustained involvement with clear progression.", ...lowHigh }),
    criterion('up_impact', 'resume_upper', { label: 'Impact & Results', description: 'Have they created tangible results through their work while developing meaningful depth and breadth in their experiences?\n\nSignals: clear outcomes or measurable results; drove growth or improvement; work affected users or an organization; tangible individual contribution; depth in an area of interest; experience across different functions, industries, or communities.', ...lowHigh }),
    flag('up_overcommitted', 'resume_upper', 'Penalty: overcommitted', 'PENALTY'),
    flag('up_exaggerated', 'resume_upper', 'Penalty: exaggerated / unclear claims', 'PENALTY'),
    choice('up_interview_level', 'resume_upper', 'Next round interview level', ['Intermediate (sophomore with no prior experience & junior transfers)', 'Advanced (sophomore with prior experience & junior non-transfers)'], { description: 'Prior experience: in another consulting club or past product internship experience.' }),
    criterion('q1_specificity', 'written_q1', { label: 'Specificity & Depth', description: 'Does the response use concrete details and specific actions rather than staying vague or generic?\nSignals: clear example, specific steps taken, real obstacles, evidence of effort, details that make the story feel personal and credible.' }, [[0, 'No clear struggle or steps taken'], [1, 'Identifies a struggle, but is vague or generic about the struggle and/or the improvements'], [2, 'Clearly explains the struggle and gives specific, intentional steps taken to improve'], [3, 'Highly specific and compelling growth process with clear evidence of sustained effort, initiative, and/or pushing through setbacks']]),
    criterion('q1_reflection', 'written_q1', { label: 'Reflection & Growth', description: 'Does the candidate show self-awareness and explain what they learned from the experience?\nSignals: honest reflection, ownership of the struggle, clear growth, thoughtful lessons, evidence that the experience changed how they approach challenges now.' }, [[0, 'Little to no reflection'], [1, 'Basic/generic takeaway or lesson without much insight into how they changed'], [2, 'Thoughtfully reflects on the experience and clearly explains what they learned or how they grew'], [3, 'Deep, genuine self-reflection that shows lasting change in how they think or act for future challenges']]),
    unscored('q1_red_flags', 'written_q1', 'long_text', 'Please note any optional red flags or concerns', false),
    criterion('q2_personality', 'written_q2', { label: 'Personality & Authenticity', description: 'Core question: Does this answer give us a real sense of who they are?' }, [[0, 'Generic answer with little explanation or personality'], [1, 'Some personality comes through, but the answer feels surface-level'], [2, 'Clear sense of their interests/personality with a genuine reason behind their choice'], [3, 'Memorable, authentic answer that gives you a strong sense of who they are']]),
    unscored('notes_thoughts', 'notes', 'long_text', 'Anything good or bad about their application?', false),
    criterion('notes_show_up', 'notes', { label: 'Does it seem like this candidate would show up and put in the work?' }, [[0, 'No'], [1, 'Yes']]),
    criterion('notes_contribute', 'notes', { label: 'When they show up, do you think they would contribute something meaningful?' }, [[0, 'No'], [1, 'Yes']]),
  ])
}

export function pdInterviewTemplate(): Structure {
  const disagreement = 'If you and your co-interviewer disagree on a score, put down the higher score and leave a note below.'
  return build('PD Design Interview', 'Fill this out after the interviewee has left, using your interview notes.', [
    section('instructions', 'Instructions for conducting the interview', 'Before the interview\n- Create a copy of the notes template and paste the link below.\n- Move the document into the interview notes folder.\n- Take detailed notes on their behavioral and PD answers. Use the notes to complete this form after the interview.\n\nKicking off the interview\n- Greet the candidate and ask about their day, classes, etc. to make them feel comfortable. Our goal is to make this more a conversation and less a formal interview.\n- Give a quick rundown: quick introduction, then a 20 minute Product Design question.\n- Pause and let the candidate ask any initial questions before proceeding.\n\nBehavioral questions (5–10 mins)\n- Tell us about yourself and why product?\n\nProduct Design question (20 mins)\n- Find the bucket your interviewee is assigned to and ask the question for that day and bucket.\n\nWrap up\n- Congratulate them on finishing the interview. If time permits, let them ask any final questions.\n- Share when decisions for the next round (take-home) will be released.\n- Share the Social Night date and time. Moving on to the final take-home round is a package deal with Social Night, and attendance is mandatory.', 'instructions'),
    section('pd_guide', 'Product Design question', 'Scoring scale:\n0 – Not applicable / incoherent / no trace of rubric item\n1 – Some effort demonstrated towards rubric item\n2 – Meets rubric item but definitely not super great\n3 – Outstanding\n\nMake the interviewee feel comfortable. It\'s expected that they\'re nervous. They have 15–20 minutes to answer.\n\nTips:\n- Clarifying questions are critical. Try to have the interviewee arrive at a specific user group; this leads to more in-depth, creative solutions.\n- Be helpful! Don\'t just say "open to interpretation" when they ask clarifying questions. Help them narrow the scope, but user groups should be decided by the interviewee.\n- ALWAYS ASK FOR PRIORITIZATION!', 'interview_guide'),
    section('product_design', 'Product Design', `Score their answer to the product design question. ${disagreement}`),
    section('professionalism', 'Professionalism', `Score their answers to both the behaviorals and the product design question. ${disagreement}`),
    section('green_flags', 'Green Flags', 'Brownie points we give out. Select the points if the statement applies, 0 if not.'),
    section('red_flags', 'Red Flags', 'Select −1 if the statement applies, 0 if not.'),
    section('wrap_up', 'Overall'),
  ], [
    unscored('notes_link', 'instructions', 'url', "Link to this applicant's interview notes document", true),
    criterion('easy_to_follow', 'product_design', { label: 'OVERALL: easy to follow response' }),
    criterion('breadth', 'product_design', { label: 'OVERALL: considers a breadth of ideas (variety of stakeholders, use cases etc)' }),
    criterion('clarifying', 'product_design', { label: 'CLARIFYING QUESTIONS: well thought-out clarifying questions that narrow down the prompt' }),
    criterion('user_groups', 'product_design', { label: 'USER GROUPS: splits the users really well with minimal overlap, and clearly defines the user personas attaching key traits with each user group' }),
    criterion('pain_points', 'product_design', { label: 'PAIN POINTS: goes through the user journey for the product from beginning to end. If not journey, the pain points are unique to that user. The problems make sense and it makes sense why you should build a solution for it' }),
    criterion('solutions', 'product_design', { label: "SOLUTIONS: all unique and creative and includes a moonshot idea. Solutions also don't already exist commonly." }),
    criterion('prioritization', 'product_design', { label: 'Reasonable prioritization with clear rationale (some nudging/guidance is perfectly fine). Constantly aligning with customer wants/needs and business goals' }),
    criterion('creativity', 'product_design', { label: 'OVERALL: showed lots of creativity and brought in outside knowledge and anecdotes' }),
    unscored('pd_disagreements', 'product_design', 'long_text', 'Score disagreements', false),
    criterion('communication', 'professionalism', { label: 'Eloquent and effective communication' }),
    criterion('relevance', 'professionalism', { label: 'Answers are directly relevant to the interview questions' }),
    criterion('attitude', 'professionalism', { label: 'Professional and amicable attitude' }),
    unscored('pro_disagreements', 'professionalism', 'long_text', 'Score disagreements', false),
    bonus('unique_solution', 'green_flags', 'Unique consideration/solution that you have not thought about previously', [2, 1, 0]),
    bonus('conversational', 'green_flags', 'Does well to make the interview seem less like an interview and more a back-and-forth conversation', [2, 1, 0]),
    bonus('early_prioritization', 'green_flags', 'Interviewee starts prioritization before prompted to'),
    bonus('roadmap', 'green_flags', 'Provides clear roadmap/sign posting prior to response (e.g. "This is my roadmap before I get started: … Is that fine with you?")'),
    bonus('minimal_nudging', 'green_flags', 'Needs no/minimal nudging to arrive at compelling, intuitive solutions'),
    bonus('success_metrics', 'green_flags', 'Thinks of success metrics after the PD interview'),
    flag('no_clarifying', 'red_flags', 'Jumps into their answer without asking any clarifying questions or considering pain points'),
    flag('misinterprets', 'red_flags', 'Misinterprets the question without corrective action'),
    flag('bad_assumptions', 'red_flags', 'Makes dangerous/incorrect assumptions without valid justification'),
    flag('rude', 'red_flags', 'Rude to the interviewer or disengaged from the conversation'),
    flag('late', 'red_flags', 'Shows up late to the interview without prior communication/valid reason'),
    choice('tech_bar', 'wrap_up', 'Does this candidate meet the technical bar?', ['yupp!!', 'ehh', 'nope!'], { description: 'See the tech rubric.' }),
    unscored('comments', 'wrap_up', 'long_text', 'Comments', true),
  ])
}

export function finalRoundTemplate(): Structure {
  const quality = 'Scoring scale:\n0 = Not demonstrated\n1 = Weak\n2 = Average\n3 = Outstanding'
  const half = [[0, 'Weak'], [0.5, 'Average'], [1, 'Outstanding']] as [number, string][]
  return build('Final Round: Take-home', 'Fill this out after the interviewee has left, using your interview notes.', [
    section('instructions', 'Final round interviewer instructions', 'Before the interview\n- Create a copy of the Final Round Interview Notes Template and paste the link below.\n- Move the document into the Final Round Interview Notes folder.\n- Plan to take detailed notes during the interview; you\'ll use them to complete this form afterwards.\n\nKicking off the interview\n- Greet the candidate and start with light conversation (their day, classes, etc.). Our goal is a conversation, not a formal interview.\n- Congratulate them on making it to the final round.\n- Walk them through the structure: 5 min set-up (screen-sharing or presenting from their own device) + 10–15 min presentation (MAX 12 MIN, have a timer ready and offer time updates) + 10 min of follow-up questions.\n- Pause and let the candidate ask questions before starting.\n\nDuring the interview\n- Brief notes or flashcards on their phone are okay (but not preferred). Note excessive reliance.\n- Feel free to pull up their deck on your own laptop to follow along.\n\nFollow-up questions\n- Ask the three required follow-up questions.\n- Use any remaining time for additional follow-ups.\n\nWrapping up\n- Congratulate the candidate and invite final questions if time allows.\n- Share Social Night logistics (attendance is mandatory) and when final decisions will be released.\n- Thank them again for their time and effort.', 'instructions'),
    section('users', 'USERS: User Groups', quality),
    section('pain_points', 'PAIN POINTS: Identification and Problem Definition', quality),
    section('solutions', 'SOLUTIONS: Quality & Tradeoffs', quality),
    section('decision_quality', 'CONTENT: Decision Quality', quality),
    section('follow_ups', 'CONTENT: Follow-Ups', quality),
    section('public_speaking', 'PRESENTATION: Public Speaking', '0 = Weak\n0.5 = Average\n1 = Outstanding'),
    section('decking', 'PRESENTATION: Decking', '0 = Weak\n0.5 = Average\n1 = Outstanding'),
    section('bonus_red_flags', 'Bonus Points & Red Flags'),
    section('comments', 'Comments'),
  ], [
    unscored('notes_link', 'instructions', 'url', 'Link to the interview notes', true),
    criterion('friend_user_group', 'users', { label: 'How well did the applicant identify their friend as a clear user group? How well does the applicant explain which user group they prioritized and the reasoning behind their prioritization?' }),
    criterion('friend_specific', 'users', { label: "Is the friend's problem genuinely specific to them (not a generic complaint anyone could have), and did the applicant express this in a way that reflects real knowledge of this person and not just an invented persona?" }),
    criterion('empathy', 'users', { label: "Does the applicant demonstrate a deep, empathetic understanding for the various users within this given system and specifically hone in on their chosen user group's reality (goals, constraints, etc) without making surface-level assumptions?" }),
    criterion('assumes_overlooks', 'pain_points', { label: 'Does the candidate correctly identify what the product assumes or overlooks rather than describing a surface-level annoyance?' }),
    criterion('core_problem', 'pain_points', { label: 'Is one core problem intentionally prioritized with clear reasoning (e.g., impact, severity, leverage)?' }),
    criterion('overlooked_why', 'pain_points', { label: 'Does the applicant explain why this problem is often overlooked or deprioritized in traditional product decisions?' }),
    criterion('traceable_solution', 'solutions', { label: "Does the applicant propose a clear solution that's a direct, traceable response to the specific problem they diagnosed? Do they explain exactly how it changes their friend's day-to-day experience, not just what it does?" }),
    criterion('tradeoffs', 'solutions', { label: 'Is the chosen solution intentionally selected, with clear tradeoffs (user impact, feasibility, constraints)?' }),
    criterion('improves_experience', 'solutions', { label: "Does the solution meaningfully improve the friend's actual experience or replace/reduce a workaround they'd already built?" }),
    criterion('progression', 'decision_quality', { label: 'Does the overall presentation show a clear progression from user → problem → solution?' }),
    criterion('prioritizes_each_stage', 'decision_quality', { label: 'Does the applicant prioritize at every stage and do so in a clear way that evaluates tradeoffs clearly?' }),
    criterion('product_sense', 'follow_ups', { label: 'Product Sense', description: "Questions that cover product sense:\n1. What would cause this product to fail even if it were well-designed?\n2. Convince me this is worth the engineering team's time over the other five things on their roadmap.\n3. Who loses if you ship this — is there a version of your friend, or another user type, this makes worse?" }),
    criterion('self_awareness', 'follow_ups', { label: 'Character: Self awareness & Intellectual Honesty', description: "Questions that cover character:\n1. What's the strongest argument against your own solution?\n2. What's the riskiest assumption in your solution — the one thing that, if wrong, breaks everything?\n3. If your friend used this tomorrow and hated it, what's the first thing you'd guess went wrong?" }),
    criterion('effort_empathy', 'follow_ups', { label: 'Effort & Empathy Depth', description: "Questions that cover effort & empathy:\n1. What's something about them that didn't make it into the deliverable but shaped how you thought about the solution?\n2. Is there a version of this problem that's unique to them, versus something you think is true of everyone?\n3. Can you walk us through what you did to understand this user from start to finish, and which part took the most effort?" }),
    ...['Clarity of Explanation', 'Presence and Confidence', 'Pacing and Structure', 'Language Choice', 'Eye Contact & Engagement', 'Storytelling'].map((label, i) => criterion(`speaking_${i + 1}`, 'public_speaking', { label }, half)),
    criterion('slide_count', 'decking', { label: 'Fits within 4–5 content slides' }, half),
    criterion('time_limit', 'decking', { label: 'Presentation length within 12 minutes' }, [[0, "More than 1 min over or didn't finish within allotted time"], [0.5, '1 min over'], [1, 'Within 12 minutes']]),
    criterion('easy_slides', 'decking', { label: 'Easy to follow slides, not overly text-heavy' }, half),
    criterion('deck_supports', 'decking', { label: 'Deck supports the story (doesn’t replace it)' }, [[0, 'Interviewee is reading off the slides'], [0.5, 'Average'], [1, 'Outstanding']]),
    bonus('would_implement', 'bonus_red_flags', 'Bonus: Would you implement their solution?'),
    bonus('standout', 'bonus_red_flags', 'Bonus: Standout insight or originality?'),
    bonus('friendly', 'bonus_red_flags', 'Bonus: Are they friendly and amiable?'),
    flag('reading_script', 'bonus_red_flags', 'Red Flag: Reading off the screen or overly dependent on script'),
    flag('late_unprofessional', 'bonus_red_flags', 'Red Flag: Showed up late without reason or displayed unprofessional behavior'),
    flag('ai_generated', 'bonus_red_flags', 'Red Flag: Did their content (ideas or text) seem AI-generated?'),
    unscored('comments', 'comments', 'long_text', 'Additional comments? Did you and your partner disagree on any scores?', true, { description: "Comments are required for this round to help you recall your overall thoughts or anything that isn't captured in this rubric." }),
  ])
}

export const PS_STANDARD_ROUNDS = [
  { key: 'written_app', name: 'Written App / Resume Screening', evaluation_type: 'rubric', assignment_mode: 'individual', template: writtenAppTemplate },
  { key: 'pd_interview', name: 'PD Design Interview', evaluation_type: 'interview', assignment_mode: 'pair', template: pdInterviewTemplate },
  { key: 'final', name: 'Final Round: Take-home + Social', evaluation_type: 'interview', assignment_mode: 'pair', template: finalRoundTemplate },
] as const
export const RUBRIC_TEMPLATES = PS_STANDARD_ROUNDS.map(r => ({ key: r.key, name: r.name, build: r.template }))
