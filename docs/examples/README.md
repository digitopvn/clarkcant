# Contract examples — synthetic only

Những JSON này minh họa contract đề xuất trong blueprint v2. IDs, accounts, nodes và dữ liệu đều giả lập; `example.invalid` không là nguồn package có thể cài. Không có API keys, OAuth tokens hoặc executable app implementation.

- `calendar-widget.json`: agent chọn props và actions từ capability đã discover.
- `note-pack.json`: package UI do user tự viết, không cần cấp network/filesystem.
- `install-plan.json`: consent ràng buộc source/version/node/grants và continuation.
- `onboarding-recipe.json`: một flow hướng mục tiêu, checkpoints và probes.
- `peer-delegation.json`: bounded delegation giữa các node đã pair.

JSON syntax được kiểm tra khi tạo tài liệu. Đây không phải tuyên bố runtime đã thực thi hoặc schema SDK đã được implement. Types/schema chính thức cần tạo ở P1 và trace về tài liệu.
