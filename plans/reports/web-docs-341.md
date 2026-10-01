# Proposed clarkcant-web text for #341

Not applied to `digitopvn/clarkcant-web` (out of scope for this PR by instruction). Paste into the API guide pages.

## EN — API guide, "Packages" section

### Installing a package is person-only

`POST /packages/install` installs the package the person chose. Only the person's own surface can call it: MCP, the
WebSocket relay and `clarkcant api` get `403 PERSON_ONLY`, and no agent or model tool can install a package.

When the person's execution mode asks before installing, the node installs nothing and answers `202` with
`{ "code": "APPROVAL_REQUIRED", "message": "…", "approvalId": "…" }`. The install then waits in the inbox:

- `GET /inbox` lists it under `waiting` as `kind: "install-approval"` with `approvalId`, `packageId`, `version`,
  `displayName`, `permissions` (what the package asks for, in the listing's own words), `riskTier`,
  `description`, `operationDigest`, `requestedAt` and `expiresAt`.
- It is listed only while the directory still publishes that exact package and version with the same digest.

The person decides it with `POST /packages/approvals/{approvalId}/decision`. Send `{ "decision": "granted" | "denied",
"digest": "<operationDigest>" }`, where the digest is the one the item showed. This is the same person-only route used for
capability approvals.

- **Denied**: nothing is installed, and the installed packages are unchanged.
- **Granted**: the node runs the same install, with the same checks, bound to that digest.

A granted decision can still be refused:

| Code | When |
|---|---|
| `DIGEST_MISMATCH` (409) | The listing changed after the question. The question stays open, and nothing is installed. |
| `POLICY_REFUSED` (403) | The execution mode now forbids installs. |
| `APPROVAL_FORGED` | The digest sent is not the one that was asked about. |
| `APPROVAL_ALREADY_DECIDED` | The question was already decided. |
| `APPROVAL_EXPIRED` | The ten-minute deadline has passed. |

An install that nobody decides expires after ten minutes. Nothing is installed, and a notice says so. Every outcome
(asked, installed, denied, expired, refused, failed) is recorded on the `package.install-approval` event stream.

A notice's **Update** action and the marketplace **Install** button both lead to this waiting item and say where to
decide it.

## VI — Hướng dẫn API, mục "Gói"

### Cài gói là việc chỉ người dùng làm

`POST /packages/install` cài gói mà người dùng đã chọn. Chỉ bề mặt của chính người dùng gọi được route này: MCP, relay
WebSocket và `clarkcant api` nhận `403 PERSON_ONLY`, và không agent hay tool nào của mô hình cài được gói.

Khi chế độ thực thi của người dùng yêu cầu hỏi trước khi cài, node không cài gì. Node trả `202` kèm
`{ "code": "APPROVAL_REQUIRED", "message": "…", "approvalId": "…" }`, rồi lần cài chờ trong hộp thư:

- `GET /inbox` liệt kê nó trong `waiting` với `kind: "install-approval"`, gồm `approvalId`, `packageId`, `version`,
  `displayName`, `permissions` (những quyền gói xin, theo đúng lời của trang gói), `riskTier`, `description`,
  `operationDigest`, `requestedAt` và `expiresAt`.
- Mục này chỉ được liệt kê khi thư mục gói vẫn còn công bố đúng gói, đúng phiên bản và đúng digest đó.

Người dùng quyết định bằng `POST /packages/approvals/{approvalId}/decision`. Gửi `{ "decision": "granted" | "denied",
"digest": "<operationDigest>" }`, trong đó digest là digest mà mục đã hiện. Đây cũng là route chỉ-người-dùng dùng cho việc
duyệt quyền của gói.

- **Từ chối**: không cài gì, và các gói đang cài vẫn giữ nguyên.
- **Duyệt**: node chạy đúng lần cài đó, qua cùng các bước kiểm tra, gắn với digest đó.

Một quyết định duyệt vẫn có thể bị từ chối:

| Mã | Khi nào |
|---|---|
| `DIGEST_MISMATCH` (409) | Trang gói đã đổi sau khi hỏi. Câu hỏi vẫn mở, và chưa cài gì. |
| `POLICY_REFUSED` (403) | Chế độ thực thi hiện cấm cài. |
| `APPROVAL_FORGED` | Digest gửi lên không phải digest đã hỏi. |
| `APPROVAL_ALREADY_DECIDED` | Câu hỏi đã được quyết định rồi. |
| `APPROVAL_EXPIRED` | Đã quá hạn mười phút. |

Lần cài không ai quyết định sẽ hết hạn sau mười phút. Không cài gì, và một thông báo nói rõ điều đó. Mọi kết quả (đã hỏi,
đã cài, đã từ chối, hết hạn, bị từ chối, thất bại) được ghi vào luồng sự kiện `package.install-approval`.

Thao tác **Cập nhật** trên thông báo và nút **Cài** trong marketplace đều dẫn tới mục chờ này và nói nơi để quyết định.

## EN — landing text (user-visible)

Installs your execution mode asks about wait for you in the inbox. You see the package, its version and what it asks
for, then choose Approve and install or Deny. Only you can decide. Agents, MCP clients and the CLI cannot install a
package for you.
