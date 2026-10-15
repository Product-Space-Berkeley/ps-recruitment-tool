export const DEFAULT_APPLICATION_WORDING = {
  meeting_prompt: 'Our mandatory general meetings are weekly on Thursdays from 8:00 - 9:30 PM. Please plan to keep this time available if possible.',
  retreat_prompt: 'Our retreat is tentatively scheduled for 9/18 - 9/20. Just in case, please add a calendar reminder for these dates.',
  availability_hint: 'If you have a time conflict, feel free to select "Other" and briefly explain. This will NOT impact or disqualify your application.',
  weekly_hours: 15,
}
export type ApplicationWording = typeof DEFAULT_APPLICATION_WORDING
export function applicationWording(value?: Partial<ApplicationWording> | null): ApplicationWording {
  return { ...DEFAULT_APPLICATION_WORDING, ...value }
}
