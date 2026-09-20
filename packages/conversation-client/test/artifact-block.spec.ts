import { isValidElement, type ReactElement } from "react";

import { describe, expect, it } from "vitest";

import { ArtifactBlock, type BlockActions, renderBlock } from "../src/blocks.tsx";
import { findAll } from "./block-helpers.ts";

/**
 * Reopening an artifact.
 *
 * The block in the transcript is history and stays read-only: it says what the message recorded. What the node
 * still holds is a different question, and the tests below are about the three answers being told apart — what the
 * node has, what it used to have, and what could not be reached at all. Collapsing those into one "unavailable"
 * is how a user ends up looking for a fault when they only needed to ask for the file again.
 */

const BLOCK = {
  type: "artifact",
  artifactId: "art_1",
  mimeType: "application/pdf",
  sizeBytes: 20480,
  digest: "sha256:abc",
  label: "báo cáo quý.pdf",
};

const withOpen = { onArtifactOpen: () => {} } satisfies BlockActions;

describe("the artifact block", () => {
  it("offers a way to reopen it only when something can answer", () => {
    const bare = ArtifactBlock({ block: BLOCK });

    // The snapshot is still described in full; what is withheld is a control that would do nothing.
    expect(findAll(bare, "data-artifact")).toHaveLength(1);
    expect(findAll(bare, "data-artifact-open")).toHaveLength(0);
    expect(findAll(bare, "data-artifact-opened")).toHaveLength(0);

    const offered = ArtifactBlock({ block: BLOCK, actions: withOpen });
    expect(findAll(offered, "data-artifact-open")).toHaveLength(1);
  });

  it("reports facts the node returned rather than the snapshot's own numbers", () => {
    const opened = ArtifactBlock({
      block: BLOCK,
      actions: {
        ...withOpen,
        artifactOpen: {
          art_1: {
            status: "opened",
            digest: "sha256:def",
            sizeBytes: 4096,
            mimeType: "text/plain",
            originNodeId: "node_b",
            createdAt: "2026-09-19T17:00:00.000Z",
            expiresAt: null,
            expired: false,
          },
        },
      },
    });

    const fields = findAll(opened, "data-artifact-opened")[0];
    expect(fields?.props["data-artifact-expired"]).toBe("false");
    const text = JSON.stringify(fields);
    // The node's values, not the block's: the message said 20480 bytes of pdf and the node says otherwise.
    expect(text).toContain("4096");
    expect(text).toContain("sha256:def");
    expect(findAll(opened, "data-artifact-expiry")).toHaveLength(0);
  });

  it("says an artifact expired rather than that it is missing", () => {
    const expired = ArtifactBlock({
      block: BLOCK,
      actions: {
        ...withOpen,
        artifactOpen: {
          art_1: {
            status: "opened",
            digest: "sha256:def",
            sizeBytes: 4096,
            mimeType: "application/pdf",
            originNodeId: "node_a",
            createdAt: "2026-09-01T00:00:00.000Z",
            expiresAt: "2026-09-10T00:00:00.000Z",
            expired: true,
          },
        },
      },
    });

    const notice = findAll(expired, "data-artifact-expiry")[0];
    expect(notice).toBeDefined();
    // The reason and the remedy, because "gone" without either leaves the user guessing.
    expect(String(notice?.props.children)).toContain("hết hạn");
    expect(String(notice?.props.children)).toContain("yêu cầu tạo lại");
    // And it is not reported as an error, which would read as something having gone wrong.
    expect(findAll(expired, "data-artifact-error")).toHaveLength(0);
  });

  it("shows the failure where the control is, and claims no artifact", () => {
    const failed = ArtifactBlock({
      block: BLOCK,
      actions: {
        ...withOpen,
        artifactOpen: { art_1: { status: "failed", message: "Không mở được artifact này." } },
      },
    });

    expect(findAll(failed, "data-artifact-error")).toHaveLength(1);
    expect(findAll(failed, "data-artifact-opened")).toHaveLength(0);
    expect(findAll(failed, "data-artifact-expiry")).toHaveLength(0);
  });

  it("refuses a block that does not name an artifact", () => {
    // No id means nothing to ask about, so there is no control even with a handler present.
    const anonymous = ArtifactBlock({ block: { ...BLOCK, artifactId: undefined }, actions: withOpen });
    expect(findAll(anonymous, "data-artifact-open")).toHaveLength(0);
  });

  it("is reachable through the dispatcher with its actions wired", () => {
    const actions = { onArtifactOpen: () => {} };
    const dispatched = renderBlock(
      { ...BLOCK },
      0,
      (() => null) as unknown as Parameters<typeof renderBlock>[2],
      actions,
    );

    /*
     * The wiring is what can be asserted here, not the control. `renderBlock` returns the element, so the
     * button inside the card does not exist until React renders it — a walk over the returned tree finds
     * nothing whether or not the dispatcher forwarded anything, which is a test that passes either way.
     *
     * This is the same shape of mistake the task card shipped with: a component asserted by calling it directly
     * passes while the dispatcher hands it nothing, and only the browser can tell the difference.
     */
    expect(isValidElement(dispatched)).toBe(true);
    const element = dispatched as ReactElement<{ actions?: unknown }>;
    expect(element.type).toBe(ArtifactBlock);
    expect(element.props.actions).toBe(actions);
  });
});
