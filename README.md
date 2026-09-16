# Product Space @ Berkeley — Recruitment Tool

A recruitment portal for collecting applications, assigning reviewers, grading, importing interview and coffee-chat notes, and running candidate deliberations.

Built with Next.js, React, TypeScript, NextAuth (Google sign-in), and MongoDB/Mongoose.

## Quick start for a new maintainer

1. Ask a Product Space Berkeley organization owner to add you to the GitHub organization and grant repository access. Get environment values from the current maintainer through the club's password manager or another secure channel.
2. Install Node.js 20.19 or later (Node.js 22 is suitable).
3. Clone the repository and install dependencies:

   ```sh
   git clone https://github.com/Product-Space-Berkeley/ps-recruitment-tool.git
   cd ps-recruitment-tool
   npm ci
   ```

   If ownership has changed, use the repository's current clone URL.

4. For a fresh checkout, copy `.env.example` to `.env.local`. Do not overwrite an existing configured file.
5. Fill in the values below, then run:

   ```sh
   npm run dev
   ```

6. Open http://localhost:5173 in a regular browser and sign in with your authorized Google account.

### Environment configuration

| Variable | Purpose |
| --- | --- |
| `MONGODB_URI` | Atlas connection string with `/ps_recruitment` as the database path |
| `GOOGLE_CLIENT_ID` | Google OAuth web client ID |
| `GOOGLE_CLIENT_SECRET` | Secret for that OAuth client |
| `NEXTAUTH_SECRET` | Random secret used to protect login sessions; keep stable across restarts |
| `NEXTAUTH_URL` | `http://localhost:5173` locally; the HTTPS application origin in production |
| `SECURITY_INDEX_DB_NAME` | Exact target database for explicit index maintenance scripts |
| `SECURITY_INDEX_EXPECTED_CYCLE_ID` | Known recruitment cycle ID required by index maintenance scripts |

The last two variables are not required for ordinary local development. Generate a secret for a new environment with `openssl rand -base64 32`. Keep `.env.local` out of Git; it is ignored. Never put secrets, applicant data, or database exports in this README or issues.

The OAuth web client needs:

- JavaScript origin: `http://localhost:5173`
- Redirect URI: `http://localhost:5173/api/auth/callback/google`

Use `localhost` consistently. Add the deployed HTTPS origin and its `/api/auth/callback/google` URI when hosting the app. In Google Auth Platform, check the Audience/test-user settings if sign-in is restricted during testing.

Atlas must allow the developer's current IP address and have a database user with access to `ps_recruitment`. An Atlas console account and a database connection user are different identities. Use a replica-set-capable database such as Atlas: the app uses transactions. No separate backend process is required.

## Adding authorized users

**Google sign-in establishes identity. An entry in `ps_recruitment.authorizedusers` grants internal application access.** Adding someone to Google Cloud, Atlas, or GitHub does not grant them application access.

### Normal workflow: use the application

1. Sign in as an existing application **admin**.
2. Open `/dashboard` and find **Authorized Users**.
3. Enter the exact Google sign-in email, choose a role, and add the user. The page also supports bulk addition.
4. Ask the user to sign in and confirm their expected access. If their page is stale, have them sign out and back in.

| Role | Typical responsibility |
| --- | --- |
| `grader` | Review assigned applicants and participate in permitted deliberation sessions |
| `leadership` | Grader capabilities plus recruitment cycle, round, and assignment management |
| `admin` | Leadership capabilities plus authorized-user management and administrative imports/controls |

Session membership, ownership, bans, and reviewer assignments impose additional checks; a role does not bypass every resource-specific restriction. Use `admin` for the people responsible for operating the app, not every reviewer.

### First admin or recovery when no admin can sign in

A maintainer with Atlas data-write access can bootstrap an admin:

1. Open Atlas **Data Explorer** and select the correct cluster.
2. Open database **`ps_recruitment`**, collection **`authorizedusers`**.
3. If absent, create the database and collection using those exact names. Do not use MongoDB's internal `admin` or `local` databases.
4. Search for the intended email before inserting, to avoid duplicates.
5. Insert this document with the person's real Google sign-in email in lowercase:

   ```json
   {
     "email": "incoming-maintainer@example.com",
     "role": "admin",
     "added_by": null
   }
   ```

6. Have that person sign in and verify that **Authorized Users** appears on their dashboard.

If the email already exists, update its role to `admin` instead of inserting another record. After bootstrap, use the application for routine management: direct database edits bypass its safeguards and related-record updates.

### Changing or removing access

Use the role selector or removal control in **Authorized Users**. The API prevents an admin from deleting or demoting themselves, changing their own email, or removing the last admin. Have another verified admin remove an outgoing admin.

Removing an authorized user also removes their grader assignments; historical reviews remain. Reassign unfinished work before removal. Internal authorization is checked against the database on subsequent requests, so removing the record revokes internal access even if a login session still exists.

Keep at least two trusted, active maintainers with verified admin access.

## Maintainer handoff

Complete this before the outgoing maintainer loses access to their university email or accounts. Repository access, app admin access, Google Cloud access, and Atlas access are separate handoffs.

### 1. Record the current deployment

Fill in this inventory without including credentials:

| Item | Current value / handoff note |
| --- | --- |
| Repository | https://github.com/Product-Space-Berkeley/ps-recruitment-tool |
| Google Cloud project ID | Confirm in the Cloud Console project selector |
| Google Cloud organization / folder | Confirm the actual parent resource and responsible administrator |
| OAuth client name | Record the web client used by this environment |
| Atlas organization / project | Record the names visible in Atlas |
| Atlas cluster / database | `ps-recruitment` / `ps_recruitment`; confirm for each environment |
| Hosting provider and live URL | Record if deployed; localhost runs only on a developer's computer |
| Domain / DNS owner | Record if deployed |
| Secret storage location | Record the vault entry name, never the secret values |
| Active cycles and outstanding work | Record deadlines, pending reviews, and configured import sources |
| Backup and recovery location | Record access instructions and last restore check |
| Incoming primary and backup maintainers | Record their names and contact details |

### 2. Transfer application administration

- Add the incoming maintainers as `admin` using the steps above.
- Have each sign in with their own account and verify user management.
- Explain active recruitment cycles, deadlines, review assignments, import formats, and deliberation settings.
- Reassign any unfinished grading owned by the outgoing maintainer.

### 3. Use the organization-owned GitHub repository

- Add the incoming maintainer to the `Product-Space-Berkeley` GitHub organization with the least access needed for their role. Organization owners should manage membership and repository permissions.
- Have the successor clone the organization repository:

  ```sh
  git clone https://github.com/Product-Space-Berkeley/ps-recruitment-tool.git
  ```

- Confirm the successor can open repository settings, manage collaborators, and access Actions/deployment settings when those responsibilities are part of the role.
- Review deployment integrations, Actions secrets, webhooks, and billing responsibility if used. These settings may remain owned by the organization even when repository access is granted.
- If an existing checkout still points to the old personal remote, update it:

  ```sh
  git remote set-url origin https://github.com/Product-Space-Berkeley/ps-recruitment-tool.git
  ```

- Keep the repository organization-owned after handoff; do not transfer it back to a personal account.

### 4. Transfer Google Cloud and OAuth management

- In the correct project's **IAM & Admin → IAM**, grant the successor the access needed to maintain OAuth clients and manage future maintainers, subject to the organization's policies.
- Verify they can open the existing web client in **Google Auth Platform → Clients** and manage its configuration.
- Update support/developer contact emails and any relevant test-user access to active club contacts.
- Keep the existing OAuth client and redirect URIs during the handoff unless a change is necessary.
- If the project is under `berkeley.edu` or a university folder such as `faculty`, coordinate with the university resource administrator. Project access does not transfer university ownership; inherited permissions may require changes at the parent resource.

See [Google Cloud access management](https://cloud.google.com/iam/docs/granting-changing-revoking-access) and [permission inheritance](https://docs.cloud.google.com/iam/docs/resource-hierarchy-access-control).

### 5. Transfer MongoDB Atlas management

- Invite the successor's own Atlas account to the project with **Project Owner** access so they can manage future access. Review organization ownership and billing responsibility separately if the outgoing person controls them.
- Have the successor verify cluster access, Data Explorer access, database users, and the IP access list.
- Confirm the application database is `ps_recruitment` and identify where backups/exports are stored. Document the actual recovery process; do not assume backups are enabled for the current cluster plan.
- Create or rotate the application's database credentials during the coordinated handoff, update every running environment, and test before retiring the previous credentials. Ordinary runtime credentials should be scoped to the application database.

See [Atlas project access management](https://www.mongodb.com/docs/atlas/access/manage-project-access/).

### 6. Transfer hosting, secrets, and integrations

- If deployed, transfer hosting team membership, environment-variable access, deployment permissions, domain/DNS access, billing, and recovery contacts.
- Transfer any Google Sheets used for coffee-chat or behavioral imports and verify their configured sources still work.
- Share required environment values through the club's secret manager. Each maintainer should use their own service accounts/login identities where applicable, rather than taking over another person's personal login.
- Rotate secrets accessible to departing maintainers in a planned window. Test a replacement MongoDB credential and OAuth secret before revoking the old ones. Changing `NEXTAUTH_SECRET` invalidates existing sessions and requires users to sign in again.
- The successor should retain the recovery instructions and required second-factor recovery access for club-owned accounts.

### 7. Acceptance checklist, then remove outgoing access

- [ ] Successor can clone the repository and run `npm ci` and `npm run dev` on their own machine.
- [ ] Google sign-in succeeds and their dashboard shows admin user management.
- [ ] Application connects to the intended MongoDB database.
- [ ] Successor is a member of the `Product-Space-Berkeley` GitHub organization and can manage the repository settings required by their role.
- [ ] Successor can manage access in Google Cloud, Atlas, and hosting if applicable.
- [ ] A controlled test account can be added, sign in with its intended role, and be removed.
- [ ] Active recruitment work, integrations, and recovery instructions have been reviewed.
- [ ] Required secrets are available to the successor and rotations have been tested.
- [ ] Another verified admin removes the outgoing maintainer's application access.
- [ ] Outgoing GitHub organization/team membership, Cloud IAM, Atlas, hosting, secret-vault, and integration access is removed as appropriate. Check inherited team/organization access too.

Do not delete the repository, OAuth client, Atlas cluster, or database as part of removing a person's access.

## Operational notes

- Main pages: `/` (login), `/apply` (applicants), `/dashboard`, `/grade`, `/admin`, and `/session/[id]`.
- Source: `src/app` contains pages and API routes; `src/lib` contains models, authorization, scoring, validation, and import logic; `scripts` contains checks and maintenance utilities.
- Local checks: `npm run lint`, `npm run typecheck`, and `npm run build`.
- Some integration, migration, and race-test scripts write data. Read their headers and use a separate test database; do not point them at live applicant data casually.
- Development automatically creates Mongoose collections/indexes. Production disables automatic creation. Before production launch, review `scripts/migrate-security-indexes.mjs` and `scripts/verify-indexes.mjs`, run the preflight against the exact intended database/cycle, and confirm a backup before applying changes. These standalone scripts require environment variables to be loaded explicitly; they do not automatically read `.env.local`.
- The app has Product Space branding, but some legacy import headers and recruitment rules remain organization-specific. Review these before a new recruitment launch.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Google `redirect_uri_mismatch` | Exact origin, port, and `/api/auth/callback/google` path in the OAuth client |
| Google `OAuthSignin` | Server logs, client ID/secret, and OAuth audience settings; use Chrome or Safari if an embedded browser blocks Google sign-in |
| Login succeeds but internal tools are unavailable | Exact lowercase Google email and role in `ps_recruitment.authorizedusers` |
| MongoDB connection timeout | Current IP allowed in Atlas, correct database credentials, cluster availability |
| Not authorized to create a collection on `local` | Create `authorizedusers` in `ps_recruitment` instead |
| Cannot remove your own admin account | Ask the incoming verified admin to remove it after handoff |
| New environment values are not taking effect | Restart the development server or redeploy the hosted application |
