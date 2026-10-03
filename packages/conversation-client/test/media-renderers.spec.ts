import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { graphFeedState, type CompositionGraph } from "@clarkcant/contracts";

import { CATALOG, type RendererProps } from "../src/renderers.tsx";
import type { ObjectUrlStatus, ObjectUrls } from "../src/use-object-urls.ts";

function render(definitionId: string, props: Record<string, unknown>, state?: Record<string, unknown>): string {
  const renderer = CATALOG[definitionId];
  if (renderer === undefined) throw new Error(`${definitionId} has no renderer`);
  const input: RendererProps = {
    definitionId,
    props,
    dataset: undefined,
    imageUrl: (ref: string) => `blob:test/${ref}`,
    state,
  };
  return renderToStaticMarkup(createElement(renderer, input));
}

/** Drawn by a host that reads a player's bytes only on request. */
function renderWith(definitionId: string, props: Record<string, unknown>, mediaUrls: ObjectUrls, state?: Record<string, unknown>): string {
  const renderer = CATALOG[definitionId];
  if (renderer === undefined) throw new Error(`${definitionId} has no renderer`);
  const input: RendererProps = {
    definitionId,
    props,
    dataset: undefined,
    imageUrl: (ref: string) => `blob:test/${ref}`,
    mediaUrls,
    state,
  };
  return renderToStaticMarkup(createElement(renderer, input));
}

const PICTURES = { imageRefs: ["one", "two", "three"], alts: ["First", "Second", "Third"] };

describe("media renderers", () => {
  it("draws a stored carousel or gallery that has no state at its first item", () => {
    expect(render("canvas.carousel@1", PICTURES)).toContain('data-carousel-index="0"');
    const gallery = render("canvas.gallery@1", PICTURES);
    expect(gallery.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(gallery).toMatch(/aria-pressed="true"[^>]*>(?:(?!<\/button>).)*data-image-ref="one"/);
  });

  it("opens at the held selection, normalized against the pictures it has now", () => {
    expect(render("canvas.carousel@1", PICTURES, { selectedIndex: 1 })).toContain('data-carousel-index="1"');
    expect(render("canvas.carousel@1", PICTURES, { selectedIndex: 9 })).toContain('data-carousel-index="2"');
    expect(render("canvas.gallery@1", PICTURES, { selectedIndex: 2 })).toMatch(/aria-pressed="true"[^>]*>(?:(?!<\/button>).)*data-image-ref="three"/);
  });

  it("draws the picture a composed surface holds, in the carousel beside the gallery that picked it", () => {
    const graph: CompositionGraph = {
      state: { picture: { type: "number", initial: 0 } },
      on: ["pictures-1", "pictures-2"].map((sectionId) => ({
        sectionId,
        event: "media.select",
        steps: [{ op: "select-field" as const, key: "picture", field: "selectedIndex" }],
      })),
      feed: [],
    };
    const carousel = { sectionId: "pictures-2", definitionId: "canvas.carousel@1" };
    const gallery = { sectionId: "pictures-1", definitionId: "canvas.gallery@1" };
    expect(render("canvas.carousel@1", PICTURES, graphFeedState(graph, { picture: 2 }, carousel as never))).toContain('data-carousel-index="2"');
    expect(render("canvas.gallery@1", PICTURES, graphFeedState(graph, { picture: 1 }, gallery as never))).toMatch(
      /aria-pressed="true"[^>]*>(?:(?!<\/button>).)*data-image-ref="two"/,
    );
  });

  it("keeps a gallery caption outside its selection button", () => {
    const gallery = render("canvas.gallery@1", PICTURES);
    expect(gallery).not.toMatch(/<button[^>]*>(?:(?!<\/button>).)*<figcaption/);
    expect(gallery).toContain("<figcaption");
  });

  it("restores a video that was playing without asking it to play", () => {
    const video = render("canvas.video@1", { videoRef: "clip", alt: "A short clip" }, { status: "playing", position: 12, duration: 30 });
    expect(video).toContain('src="blob:test/clip"');
    expect(video).not.toContain("autoplay");
    expect(video).not.toContain("autoPlay");
  });

  it("says beside each media widget why the node refused its last change", () => {
    const refusal = { message: "This could not be done. Nothing was changed.", viewReset: 1 };
    for (const [definitionId, props, name] of [
      ["canvas.carousel@1", PICTURES, "carousel"],
      ["canvas.gallery@1", PICTURES, "gallery"],
      ["canvas.video@1", { videoRef: "clip", alt: "A short clip" }, "video"],
    ] as const) {
      const drawn = render(definitionId, props, { ...refusal, selectedIndex: 1 });
      expect(drawn).toContain(`data-media-message="${name}"`);
      expect(drawn).toMatch(/role="status"[^>]*>This could not be done\. Nothing was changed\.</);
      // No refusal, no sentence.
      expect(render(definitionId, props, { selectedIndex: 1 })).not.toContain("data-media-message");
    }
    // The carousel draws the picture the node holds next to the refusal, not the one that was refused.
    expect(render("canvas.carousel@1", PICTURES, { ...refusal, selectedIndex: 1 })).toContain('data-carousel-index="1"');
  });

  it("plays audio from the node with native controls, never by itself, even when it was playing", () => {
    const props = { title: "Brief", audioRef: "artifact:art_1", mimeType: "audio/ogg", durationSeconds: 75, sizeBytes: 2048, sourceOrigin: "https://media.example.com" };
    const audio = render("canvas.audio@1", props, { status: "playing", position: 12, duration: 75 });
    expect(audio).toContain('src="blob:test/artifact:art_1"');
    expect(audio).toMatch(/<audio[^>]*controls/);
    expect(audio).toMatch(/<audio[^>]*aria-label="Brief"/);
    expect(audio).not.toMatch(/autoplay/i);
    expect(audio).toContain("1:15");
    expect(audio).toContain("https://media.example.com");
    expect(audio).not.toContain("data-audio-transcript");
  });

  it("draws a player whose bytes are not read yet as the host's Play button, with no source and no request", () => {
    const requested: string[] = [];
    const lazy = (status: ObjectUrlStatus): ObjectUrls => ({
      get: (ref) => (status === "ready" ? `blob:lazy/${ref}` : undefined),
      status: () => status,
      request: (ref) => requested.push(ref),
    });
    const audioProps = { title: "Brief", audioRef: "artifact:art_1", mimeType: "audio/ogg", durationSeconds: 75 };
    const videoProps = { videoRef: "clip", alt: "A short clip", posterRef: "still" };
    for (const [definitionId, props, name] of [
      ["canvas.audio@1", audioProps, "audio"],
      ["canvas.video@1", videoProps, "video"],
    ] as const) {
      for (const status of ["idle", "loading"] as const) {
        const drawn = renderWith(definitionId, props, lazy(status), { status: "paused", position: 12, duration: 75 });
        expect(drawn).not.toContain(`<${name}`);
        expect(drawn).not.toContain("blob:lazy/");
        expect(drawn).toMatch(new RegExp(`<button[^>]*data-media-play="${name}"`));
        expect(drawn).toMatch(/<button[^>]*aria-disabled="false"/);
        // No progress is shown before anyone pressed play, even while the bytes are being read near the screen.
        expect(drawn).toMatch(/<p[^>]*role="status"[^>]*data-media-loading="[a-z]+"><\/p>/);
        expect(drawn).toContain('data-media-state="waiting"');
      }
      // Ready: the native player, exactly as before.
      const ready = renderWith(definitionId, props, lazy("ready"));
      expect(ready).toContain(`<${name}`);
      expect(ready).toContain("blob:lazy/");
      expect(ready).not.toMatch(/autoplay/i);
      expect(ready).not.toContain("data-media-play");
      // A source the node refused says so, as it always did.
      expect(renderWith(definitionId, props, lazy("failed"))).not.toContain("data-media-play");
    }
    // The poster is a picture, drawn while the video waits; the Play button is named for what it plays.
    const waiting = renderWith("canvas.video@1", videoProps, lazy("idle"));
    expect(waiting).toContain('src="blob:test/still"');
    expect(waiting).toMatch(/aria-label="(?:Phát video|Play video): A short clip"/);
    // Drawing never asks for the bytes: that is the observer's or the person's call.
    expect(requested).toEqual([]);
  });

  it("refuses to draw audio whose source is not a host reference", () => {
    const audio = render("canvas.audio@1", { title: "Brief", audioRef: "https://media.example.com/a.ogg", mimeType: "audio/ogg" });
    expect(audio).not.toContain("<audio");
    expect(audio).not.toContain("media.example.com");
  });

  it("shows a transcript as text with each hidden character marked", () => {
    const audio = render("canvas.audio@1", { title: "Brief", audioRef: "artifact:a", mimeType: "audio/wav", transcript: `Hello${String.fromCodePoint(0x202e)} <b>world</b>` });
    expect(audio).toContain("<details");
    expect(audio).toContain("⟨U+202E⟩");
    expect(audio).not.toContain(String.fromCodePoint(0x202e));
    expect(audio).toContain("&lt;b&gt;world&lt;/b&gt;");
  });

  it("previews a document a page at a time, as text, at the page the node holds", () => {
    const props = { name: "notes.txt", mimeType: "text/plain", documentRef: "attachment:att_1", pages: ["first <script>alert(1)</script>", `second${String.fromCodePoint(0x200b)}`, "third"], totalChars: 60, truncated: false };
    const first = render("canvas.document@1", props);
    expect(first).toContain('data-document-page="0"');
    expect(first).toContain("&lt;script&gt;");
    expect(first).not.toContain("<script");
    expect(first).toMatch(/aria-disabled="true"[^>]*data-document-turn="previous"/);
    expect(first).toMatch(/aria-disabled="false"[^>]*data-document-turn="next"/);
    expect(first).toMatch(/role="region"[^>]*tabindex="0"|tabindex="0"[^>]*role="region"/i);
    expect(first).not.toContain("data-document-truncated");

    const second = render("canvas.document@1", props, { page: 1 });
    expect(second).toContain('data-document-page="1"');
    expect(second).toContain("data-viewer-hidden=\"1\"");
    expect(second).not.toContain(String.fromCodePoint(0x200b));

    // A page past the end is read as the last page.
    expect(render("canvas.document@1", props, { page: 7 })).toContain('data-document-page="2"');
  });

  it("says when a document's preview was cut short, and draws one page without paging controls", () => {
    const drawn = render("canvas.document@1", { name: "big.pdf", mimeType: "application/pdf", documentRef: "artifact:a", pages: ["only"], sourcePages: 40, totalChars: 90_000, truncated: true });
    expect(drawn).toContain("data-document-truncated");
    expect(drawn).toContain("90000");
    expect(drawn).not.toContain("data-document-turn");
  });

  it("says beside the audio player and the document why the node refused their last change", () => {
    const refusal = { message: "This could not be done. Nothing was changed.", viewReset: 1 };
    expect(render("canvas.audio@1", { title: "Brief", audioRef: "artifact:a", mimeType: "audio/wav" }, refusal)).toContain('data-media-message="audio"');
    expect(render("canvas.document@1", { name: "a.txt", mimeType: "text/plain", documentRef: "artifact:a", pages: ["a", "b"], totalChars: 2, truncated: false }, refusal)).toContain(
      'data-media-message="document"',
    );
  });

  it("names a picture without a description by its place, in the reader's language", () => {
    const gallery = render("canvas.gallery@1", { imageRefs: ["one", "two"] });
    expect(gallery).not.toMatch(/aria-label="\d+\/\d+"/);
    expect(gallery).toMatch(/aria-label="(?:Ảnh 2\/2|Picture 2 of 2)"/);
  });
});
