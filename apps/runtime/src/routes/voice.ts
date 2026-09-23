import { type NodeServices } from "../services.ts";
import { type GatewayRequest, type GatewayResponse, fail, json, readJson } from "./http.ts";

/**
 * What the configured voice provider can do, and the scripted provider's seam.
 *
 * Both belong to the same family because both describe the voice path this node actually has: the capability
 * report tells a surface what to offer, and the fixture route is the seam that exists only when a scripted
 * provider is loaded.
 *
 * `undefined` means "not one of mine", which is how the dispatch keeps the route order it had when these
 * branches lived in the gateway.
 */
export interface VoiceRouteDeps {
  services: Pick<NodeServices, "voiceCapabilities" | "voiceFixture" | "voiceLiveUtterance">;
  request: GatewayRequest;
  segments: string[];
  env?: Record<string, string | undefined>;
}

/**
 * The voice family. `undefined` means the request is not one of these routes.
 */
export function handleVoiceRoutes(deps: VoiceRouteDeps): GatewayResponse | undefined {
  const { request, segments } = deps;

  /*
   * What the configured voice provider can do.
   *
   * Reported rather than assumed by the surface: a picker hard-coded with one provider's voice names would
   * offer them to a provider that has never heard of them, and the failure would arrive as a session that
   * connects and then says nothing. A node with no voice gateway answers with a provider that supports
   * nothing, which is a real answer — the tab then shows a reason instead of a control.
   */
  if (segments.length === 2 && segments[0] === "voice" && segments[1] === "capabilities" && request.method === "GET") {
    const capabilities = deps.services.voiceCapabilities?.();
    return json(200, {
      capabilities: capabilities ?? {
        provider: "none",
        supportsVoiceSelection: false,
        voices: [],
        supportsPreview: false,
        note: "Node này chưa bật voice.",
      },
    });
  }

  /*
   * The voice fixture's script.
   *
   * Unreachable on a real node: with no scripted provider loaded there is no seam and this answers 404, so there is no way
   * to tell a production provider what to say. It exists because the fixture is otherwise one fixed sentence, and a
   * browser journey that cannot say a command cannot test what the node does with one - which is exactly the evidence
   * phase 5 was missing.
   */
  if (segments[0] === "voice-fixture") {
    const fixture = deps.services.voiceFixture;
    if (fixture === undefined) return fail(404, "NOT_FOUND", "no voice fixture is loaded on this node");
    if (segments.length !== 2 || segments[1] !== "words" || request.method !== "POST") {
      return fail(404, "NOT_FOUND", "no such voice-fixture route");
    }
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const words = parsed.value.words;
    if (typeof words !== "string" || words.trim() === "") {
      return fail(400, "INVALID_SCHEMA", "words must be a non-empty string");
    }
    fixture.setWords(words.trim());
    return json(200, { ok: true, words: words.trim() });
  }

  /*
   * Live provider test utterance.
   *
   * This route allows browser tests to inject utterances that will be processed by the real voice session
   * and the real agent model. It is test infrastructure only and protected by an explicit test-only flag
   * (CC_LIVE_PROVIDER_TEST=1) to prevent accidental enablement in production.
   *
   * Gated by both the service presence and the explicit flag: merely having the real provider loaded does
   * not enable this route. The flag must be set on the node. Requests go through the normal gateway auth
   * (bearer token in Authorization header), so the gate is: service present + flag set + authenticated.
   *
   * Returns 404 if the flag is not set, if the service is not available, or if the route pattern doesn't match.
   */
  if (segments[0] === "voice-live") {
    const env = deps.env ?? {};
    const testFlagEnabled = env.CC_LIVE_PROVIDER_TEST === "1";
    const liveUtterance = deps.services.voiceLiveUtterance;

    if (!testFlagEnabled || liveUtterance === undefined) {
      return fail(404, "NOT_FOUND", "no live voice provider test is enabled on this node");
    }
    if (segments.length !== 2 || segments[1] !== "utterance" || request.method !== "POST") {
      return fail(404, "NOT_FOUND", "no such voice-live route");
    }
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const words = parsed.value.words;
    if (typeof words !== "string" || words.trim() === "") {
      return fail(400, "INVALID_SCHEMA", "words must be a non-empty string");
    }
    liveUtterance.enqueueUtterance(words.trim());
    return json(200, { ok: true, words: words.trim() });
  }

  return undefined;
}
