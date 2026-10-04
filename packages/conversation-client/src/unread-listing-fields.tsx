import type { ReactElement } from "react";

import { unreadListingFieldsSchema, type UnreadListingFields } from "@clarkcant/contracts";

import { fillMessage } from "./i18n/fill-message.ts";
import { useT } from "./i18n/locale-context.tsx";

/**
 * What a directory listing says that this node does not read, on the marketplace card, the install question and the
 * update notice that show the listing. A newer directory may add a field this node has never heard of, and the node
 * drops it rather than refusing the directory; this note is what keeps that drop from being silent, because such a
 * field may be one the newer directory treats as binding. Names only: the node never passes a value it did not read.
 *
 * The sentence is Clark's own words and holds only the count. Each field name is the publisher's text, so it is drawn
 * apart from the sentence, one code element each, and only names the contract allows (plain identifier paths) arrive.
 */

/** The note in a value from the wire, or `undefined` when there is none or it is not one. */
export function readUnreadFields(value: unknown): UnreadListingFields | undefined {
  const parsed = unreadListingFieldsSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function UnreadListingFieldsNote({ fields }: { fields: UnreadListingFields | undefined }): ReactElement | null {
  const t = useT();
  if (fields === undefined) return null;
  const notNamed = fields.count - fields.names.length;
  return (
    <div className="cc-freshness" data-unread-listing-fields={String(fields.count)}>
      <p style={{ margin: 0 }}>
        {fillMessage(t(fields.count === 1 ? "package.unreadFields.one" : "package.unreadFields.other"), { count: fields.count })}
      </p>
      {fields.names.length > 0 && (
        <ul className="cc-unread-listing-fields" style={{ margin: 0, paddingInlineStart: "1.25em" }}>
          {fields.names.map((name) => (
            <li key={name} data-unread-field={name}>
              <code>{name}</code>
            </li>
          ))}
        </ul>
      )}
      {notNamed > 0 && (
        <p style={{ margin: 0 }} data-unread-not-named={String(notNamed)}>
          {fillMessage(t("package.unreadFields.notNamed"), { count: notNamed })}
        </p>
      )}
    </div>
  );
}
