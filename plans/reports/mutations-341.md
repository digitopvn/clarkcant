# Mutation checks for #341

For each check, one guard was removed, the named tests were run, and the file was restored afterwards. Every mutation was killed: at least one test failed.

| Guard removed | Failing tests |
|---|---|
| `isPersonOnlyRoute` clause `packages/install` | 4: contracts notice-actions, cli api, open-interfaces relay, install-approval |
| Machine-surface header guard on `POST /packages/install` | 1: install-approval |
| Machine-surface header guard on the decision route | 1: install-approval |
| `installPackage` approved-digest check | 1: install-approval, "direct call with wrong approved digest" |
| Listing check before claiming the approval | 1: install-approval, "republished → DIGEST_MISMATCH, still pending" |
| Seen-digest pre-check (`APPROVAL_FORGED`) | 1: install-approval |
| ask→execute only with a matching approval | 1: install-approval |
| Digest filter on the pending listing | 1: install-approval |
| Expiry sweep settling install approvals | 1: install-approval |
| Expiry `changes === 0` race check | 1: install-approval, "decided between the sweep's read and write". This mutation survived at first; the test was added to kill it. |

After all files were restored, the unmutated `install-approval.spec.ts` passes 13/13.
