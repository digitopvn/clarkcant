The artifact broker regression test `keeps a finalized file readable by the widget that made it, and ends every other widget’s grant on time` compares a real wall-clock grant expiry to fixed `AT = 2026-09-30T08:00:00Z` + 24 hours + one hour. After 09:00 UTC, a correctly renewed grant always exceeds that threshold.

Observed in PR #365, run 36692667263, Windows job 109813243266: expected 1790845209173 to be less than 1790845200000. Reproduced locally after 09:07 UTC with the focused test: expected 1790845672477 to be less than 1790845200000. The other run passed before the cutoff. This is a pre-existing test-clock defect, not conversation deletion behavior.

Repair: bound the last write by its actual start/end timestamps, check the grant expiry equals write time plus the documented TTL, and ensure finalization does not renew it. Continue testing maker access after expiry, other-widget refusal and explicit revocation. No runtime/API/docs behavior changes.

Acceptance: focused repro becomes green without weakening TTL/expiry assertions; whole artifact broker suite and pnpm verify pass; #365’s required CI passes on the repaired head.
