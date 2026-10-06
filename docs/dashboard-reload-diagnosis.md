# Dashboard reload failure

Diagnosed October 5, 2026 before application changes.

## Observed root cause

On the running Turbopack development server, an authenticated browser reproduced:

| Request | Status | Content-Type | Redirected | Response |
| --- | --- | --- | --- | --- |
| `/api/auth/session` | 200 | application/json | No | Authenticated admin session |
| `/api/sessions` | 500 | Missing | No | Empty body (0 bytes) |
| `/api/sessions` without a session | 401 | application/json | No | Unauthorized JSON error |

The server log reports MongoServerSelectionError with a TLS internal-error alert (SSL alert 80). An independent read-only connection probe using the existing environment and connection options failed with MongooseServerSelectionError; all three topology server errors were MongoNetworkError/TLS failures. No credentials or environment settings were changed.

`GET /api/sessions` awaited authentication, `connectDB()`, membership/session queries and serialization without a catch boundary. A database exception therefore escaped the handler, and this Next.js development server returned an empty HTTP 500. The dashboard blindly called `response.json()`, which threw Unexpected end of JSON input. Its uncaught initialization Promise.all then left the page loading and emitted an unhandled rejection.

The current local dev-login provider intentionally returns an admin session without a database lookup. Its successful authentication response does not verify MongoDB availability. There is no project middleware/proxy returning an HTML login page for this request. The observed sessions response was not redirected. `connectDB()` already clears rejected connection promises. No cache deletion or bundler reset is needed to explain the reproduced failure.

## Pre-existing behavior

Both the unguarded sessions handler and unconditional dashboard JSON parsing are present in repository HEAD (`1f2b6ae`), before Alex's PS additions. Alex's earlier dashboard diff added PS navigation and excluded PS rounds from the legacy pending-review count; `/api/sessions` and `mongodb.ts` were unchanged.

## Corrections

- Catch failures around the entire GET and POST sessions execution, including authentication/database setup and parent lookups. Preserve existing permissions and session creation rules. Return JSON 503 for database unavailability and JSON 500 for unexpected application errors; successful empty lists remain HTTP 200 `[]`.
- Strengthen the existing checked-fetch helper shared by PS pages and the dashboard: validate HTTP success, redirects, JSON media type, empty/malformed bodies and list shape. Preserve failures as explicit errors, never successful empty arrays.
- Isolate dashboard session, grading-count and authorized-user load states/errors. Clear the initial spinner after authentication and show independent retry controls. Check dashboard mutation responses without changing authorization policy or deliberation behavior.
- Test actual route failure responses, auth, empty/normal session lists, helper response variants, and browser navigation/reload behavior.

The environment's MongoDB TLS/connectivity failure remains visible as a database-unavailable error. Returning valid JSON and keeping the dashboard usable does not fabricate a successful connection or empty session list.

## Validation

After the change, the same live authenticated Turbopack request returned HTTP 503, `application/json`, no redirect, and a database-unavailable error. Reloading `/dashboard` showed a sessions error and retry control, kept navigation usable, and did not show a false empty list or emit an uncaught browser runtime exception. Other unavailable legacy APIs surfaced independent widget errors. Live `/admin/rounds` and `/grade/ps` direct navigation and reload also displayed API errors without uncaught runtime exceptions.

Browser checks against the disposable HTTP-test server passed:

| Case | Result |
| --- | --- |
| Unauthenticated direct `/dashboard` navigation | Existing redirect to sign-in preserved |
| Authenticated direct navigation and reload, empty own-session list | Valid empty state, no runtime exceptions |
| Authenticated direct navigation and reload, normal own-session list | Session rendered, HTTP 200 JSON, no runtime exceptions |
| Injected database failure during reload | HTTP 503 JSON, explicit retry, usable dashboard, no false empty state |
| Recovery after failure | Retry restored the session without a page reload or server restart |
| `/admin/rounds` direct navigation and reload | Loaded successfully, no application error or runtime exception |
| `/grade/ps` direct navigation and reload | Loaded successfully, no application error or runtime exception |

The browser fixture uses `npm run test:ps:http -- --browser` with the existing development login and a disposable MongoDB replica set. Its `normal`, `empty`, `failure`, `recover`, and `done` commands change only temporary fixture data/state. Fault injection is added only to the temporary app copy. No live database records, credentials, authentication policy, or deliberation rules were changed.

All commands passed after the application changes:

- `npm run typecheck`
- `npm run lint`
- `npm run test:ps`
- `npm run test:ps:integration`
- `npm run test:ps:http`
- `npm run build`
- `npm run test:security`

Regression coverage verifies JSON status/content type on real session routes, unauthenticated/forbidden access, empty/normal lists, database failure for GET and POST, and recovery. Checked-fetch tests cover empty/malformed bodies, missing/non-JSON content types, JSON errors, redirects, network failures, invalid lists, and explicit mutation methods. The dashboard and Alex-owned pages/components have no remaining raw fetch or unconditional response JSON parsing; they use the shared checked-fetch helper.
