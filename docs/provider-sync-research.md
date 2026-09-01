# Auto-sync with upstream providers — research

Researched 2026-08-22. Question: can Fitberg pull activities automatically from
COROS, Wahoo and Nike Run Club? Sources are linked at the bottom.

## Summary

| Provider | Official API | Gives raw FIT | Push (webhook) | Verdict |
| --- | --- | --- | --- | --- |
| Wahoo | yes, free, documented | yes | yes | build this first |
| COROS | yes, partner-gated | yes (FIT/TCX/GPX) | yes | apply, then build |
| Nike Run Club | no | no | no | not feasible; document manual routes |

## Wahoo — the only clean win

[Wahoo Cloud API](https://developers.wahooligan.com/cloud), OAuth 2.0, free, and it
returns exactly what Fitberg ingests.

- `workouts_read` lists workouts; the workout-summary endpoint returns a URL to the
  raw `.fit` file on Wahoo's CDN. No conversion, no reconstruction from streams.
- Webhooks fire on new workouts, retried at 30 min / 4 h / 24 h / 72 h. Real
  auto-sync without polling.
- Requires app approval, sandbox first then production.
- Rate limits — sandbox: 25/5 min, 100/h, 250/day. Production: 200/5 min, 1000/h,
  5000/day.
- Access tokens expire after 2 h (refresh required). Since Jan 2026: max 10
  unrevoked tokens per user, and tokens auto-delete 60 days after creation, so a
  dormant user has to re-authorise.
- Wahoo does not forward workouts that originated in a third-party app.

Self-hosting wrinkles, unresolved:

- A box behind NAT cannot receive webhooks, so a polling fallback is needed anyway.
- Either Fitberg ships one shared `client_id` (against the no-cloud-services ethos,
  and every user then shares one rate-limit bucket) or each user registers their own
  Wahoo app. Unverified: whether Wahoo accepts a `http://localhost:8710/...`
  redirect URI, which would make per-user apps painless.

## COROS — possible, but gated

COROS runs a real OAuth 2.0 partner API. Onboarding: mail `api@coros.com` with
company details, technical contact and redirect URIs, accept their API Terms of Use,
pass a security/identity review, then receive credentials. It exposes activity
lists, download URLs for FIT/TCX/GPX, and device-push webhooks. COROS frames it as
GDPR / EU Data Act compliance with an objective onboarding process, so an
open-source project has a plausible shot — but it is an email and a wait, not a
self-service signup.

COROS also shipped an official MCP server that exposes FIT downloads, capped at 50
files per calendar day. Mostly useful as a signal that they are opening up.

**Update 2026-08-30: this is now built.** Fitberg talks to `mcp.coros.com/mcp`
directly — RFC 9728 resource discovery, dynamic client registration, PKCE, refresh
tokens, `querySportRecords` + `downloadActivityFitFiles`, into the normal ingest
pipeline. Verified live:

- DCR is open and self-service; a public client (no secret, S256 PKCE) registers fine.
- **Non-loopback redirect URIs must be https** — a LAN `http://192.168.x.x` address
  is rejected by the registration endpoint. Loopback http is fine, which is what
  Fitberg registers; a reverse-proxied https PUBLIC_URL is used when present, and a
  paste-the-callback-URL fallback covers browsing from another machine.
- The device grant is listed in AS metadata but returns a bare 401 for every client
  tried, dynamically registered or not, with or without the `resource` parameter.
  Dead end; do not retry.
- Regional standalone endpoints (`mcpeu.coros.com` etc.) exist for clients that
  cannot follow the main URL's redirect.

Unofficial fallback that works today: the Training Hub web API at `t.coros.com`
(login, list activities, download FIT). Used by several community exporters
([xballoy/coros-api](https://github.com/xballoy/coros-api),
[futoshita's exporter](https://github.com/futoshita/Coros-Training-Hub-Exporter),
[NYT87/coros-connect](https://github.com/NYT87/coros-connect)). The user would
supply their own credentials; it can break at any time and should be labelled
unofficial.

## Nike Run Club — effectively closed

- No public API. The unofficial one has been dead since March 2024: Akamai Bot
  Manager blocks scripted login, so an access token cannot even be obtained.
- NRC auto-syncs to Strava, but Strava is a dead end as a hub:
  - the API has no `export_original` / `export_tcx` — streams only, so a file would
    have to be rebuilt, lossily;
  - since June 2026 the Standard tier costs $11.99/month, caps at 10 users, and
    explicitly disallows apps that pass data through third-party platforms.
- Workable routes instead:
  - a GDPR data-portability request via <https://www.nike.com/help/privacy> —
    manual and slow, but yields machine-readable files that Fitberg's TCX importer
    already handles;
  - continuous capture via Apple Health (NRC writes workouts there) with something
    like Health Auto Export writing files into a watched folder.

## Recommended order of work

1. **Generic ingest first.** A watched folder plus an authenticated
   `POST /api/import` with an API key. One feature makes every provider solvable
   from outside — Syncthing, rsync, cron, iOS Shortcuts, existing sync tools — and
   it keeps the "no network calls" promise, because the pull happens elsewhere.
2. **Wahoo connector.** The only provider with a documented, free, FIT-native API
   plus push notifications.
3. **COROS.** Send the application mail now, since lead time is long. Optionally
   ship an opt-in, clearly-labelled unofficial Training Hub importer in the
   meantime.
4. **Nike.** Do not build a connector. Document the Apple Health and GDPR routes.

Worth knowing for later: Garmin's Connect Developer Program is the other official
FIT-push API, and the one most likely users would actually ask for.

## Sources

- <https://developers.wahooligan.com/cloud>
- <https://cloud-api.wahooligan.com/>
- <https://support.coros.com/hc/en-us/articles/17085887816340-Submit-an-API-Application>
- <https://support.coros.com/hc/en-us/articles/50841795180948-COROS-MCP-A-Guide-to-Connecting-Your-Training-Data-to-AI>
- <https://github.com/xballoy/coros-api>
- <https://github.com/yasoob/nrc-exporter>
- <https://rungap.zendesk.com/hc/en-us/articles/115000368794-Why-Nike-is-no-longer-supported-by-RunGap-and-how-to-get-your-data-anyway>
- <https://communityhub.strava.com/insider-journal-9/an-update-to-our-developer-program-13428>
- <https://communityhub.strava.com/developers-api-7/download-original-workout-file-or-tcx-on-behalf-of-user-1852>
- <https://developers.strava.com/docs/rate-limits/>
