# Audit record: early deletion of two historical Playwright report artifacts

This is a sanitized record. It contains artifact identifiers, workflow references, dates and the reason for removal. **It does not contain, quote or summarise personal data or any content of the artifacts.** The artifacts' contents were not copied into any other artifact, issue or pull request.

## Decision
Authorised by the repository owner's review of PR #5 (privacy clean-up). This is a limited privacy decision, **not** a finding that credentials were exposed; no credential rotation is indicated by the evidence reviewed.

## Reason
The reports were produced by the CI pipeline before the report scanner existed. Playwright's HTML report, when run under GitHub Actions, embeds the git commit metadata of the run (author and committer identity as recorded in the commit, the commit message body and a link to the commit). That metadata is already public in this repository's git history, so the artifacts did not disclose anything new, but they duplicated personal information inside downloadable diagnostic archives for 30 days with little diagnostic value (both runs failed at the same stage before any meaningful report existed). The source of the embedding is removed in this PR (`captureGitInfo: { commit: false, diff: false }`) and a fail-closed scan now guards every future upload.

## The two artifacts
| # | Artifact id | Name | Size (bytes) | Created (UTC) | Scheduled expiry (UTC) | Workflow run | Run event / branch | Commit of the run | Artifact SHA-256 digest (as reported by GitHub) |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 12324340615 | `playwright-execution-report` | 1,045,742 | 2026-10-21 05:52:09 | 2026-11-20 05:52:08 | [39551858084](https://github.com/jedgod/qorlla-Application-video/actions/runs/39551858084) ("Zoom Workspace CI/CD Pipeline", run failed) | push / `main` | `f1e1709d7c79bb79bc8f7ce8b9146e73428b65c7` | `sha256:5ad534581c07bdce60bcedcbbbc4afae20b2072d85edcce9c12cb94dda9f737b` |
| 2 | 12633695714 | `playwright-execution-report` | 1,032,203 | 2026-10-26 07:12:59 | 2026-11-25 07:12:58 | [40284272142](https://github.com/jedgod/qorlla-Application-video/actions/runs/40284272142) ("Zoom Workspace CI/CD Pipeline", run failed) | push / `main` | `5c96568b3a8515a826df06677ec9a8deca12a0ec` | `sha256:906d23525e4a8582ca4694c8a8aefeb62d22c6f16849d7bb2ff24ff285aa189f` |

## Deletion
| Artifact id | Deleted (UTC) | Method | Confirmed |
|---|---|---|---|
| 12324340615 | 2026-10-31 01:41:48 | GitHub REST API `DELETE /repos/{owner}/{repo}/actions/artifacts/{id}` | Yes: a follow-up request for the artifact returns "Not Found" |
| 12633695714 | 2026-10-31 01:41:50 | GitHub REST API `DELETE /repos/{owner}/{repo}/actions/artifacts/{id}` | Yes: a follow-up request for the artifact returns "Not Found" |

## Result
After the two deletions the repository stores **0** workflow artifacts (checked with the list-artifacts API). No other artifact was touched.

## Related
- Local working copies that had been downloaded for the review were kept only in a temporary session folder outside the repository and were removed after the deletion (2026-10-31).
- Anyone who downloaded the artifacts before deletion is outside this repository's control; the information in them is limited to what is already public in git history.
- PR #5 (`security/playwright-artifact-hardening`) carries the prevention: no commit metadata in reports, failed-test-only upload, a fail-closed scan before upload, seven-day retention.
