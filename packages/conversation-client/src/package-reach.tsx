import type { ReactElement } from "react";

import { declaredReachIsEmpty, declaredReachSchema, type DeclaredReach } from "@clarkcant/contracts";

import { fillMessage } from "./i18n/fill-message.ts";
import { useT } from "./i18n/locale-context.tsx";

/**
 * What a package reaches outside its sandbox, as a person decides on it: each provider origin its services reach
 * through Clark, each key it needs with what the key is for, and each provider its frames may get a browser token from
 * with the scopes, and each account its services work on once the person connects it. Shown on the marketplace listing and the install question before anything is granted, and in
 * package details afterwards.
 *
 * Names and purposes only. A key's value is never part of this, and nothing here could show one: the declaration has
 * no field for it.
 */

/** The reach in a value from the wire, or `undefined` when there is none or it is not a reach. */
export function readReach(value: unknown): DeclaredReach | undefined {
  const parsed = declaredReachSchema.safeParse(value);
  if (!parsed.success) return undefined;
  return declaredReachIsEmpty(parsed.data) ? undefined : parsed.data;
}

export function PackageReach({ reach }: { reach: DeclaredReach | undefined }): ReactElement | null {
  const t = useT();
  if (reach === undefined) return null;
  return (
    <div data-package-reach="true">
      <span style={{ display: "block" }}>{t("settings.extensions.reach.heading")}</span>
      <ul className="cc-package-reach" style={{ margin: 0, paddingInlineStart: "1.25em" }}>
        {reach.origins.map((entry) => (
          <li key={`origin:${entry.origin}:${entry.purpose}`} data-reach-origin={entry.origin}>
            {entry.secret === undefined
              ? fillMessage(t("settings.extensions.reach.origin"), { origin: entry.origin, purpose: entry.purpose })
              : fillMessage(t("settings.extensions.reach.originWithKey"), {
                  origin: entry.origin,
                  secret: entry.secret,
                  purpose: entry.purpose,
                })}
          </li>
        ))}
        {reach.secrets.map((entry) => (
          <li key={`secret:${entry.name}:${entry.purpose}`} data-reach-secret={entry.name}>
            {fillMessage(t("settings.extensions.reach.secret"), { name: entry.name, purpose: entry.purpose })}
          </li>
        ))}
        {reach.browserTokens.map((entry) => (
          <li key={`token:${entry.provider}:${entry.purpose}`} data-reach-token={entry.provider}>
            {fillMessage(t("settings.extensions.reach.token"), {
              provider: entry.provider,
              scopes: entry.scopes.join(", "),
              purpose: entry.purpose,
            })}
          </li>
        ))}
        {(reach.connections ?? []).map((entry) => (
          <li key={`connection:${entry.provider}`} data-reach-connection={entry.provider}>
            {fillMessage(t("settings.extensions.reach.connection"), {
              provider: entry.displayName,
              endpoints: entry.endpoints.join(", "),
              scopes: entry.scopes.map((scope) => `${scope.scope} (${scope.purpose})`).join("; "),
            })}
          </li>
        ))}
      </ul>    </div>
  );
}
