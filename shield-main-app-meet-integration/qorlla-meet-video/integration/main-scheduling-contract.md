# Main scheduling integration contract (v3.1–v3.5)

Main repository is not included. This is an integration contract, not a claim that its routes are wired.

1. Add `meet_meeting_id uuid`, `meet_meeting_code varchar(12)`, `meet_sync_status` and encrypted `meet_host_secret` columns to the main scheduling table using its actual schema and migration system.
2. Persist the MAIN schedule first with a stable source ID and `pending_sync` status.
3. Call `registerSchedule` from the MAIN backend only. Include the existing legacyCode, title, ownerName and ISO scheduledAt.
4. Persist the returned mapping transactionally in MAIN; encrypt hostSecret at rest and never return it to guests. Repeated calls do not return hostSecret, so implement a secure first-response write and manual recovery policy for lost first responses.
5. Never advertise the meeting join link until sync succeeds. Retry pending schedules using the same sourceId, with bounded backoff and alerting.
6. On title/time changes call `updateSchedule`; on cancellation call `cancelSchedule` and update MAIN state.
7. Route `qorlla.html` meeting links with `meetingId` or `meetingCode`; collect passcode in Meet lobby, not URL.
8. Repair `/index.html` only after checking which main page is canonical; preserve untracked `1index.html` until reviewed.
9. Production: use HTTPS, private network access, rotated bridge secrets, audited changes, tenant-scoped source IDs and authentication for MAIN schedule creation.
