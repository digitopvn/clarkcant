import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { PackageResourcesView } from "../src/api.ts";
import { CATALOGS } from "../src/i18n/messages.ts";
import { PackageResources } from "../src/settings/ExtensionsSettings.tsx";

/**
 * What package details say about the resources a package's code runs in.
 *
 * A granted profile is shown as its bounds; a refused one as the node's reason and the fact that the code does not
 * run. It is never shown as a smaller profile that "still works", because the node does not run it that way.
 */

const granted: PackageResourcesView = {
  requested: "media-workstation",
  status: "granted",
  profile: "media-workstation",
  bounds: {
    memoryMib: 4096,
    cpus: 4,
    pids: 512,
    tmpfsMib: 512,
    callDeadlineMs: 300_000,
    jobDeadlineMs: 2 * 60 * 60_000,
    maxActiveJobs: 1,
  },
  summary: "4 GiB memory, 4 CPUs, 512 processes, 512 MiB scratch, 300 s per call, 2 h per job, 1 job at once, no network",
  offscreen: "authorized-playback",
  notes: ["the container engine does not enforce memory and CPU limits here, so the service runs without them"],
};

function render(resources: PackageResourcesView): string {
  return renderToStaticMarkup(createElement("dl", null, createElement(PackageResources, { resources })));
}

describe("package details: resources", () => {
  it("shows a granted profile by its name, its bounds in readable units, playback, and the node's notes", () => {
    const html = render(granted);
    expect(html).toContain('data-installed-resources="granted"');
    expect(html).toContain('data-resource-profile="media-workstation"');
    // The default locale is Vietnamese; the bounds are formatted from numbers, not the node's English summary.
    expect(html).toContain("Bộ nhớ 4 GiB, 4 CPU, 512 tiến trình, vùng tạm 512 MiB, 5 min mỗi lệnh gọi, 2 h mỗi tác vụ");
    expect(html).toContain(CATALOGS.vi["settings.extensions.resources.playback"]);
    expect(html).toContain("does not enforce memory and CPU limits");
  });

  it("shows a refused profile as the node's reason and says the code does not run", () => {
    const html = render({
      requested: "interactive-heavy",
      status: "degraded",
      reason: "interactive-heavy needs 2 CPUs, and the container engine here has 1",
    });
    expect(html).toContain('data-installed-resources="degraded"');
    expect(html).toContain("interactive-heavy needs 2 CPUs, and the container engine here has 1");
    expect(html).toContain("Tương tác nặng");
    expect(html).toContain("không chạy");
    expect(html).not.toContain("data-resource-bounds");
  });

  it("has every profile name and resources message in both languages", () => {
    for (const locale of ["vi", "en"] as const) {
      for (const name of ["interactive-light", "interactive-heavy", "media-workstation", "background-compute"] as const) {
        expect(CATALOGS[locale][`settings.extensions.resources.profile.${name}`]).toBeTruthy();
      }
      expect(CATALOGS[locale]["shell.live.keepPlaying"]).toBeTruthy();
      expect(CATALOGS[locale]["shell.live.playingOffscreen"]).toContain("{title}");
    }
  });
});
