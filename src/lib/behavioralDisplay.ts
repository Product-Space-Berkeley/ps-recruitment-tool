// FA26 behavioral guide and form scales, verified against the original form.
// Presentation only: never normalize or change the stored raw averages.
const questions: Record<string, string> = {
  behavioral_6: 'Tell me about yourself.',
  behavioral_8: 'What are you involved in this semester besides classes? What do you like to do outside of school?',
  behavioral_12: 'Tell us about an interaction, value, or facet of PlexTech that resonates with you the most and explain why.',
  behavioral_14: 'Tell us about something you cared about enough to go beyond what was expected, even when no one told you to. What did you do and why did it matter to you?',
  behavioral_16: 'Tell me about a time where you failed and what steps you took afterwards?',
  behavioral_18: 'Describe a time when you were in a leadership position and you had to work with a difficult team member or had conflict in a team. How did you handle it?',
  behavioral_20: 'What’s something you learned the hard way but now appreciate?',
  behavioral_22: 'What kind of person would your friends describe you as?',
  behavioral_24: 'If you could design a social for PlexTech this semester, what would it be, and why?',
  behavioral_25: 'Rate the applicant’s passion for PlexTech and its values.',
  behavioral_26: 'Rate the applicant’s ability to explain challenges and lessons learned: resiliency and coachability.',
  behavioral_27: 'How would you rate this applicant’s ability to communicate and collaborate with others in a team setting?',
  behavioral_28: 'Rate this applicant as an overall fit into PlexTech, both technically and culturally.',
}
export const BEHAVIORAL_AVERAGE_MAX = (13 * 4 + 6) / 14
export function behavioralQuestion(key: string, fallback: string, role?: string | null): string {
  if (key === 'behavioral_10') {
    if (role === 'curriculum') return 'What technical experience do you think our curriculum track can provide you that you can’t get from your courses, external internships, or personal projects?'
    if (role === 'developer') return 'What do you think our community can provide you that you can’t get from your courses, external internships, or projects?'
    return 'What can PlexTech’s curriculum track or community provide that you can’t get from courses, internships, or projects?'
  }
  return questions[key] ?? fallback
}
export function behavioralScoreSuffix(key: string): string {
  if (key === 'behavioral_28') return ' / 6'
  return key === 'behavioral_10' || Object.hasOwn(questions, key) ? ' / 4' : ''
}
export function behavioralNoteLabel(label: string, role?: string | null): string {
  const match = /question\s+(1|2|3a|3b|4a|4b|4c|4d|5a|5b)\b/i.exec(label)
  const keys: Record<string, number> = { '1': 6, '2': 8, '3a': 10, '3b': 12, '4a': 14, '4b': 16, '4c': 18, '4d': 20, '5a': 22, '5b': 24 }
  return match ? behavioralQuestion(`behavioral_${keys[match[1].toLowerCase()]}`, label, role) : label
}
