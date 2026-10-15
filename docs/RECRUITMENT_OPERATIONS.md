# Running recruitment

> WIP checkpoint: Google sending currently fails its fake-provider regression test. Do not use real sending yet. See the [resume checklist](RECRUITMENT_WORKFLOW_SPEC.md#resume-here) before rollout.

## Cycle to final decisions

1. Create a cycle under Applications & cycles. Configure essays, commitments and deadline, then use the application link to check the form.
2. Create the standard three rounds under Rounds & rubrics. Confirm the Leadership/Admin reviewer pool. Publish each rubric before grading or booking.
3. Written: preview and run **Assign reviewers**. Each applicant gets two independent reviewers with balanced loads and class-year mix. Reviewers use Review candidates. Declared conflicts appear in the round’s coverage inbox if automatic replacement is impossible.
4. When both reviews are submitted, peer evaluations become visible. Close grading to freeze the scoring dataset. Review **Class-year recommendations**: top/bottom 5 freshmen and sophomores, top/bottom 3 juniors including transfers. These are suggestions; small cohorts, missing data and cutoff ties remain yellow.
5. Open live deliberation. The host records consensus colors. Resolve every yellow, then **Finish decisions**. Intermediate green advances; final green accepts. This is the only progression path. Finalized rooms and outcomes are locked; reopening finalized decisions is intentionally unavailable until an audited correction workflow exists.
6. PD / take-home: use **Interview schedule**. Admin creates dates, duration (45 minutes default), break, capacity, location and cutoff. Enter start times in the device’s local timezone; listings always show Pacific time, with daylight-saving handling by the browser. Reviewers mark availability. Publish the rubric, then create personal booking links or prepare booking email.
7. Applicants book/reschedule through their private link. Booking assigns two available distinct interviewers and balances their interview counts within that round. Concurrent bookings cannot exceed capacity. Reviewers can withdraw availability; replacement is automatic where possible, otherwise the schedule shows a coverage alert. Submitted reviews prevent automatic cancellation; leadership must resolve them first.
8. The final take-home deliberation room contains **Social night observations**. All members see green/yellow/red cards and authors. Authors edit/delete their cards; the host can delete any card. Cards refresh every five seconds and never change scores. Keep the room open during social night, then use the same room for final consensus.
9. Use Candidates for round-by-round score and decision history. There is no cumulative numerical ranking. CSV is available from Reviews & progression or Email & exports.

## Scoring policy v1

For each reviewer, normalize current-round raw totals using population standard deviation. Require at least three observations, nonzero variance and comparable maximum points. Average the two reviewer z-scores. Freeze raw references, computed values and policy identifier on close. A missing or invalid z-score stays unavailable rather than zero. All recommendations in a cohort stay yellow while anyone in that cohort has an unavailable score. Ties crossing a cutoff stay yellow.

## Connect Google sending

1. Enable Gmail API in the Google Cloud project containing the OAuth client.
2. Add the authorized redirect URI `http://localhost:5173/api/ps/mail/callback` for local work, or `https://YOUR_HOST/api/ps/mail/callback` for deployment. This is additional to the existing NextAuth login callback.
3. Configure consent for `openid`, `email`, and `https://www.googleapis.com/auth/gmail.send`. If Google keeps the project in testing, add the admin sending account as a test user. Workspace policies or Google verification may apply before broader deployment.
4. Generate `MAIL_TOKEN_KEY` with `openssl rand -base64 32` and put it in the server’s private environment. Keep this encryption key stable and backed up securely. Do not commit it. Existing `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `NEXTAUTH_URL` are also used.
5. In Email & exports, an admin clicks **Connect Google mailbox** and consents. Messages send as the connected, verified mailbox; typing a different address cannot change the sender. Each admin connects their own mailbox.
6. Choose finalized green, finalized red, or waiting-for-interview recipients. Edit subject/body; supported fields are `{{first_name}}`, `{{round_name}}`, `{{booking_link}}`. Include the last field in booking invitations. Preview saves drafts only.
7. Inspect recipients and complete messages. Select up to ten and click **Send selected**. Repeating an identical preview does not duplicate messages. A changed template creates a new draft, so review before sending another version.
8. The persistent outbox records attempts. “Sent” means Google accepted the API call. A provider rejection can be retried after fixing its cause. A lost response or interrupted send becomes uncertain and cannot be retried automatically: check the mailbox first. Drafts remain until explicitly sent. There is no unattended background sender.
9. Disconnect revokes Google access and removes stored credentials. Refresh tokens are encrypted with AES-256-GCM. OAuth consent state is single-use, owner-bound, short-lived, and uses PKCE.

Google references: [OAuth server flow](https://developers.google.com/identity/protocols/oauth2/web-server), [Gmail server authorization](https://developers.google.com/workspace/gmail/api/auth/web-server), [sending messages](https://developers.google.com/workspace/gmail/api/guides/sending).

## Deploy and hand off

- Pull code, install dependencies with `npm ci`, then run typecheck, lint, unit/security tests and build. `npm run test:ps:http` starts an isolated app and disposable MongoDB replica set; Google is faked, and developer `.env` files are not copied.
- Back up the target database. Run `npm run db:ps:preflight -- --database=YOUR_DATABASE`, review, then `npm run db:ps:apply -- --database=YOUR_DATABASE`. These add indexes only. No automatic data migration is included.
- Old shared-pair/open rounds and historic scoring remain supported; do not convert existing live rounds silently. Use new standard rounds for this workflow. Old backend routes remain for historical compatibility; obsolete navigation has been removed.
- Keep development and real recruitment databases separate. Production must not enable local login or test authentication bypasses. Use HTTPS and a stable deployment URL so applicants can use booking links outside your computer.
- Test a complete disposable cycle before real invitations: two written reviews, host finalization, booking, two interview reviews, final social cards, finalization, CSV, then a deliberately selected test email after Google consent.
- Org repository membership simplifies code handoff. Also transfer appropriate Atlas/Google Cloud access and the deployment environment through your password manager. New maintainers connect their Google mailbox; disconnect departing senders. Preserve the encryption key if retaining existing connections.

## Current boundaries

- Browser desktop/mobile visual acceptance and a real Google-consent/test-send check must be completed in the target environment. Automated provider tests do not prove Google project configuration.
- In-app coverage alerts are the notification channel for missing reviewers; no unsolicited leadership email is sent.
- Applicant links are private bearer links, bound to one stored applicant and round. Replacing a link invalidates the previous one; share it only with that applicant.
- Corrections after finalization, host transfer, and legacy raw-review exclusions require a separate reviewed workflow. No silent historical rewrite is provided.
