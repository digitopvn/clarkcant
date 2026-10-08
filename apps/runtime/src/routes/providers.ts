import { appendAuditEvent } from "@clarkcant/storage";
import { nowInstant, providerSignInMethodSchema } from "@clarkcant/contracts";

import { providerSignInsFor } from "../application/provider-sign-in.ts";
import { type NodeServices } from "../services.ts";
import { type GatewayRequest, type GatewayResponse, fail, json, readJson } from "./http.ts";

/**
 * Signing in to and out of AI providers, for the cards `/login` and `/logout` answer with.
 *
 * - `GET /providers/auth` — the providers pi can sign in to, and which are signed in. Never a credential.
 * - `POST /providers/:id/sign-in {method}` — starts the provider's own sign-in; the answer is the sign-in to follow.
 * - `GET /providers/sign-ins` — the sign-ins still running or waiting, so a surface opened again shows the one it left.
 * - `GET /providers/sign-ins/:id` — where a sign-in is: a page to open, a code, a question, or how it ended.
 * - `POST /providers/sign-ins/:id/answer {value}` — the person's answer, handed straight to the provider, never kept.
 * - `POST /providers/sign-ins/:id/cancel`
 * - `POST /providers/:id/sign-out` — removes the credential pi stored. A key in the environment is not pi's to remove.
 *
 * Everything but the listing is person-only (`isPersonOnlyRoute`): whose account the node runs on is the person's call.
 */
export interface ProviderRouteDeps {
  services: Pick<NodeServices, "runtime" | "conductor" | "providerAuth">;
  request: GatewayRequest;
  segments: string[];
}

const NO_PROVIDER_AUTH = "This node has no pi runtime to sign in through, so there are no providers to sign in to here.";

export async function handleProviderRoutes(deps: ProviderRouteDeps): Promise<GatewayResponse | undefined> {
  const { request, segments, services } = deps;
  if (segments[0] !== "providers") return undefined;
  const port = services.providerAuth;
  if (port === undefined) return fail(503, "PROVIDER_AUTH_UNAVAILABLE", NO_PROVIDER_AUTH);
  const signIns = providerSignInsFor(port);
  const audit = (summary: string, ref: string, outcome: "done" | "failed"): void => {
    appendAuditEvent(services.runtime.db, {
      auditId: services.conductor.newId("audit"),
      principalId: services.runtime.identity.ownerPrincipalId,
      nodeId: services.runtime.identity.nodeId,
      kind: "interaction",
      summary,
      outcome,
      ref,
      at: nowInstant(),
    });
  };

  if (segments.length === 2 && segments[1] === "auth" && request.method === "GET") {
    try {
      return json(200, { providers: await port.providerAuth() });
    } catch (cause) {
      return fail(502, "PROVIDER_AUTH_FAILED", `pi could not list its providers: ${messageOf(cause)}`);
    }
  }

  if (segments.length === 2 && segments[1] === "sign-ins" && request.method === "GET") {
    return json(200, { signIns: signIns.running() });
  }

  if (segments.length === 3 && segments[1] === "sign-ins" && request.method === "GET") {
    const view = signIns.view(segments[2] ?? "");
    return view === undefined ? fail(404, "SIGN_IN_NOT_FOUND", "This sign-in has ended; start it again from /login.") : json(200, view);
  }

  if (segments.length === 4 && segments[1] === "sign-ins" && request.method === "POST") {
    const signInId = segments[2] ?? "";
    if (segments[3] === "answer") {
      const parsed = readJson(request);
      if (!parsed.ok) return parsed.response;
      const value = parsed.value.value;
      if (typeof value !== "string" || value.length > 10_000) return fail(400, "INVALID_SCHEMA", "an answer is a string of at most 10000 characters");
      const answered = signIns.answer(signInId, value);
      return answered.ok ? json(200, answered.view) : fail(answered.code === "SIGN_IN_NOT_FOUND" ? 404 : 409, answered.code, answered.message);
    }
    if (segments[3] === "cancel") {
      const view = signIns.cancel(signInId);
      return view === undefined ? fail(404, "SIGN_IN_NOT_FOUND", "This sign-in has already ended.") : json(200, view);
    }
  }

  if (segments.length === 3 && request.method === "POST") {
    const providerId = decodeURIComponent(segments[1] ?? "");
    const providers = await port.providerAuth().catch(() => []);
    const provider = providers.find((entry) => entry.providerId === providerId);
    if (provider === undefined) return fail(404, "PROVIDER_NOT_FOUND", `pi has no provider "${providerId}" to sign in to.`);

    if (segments[2] === "sign-in") {
      const parsed = readJson(request);
      if (!parsed.ok) return parsed.response;
      const method = providerSignInMethodSchema.safeParse(parsed.value.method);
      if (!method.success) return fail(400, "INVALID_SCHEMA", "method is oauth or api_key");
      if (method.data === "oauth" && provider.oauth === undefined) {
        return fail(409, "SIGN_IN_METHOD_UNAVAILABLE", `${provider.name} has no sign-in of its own; use an API key.`);
      }
      if (method.data === "api_key" && !provider.apiKey) {
        return fail(409, "SIGN_IN_METHOD_UNAVAILABLE", `${provider.name} does not take an API key.`);
      }
      const view = signIns.start(providerId, method.data);
      audit(`started signing in to ${provider.name}`, providerId, "done");
      return json(202, view);
    }

    if (segments[2] === "sign-out") {
      if (!provider.configured) return json(200, { providerId, signedOut: false, reason: "not-signed-in" });
      if (provider.source !== "stored") {
        return fail(
          409,
          "SIGN_OUT_NOT_HERE",
          provider.source === "environment"
            ? `${provider.name}'s key comes from the environment (.env or the shell); remove it there.`
            : `${provider.name}'s credential is not one pi stored, so it cannot be removed here.`,
        );
      }
      try {
        await port.signOut(providerId);
      } catch (cause) {
        audit(`could not sign out of ${provider.name}`, providerId, "failed");
        return fail(502, "SIGN_OUT_FAILED", `pi could not sign out of ${provider.name}: ${messageOf(cause)}`);
      }
      audit(`signed out of ${provider.name}`, providerId, "done");
      return json(200, { providerId, signedOut: true });
    }
  }

  return fail(404, "RESOURCE_NOT_FOUND", "no such providers route");
}

function messageOf(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause)).slice(0, 500);
}
