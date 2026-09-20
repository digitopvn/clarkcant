# Audit và tối ưu bộ kiểm thử — 19/09/2026

Đây là trạng thái lịch sử ngày 19/09. Các phát hiện còn lại được xử lý ở [báo cáo tiếp nối ngày 20/09](ship-260920-1037-test-audit-followups.md).

Đã áp dụng tối ưu execution, giữ nguyên assertions hiện có và thêm 18 test cho classifier CI. `pnpm verify` PASS: 1.162 test pass, 7 test opt-in skip, không có failure. Không thay đổi code sản phẩm.

## Audit: các phát hiện chưa sửa

| Mức độ | Bằng chứng | Vấn đề và hướng sửa |
|---|---|---|
| Quan trọng | `packages/contracts/test/contracts.spec.ts:42–56` | Test nói từ chối run ID ở vị trí task ID nhưng chỉ parse task state và từ chối envelope rỗng. Cần gọi schema ID với prefix sai; hiện chưa chứng minh lỗi production. |
| Quan trọng | `apps/runtime/test/hybrid-calibration-live.spec.ts:44–47,75–79` | Khi đã opt-in nhưng không tải được model, test assert chuỗi BLOCKED rồi pass. Cần biểu diễn thiếu điều kiện bằng kết quả không phải PASS cho calibration. |
| Quan trọng | `apps/runtime/test/jev-live.spec.ts:70–72,93–94,106` | Các nhánh unavailable vẫn xanh, nên mạng lỗi có thể được nhầm là smoke test provider đã chạy. Cần đòi response hợp lệ và phân biệt lý do wrong-model với network failure. |
| Quan trọng | `.github/workflows/ci.yml`, `package.json` | CI chỉ chạy Vitest; cài Chromium phục vụ browser-driver tests, không chạy browser journeys của app. Cần bổ sung lane E2E theo phạm vi UI/runtime; đây là tăng bảo vệ và tăng chi phí, không phải tối ưu thuần túy. |
| Quan trọng | `.github/workflows/ci.yml`, job `secret-scan` | Comment nói quét lịch sử nhưng `git grep` chỉ quét tree hiện tại, loại docs. Invariants có quét docs hiện tại; cả hai không chứng minh lịch sử sạch. Cần sửa scanner hoặc thu hẹp lời hứa. |
| Nhỏ | `packages/contracts/test/contracts.spec.ts:184–187` | Tên test nói chuyển lost ACK sang unknown nhưng chỉ kiểm retry với fixture submitted. Core đã có test chuyển trạng thái thật; đổi tên đúng hợp đồng sẽ rõ hơn. |
| Nhỏ | `packages/pi-adapter/test/pi-adapter.spec.ts:165–176,254` | Stub resolve khi abort nhưng không hủy timer 5 giây. Chưa đo được ảnh hưởng wall time; nên dọn timer/deferred ở boundary này. |

Audit là báo cáo; bước optimize không thay đổi assertions hoặc thêm product coverage ngoài logic chọn test mới. Không xóa test vì nghi trùng. Không nâng trạng thái conformance. Opt-in skip có lý do không tự nó là finding.

## Tối ưu đã áp dụng

1. `.github/workflows/ci.yml` và `tools/ci-test-scope.mjs`: chỉ bỏ các bước đắt tiền cho whitelist văn xuôi và manifest. Giữ trigger, tên job, matrix và secret scan; invariants luôn chạy. Code, JSON ví dụ, đường dẫn lạ, diff trống/hỗn hợp, base không tồn tại hoặc classifier lỗi đều chạy đầy đủ. PR xét merge checkout với base; Git diff tắt rename detection để xét cả đường dẫn cũ/mới. Workflow kiểm cả outcome và output, nên classifier thất bại không biến thành skip.
2. `apps/runtime/test/selector-budget-wiring.spec.ts`: clock `Date.now` kiểm soát được thay hai lần sleep 600 ms, vẫn giữ timer request thật. Focused trước: 1.263 ms; sau: 55 ms. Mutation giữ budget từ boot làm cả hai test fail với budget −350; khôi phục production nguyên byte và chạy lại pass.
3. `apps/runtime/test/bind-failure.spec.ts`: TCP listener thật trên cổng OS cấp thay runtime đầu tiên và vòng random-port retry. Runtime được kiểm thử vẫn chạy thật, giữ toàn bộ assertions. Chờ child close, đóng listener và xóa temp riêng. Focused trước 630 ms, sau 360–400 ms, giảm 36–43% trên mẫu nhỏ.
4. Thêm discovery `tools/test/**/*.spec.ts`; 18 test classifier gồm Git repo thật, rename code thành docs, diff hỗn hợp, base thiếu và tên có khoảng trắng. Không thêm dependency.

## Chi phí và lựa chọn không áp dụng

[CI baseline 35441693400](https://github.com/digitopvn/clarkcant/actions/runs/35441693400): verify Node 22.19 mất 107 giây, Node 24 mất 99 giây, secret scan 5 giây; tổng 211 runner-seconds, wall time khoảng 110 giây. Hai job dùng 80 giây test, 40 giây browser setup, 30 giây typecheck và 10 giây lint cộng lại.

Vì vậy diff đạt whitelist có thể bỏ khoảng **160 runner-seconds** ở bốn nhóm bước này, chưa trừ overhead fetch/classifier và chưa tính install/probe được bỏ. Đây là **ước lượng từ run cũ**, chưa phải số đo CI sau thay đổi hoặc hóa đơn GitHub. Chưa push hoặc tạo run mới.

Không chọn theo package: seams đi xuyên host-adapters, integration-sdk, execution-supervisor, MCP, voice và packs. Mọi diff có code giữ toàn bộ nhóm contracts/storage/core/security và runtime/browser-driver. Không shard E2E vì dùng chung server/data và một worker. Không gộp push/PR bằng SHA vì PR kiểm merge result khác push. Không bỏ matrix để tiết kiệm static checks khi chưa xác minh required gates.

Suite `submit-once` tốn khoảng 28 giây nhưng tái hiện request đã rời browser trước click timeout; giữ nguyên vì bảo vệ uncertain effects và duplicate submit. Không biến thành mock chỉ để giảm thời gian.

## Kiểm chứng và giới hạn

- Baseline tuần tự: 89 file, 1.144 pass, 7 skip, 76,55 giây.
- Sau sửa cùng một worker: 90 file, 1.162 pass, 7 skip, 70,25 giây. Hai JSON report giữ đủ 1.151 tên test cũ với trạng thái không đổi; đúng 18 test mới nằm ở classifier. Tổng giảm quan sát 6,29 giây (8,2%) nhưng chỉ là một cặp chạy, có ảnh hưởng cache/tải máy; savings fixture riêng đáng tin hơn để quy nguyên nhân.
- `pnpm verify`: invariants/typecheck/lint PASS; 90 file, 1.162 pass, 7 skip; thời gian Vitest mặc định 30,13 giây. Không so trực tiếp 30,13 với baseline một worker để quảng cáo savings.
- Focused classifier, budget và bind tests PASS; mutation budget FAIL như mong đợi rồi source được khôi phục.
- YAML parse và `git diff --check` PASS. `ak plan validate` ban đầu báo thiếu title front matter; đã sửa plan và chạy lại PASS, không sửa skill.
- Review toàn diff và review độc lập integration classifier không thấy regression trong thay đổi. Invariants được chạy lại sau cập nhật docs/manifest và PASS.
- Không đo line/branch coverage vì repo chưa cấu hình provider/threshold; không tuyên bố phần trăm coverage. Kiểm chứng bảo toàn bằng diff assertions, tập test và mutation cụ thể.
- Không chạy browser journeys hoặc provider live: không đổi UI/journey và chưa có yêu cầu tiêu quota provider. Browser-driver integration vẫn chạy trong Vitest. Không khởi chạy dev server; không giữ background process của task.

## Câu hỏi còn mở

Không có quyết định nào chặn tối ưu đã áp dụng. Sửa assertions live/ID, thêm CI E2E và bảo vệ lịch sử secret là các hạng mục follow-up riêng trong bảng audit.
