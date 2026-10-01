Cross-platform visual preparation for dependent #302 exposed an actual #300 defect before merge: the CLI Theme Lab received inline appearance variables but never installed the shared component stylesheet. The screenshot showed native browser controls. A browser regression asserting production canvas overflow/border style failed on 374e100a (`e2e-300-styles-red.log`).

The dev runtime now calls the existing idempotent `installStyles` before mounting. The shared preview uses scoped body/display typography and the host's compiled backdrop pattern, so reference effects do not silently use the app's outer theme. No author CSS or new resource contract is accepted. Eight author/Gallery journeys now pass at 1280/390, dark/light (`e2e-300-styles-green.log`).

Both prior CI reruns are green on 374e100a, but that evidence does not cover this repair. Re-run full verification and exact-head CI after the focused fix. PR368 and paired web PR61 remain unmerged.
