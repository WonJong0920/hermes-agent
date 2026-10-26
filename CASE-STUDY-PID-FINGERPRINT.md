# AI-Assisted Engineering Case Study: Kanban Worker PID Fingerprint Hardening

## Status and scope

This branch is intended as a **public-fork reference implementation and verification record**. It is not a new upstream pull request and it has not been merged into or released by Hermes Agent.

As of October 26, 2026, upstream pull request #142539 is open and unmerged. It already addresses the primary start-time drift behavior, so I reviewed and supplemented that work rather than opening a competing pull request:

- Upstream pull request: [NousResearch/hermes-agent#142539](https://github.com/NousResearch/hermes-agent/pull/142539)
- Public review comment: [non-positive start-time edge and RED/GREEN result](https://github.com/NousResearch/hermes-agent/pull/142539#issuecomment-6407501649)

Reference base for this branch: `05d7b5af1c42d524762c7ffce991c1fe1aa2adb1`.

## Problem

Hermes records a Kanban worker fingerprint as an instantiation epoch plus a process start-time value. A live PID is considered foreign or recycled when that stored identity no longer matches the process currently using the PID.

The previous comparison treated the whole composite fingerprint as an exact string. On platforms where repeated process start-time observations can drift slightly, this can make the same live worker look recycled.

The intended policy is:

1. The instantiation epoch must match exactly.
2. The start-time components may differ by at most the shared tolerance of 200 centiseconds (2 seconds).
3. Malformed or unreadable composite fingerprints must fail closed.

## Additional fail-closed edge

While reviewing the tolerance-based fix, I found that the shared numeric comparator only checks the absolute difference. Without validation at the caller, non-positive values can therefore compare as equal when they are close enough:

| Recorded start | Current start | Required result |
|---:|---:|---|
| 0 | 100 | foreign/recycled |
| -50 | 100 | foreign/recycled |
| 100 | 0 | foreign/recycled |
| 100 | -50 | foreign/recycled |

This branch parses both composite start-time fields and requires both values to be positive before applying the 200-centisecond tolerance.

The resulting decision is:

```text
same instantiation epoch
AND recorded start time > 0
AND current start time > 0
AND absolute start-time difference <= 200 centiseconds
```

Only then is the PID accepted as the same worker.

Legacy integer-only rows retain the existing shared `_start_times_agree` behavior. The change is limited to composite fingerprints.

## Verification

A test-only negative-control patch is published at `evidence/pid-fingerprint-nonpositive-red.patch`. Applying it to the exact reference base adds the four non-positive regression cases without the production guard; the focused test file then fails those four assertions for the intended reason.

After applying the production guard, local macOS verification completed:

- 37 related tests passed across the Kanban worker, cron owner, gateway owner-liveness, and process-group start-time drift suites.
- `python scripts/check` completed all 13 repository checks successfully.
- `git diff --check 05d7b5af1c42d524762c7ffce991c1fe1aa2adb1...HEAD` passed for the publishable commit range.

The read-only GitHub Actions workflow on this branch is configured to rerun those focused tests and repository checks from a clean GitHub-hosted runner without repository secrets. Its hosted result should be evaluated separately from these local results and is not a PASS until the exact public commit has a successful run.

## Engineering decisions

### Preserve epoch identity

The instantiation epoch is still compared exactly. The tolerance applies only to the numeric process start-time component, not to a boot or instance identity. An empty epoch remains valid only when both recorded and current fingerprints have the same empty epoch, preserving platforms where no instantiation witness is available.

### Fail closed on unusable identity data

An unreadable current fingerprint, malformed composite value, or non-positive start time is treated as foreign/recycled. This prevents a weak or corrupt fingerprint from authorizing a signal to an unrelated process.

### Avoid duplicate upstream work

A search found that pull request #142539 already covered the main bounded-drift fix. I did not open another pull request for the same behavior. Instead, I posted the additional edge case, regression inputs, and verified guard on the existing discussion.

## Human and AI responsibilities

This was an AI-assisted engineering investigation, not an unreviewed code-generation exercise.

**Human direction and decisions**

- Identified the operational symptom and authorized the investigation.
- Set the safety policy: exact epoch identity, bounded start-time tolerance, and fail-closed behavior.
- Required real tests and independent review before publication.
- Chose not to create a duplicate upstream pull request.
- Approved the public scope and excluded private operational data.

**AI-assisted work**

- Inspected the affected development code path and the related public upstream work.
- Built and ran focused regression tests.
- Helped inspect the candidate independently and surfaced the non-positive edge.
- Reproduced the edge, implemented the guard, and reran RED/GREEN verification.
- Prepared the public evidence and linked it to the existing upstream discussion.

**Final accountability**

The published claim is limited to a tested reference implementation and a public upstream code-review contribution. It does not claim that the patch was authored first, accepted, merged, or released upstream.

## Reproduction

From a Hermes development environment prepared according to `CONTRIBUTING.md`:

```bash
export HERMES_PYTHON=/absolute/path/to/hermes-test-env/bin/python

scripts/run_tests.sh \
  tests/hermes_cli/test_kanban_worker_pid_fingerprint.py \
  tests/cron/test_owner_start_time_drift.py \
  tests/gateway/test_owner_liveness_drift.py \
  tests/tools/test_pgid_starttime_drift.py

git branch -f evidence-base 05d7b5af1c42d524762c7ffce991c1fe1aa2adb1
"$HERMES_PYTHON" scripts/check --commit HEAD --base evidence-base
git diff --check 05d7b5af1c42d524762c7ffce991c1fe1aa2adb1...HEAD
```

## Evidence map

- Source changes: `hermes_cli/kanban_db_dispatch.py` and `hermes_cli/kanban_worker_identity.py`
- Regression tests: `tests/hermes_cli/test_kanban_worker_pid_fingerprint.py`
- Test-only RED control: `evidence/pid-fingerprint-nonpositive-red.patch`
- Public automated verification: `.github/workflows/pid-fingerprint-evidence.yml`
- Upstream discussion: [pull request #142539](https://github.com/NousResearch/hermes-agent/pull/142539)
- Supplemental public review: [issue comment 6407501649](https://github.com/NousResearch/hermes-agent/pull/142539#issuecomment-6407501649)
