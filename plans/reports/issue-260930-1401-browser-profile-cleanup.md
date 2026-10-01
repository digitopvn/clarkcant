## Observed failure

PR #362 CI run [36680677689](https://github.com/digitopvn/clarkcant/actions/runs/36680677689), Windows job 109775214291, passed all 4,897 assertions but failed suite teardown at `packs/browser-playwright/test/submit-once.spec.ts:71` with `EPERM` removing its temporary profile directory. The same revision's other Windows run passed. The test already awaits `driver.close()`.

## Expected repair

Keep browser shutdown awaited and allow a bounded retry for transient Windows profile-file locks during cleanup. Exhausted retries must still fail the suite. Check nearby browser test cleanup for the same failure mode, run the focused suite repeatedly on Windows, then run `pnpm verify` and required CI. Do not weaken submit-once assertions.

This blocks reliable verification across unrelated PRs, so repair before the next feature work. Related: #359 and PR #362; the failure is outside the calendar diff.
