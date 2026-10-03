import type { ReactElement } from "react";

import { unreadListingFieldsSchema, type UnreadListingFields } from "@clarkcant/contracts";

import { fillMessage } from "./i18n/fill-message.ts";
import { useT } from "./i18n/locale-context.tsx";

/**
 * What a directory listing says that this node does not read, on the marketplace card, the install question and the
 * update notice that show the listing. A newer directory may add a field this node has never heard of, and the node
 * drops it rather than refusing the directory; this line is what keeps that drop from being silent, because such a
 * field may be one the newer directory treats as binding. Names only: the node never passes a value it did not read.
 */

/** The note in a value from the wire, or `undefined` when there is none or it is not one. */
export function readUnreadFields(value: unknown): UnreadListingFields | undefined {
  const parsed = unreadListingFieldsSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function UnreadListingFieldsNote({ fields }: { fields: UnreadListingFields | undefined }): ReactElement | null {
  const t = useT();
  if (fields === undefined) return null;
  const names = fields.names.join(", ") + (fields.count > fields.names.length ? ", …" : "");
  return (
    <p className="cc-freshness" style={{ margin: 0 }} data-unread-listing-fields={String(fields.count)}>
      {fillMessage(t("package.unreadFields"), { count: fields.count, names })}
    </p>
  );
}
