<p align="center"><img src="./assets/logo.jpg" alt="ask-jev logo" width="200"></p>

<h1 align="center">ask-jev</h1>

<p align="center">
  <img alt="version" src="https://img.shields.io/badge/version-0.2.0-2dd4bf?style=flat-square">
  <img alt="Claude Code plugin" src="https://img.shields.io/badge/Claude%20Code-plugin-1abc9c?style=flat-square">
  <a href="https://github.com/yanmad27/ask-jev/actions/workflows/ci.yml"><img alt="ci" src="https://github.com/yanmad27/ask-jev/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="dependencies" src="https://img.shields.io/badge/dependencies-none-2dd4bf?style=flat-square">
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D18-1abc9c?style=flat-square">
</p>

<p align="center"><a href="./README.md">English</a> · <strong>Tiếng Việt</strong></p>

**Hỏi [Jev](https://typesafe.ai) trước khi hỏi bạn.**

Claude Code hay dừng lại hỏi bạn (`AskUserQuestion`) cả những câu mà đáp án đã
nằm sẵn trong cuộc hội thoại. ask-jev chặn câu hỏi đó lại, đưa cho Jev — một
model nhỏ, nhanh, chuyên phán đoán thay vì trò chuyện, trả về xác suất thay vì
chữ — và tự trả lời khi đáp án rõ ràng suy ra được.

Câu nào thật sự thuộc về bạn thì vẫn tới tay bạn, y như cũ.

```
"Dùng thư viện nào để parse ngày?"     → tự chọn date-fns (1.00)   — đã có trong package.json
"Đóng gói thành plugin hay skill?"     → tự chọn Plugin  (0.95)
"Bạn muốn giao diện tông màu nào?"     → hỏi bạn                   — sở thích
"Có xoá luôn 3 environment cũ không?"  → hỏi bạn                   — không hoàn tác được
```

## Cài đặt

1. Thêm marketplace (một lần mỗi máy):

   ```
   /plugin marketplace add yanmad27/ask-jev
   ```

2. Cài plugin:

   ```
   /plugin install ask-jev@ask-jev
   ```

3. Đặt khoá Vercel AI Gateway (Jev nằm trong danh mục model của Vercel):

   ```bash
   echo 'vck_...' > ~/.claude/ask-jev.key && chmod 600 ~/.claude/ask-jev.key
   ```

   Đã có sẵn khoá gateway? Dùng biến môi trường `AI_GATEWAY_API_KEY` thay thế
   — không cần tạo file.

Vậy là xong. **Không đặt khoá →** plugin nằm im, Claude Code hỏi bạn như bình
thường. Không có gì bị ảnh hưởng.

## Nâng cấp

```
/plugin marketplace update ask-jev
/plugin update ask-jev@ask-jev
```

File khoá được đổi tên `jev-ask.key` → `ask-jev.key`; tên cũ vẫn được đọc như
phương án dự phòng, nên không cần chuyển gì cả. Khởi động lại Claude Code sau
khi nâng cấp — hook chỉ nạp lại khi vào phiên mới.

## 1. Tự trả lời `AskUserQuestion`

Trước khi Claude Code hiện câu hỏi cho bạn, ask-jev gửi câu đó cho Jev để
phán hai việc:

1. **Đây có phải chuyện của bạn không?** Sở thích, ưu tiên riêng, hay bất kỳ
   việc gì không hoàn tác được (xoá, gửi, publish, tốn tiền) — Jev không đụng
   vào, dù đáp án "đúng" có vẻ hiển nhiên đến đâu.
2. **Nếu không phải, phương án nào đúng** — dựa trên mọi thứ đã nói trong
   cuộc hội thoại?

Chỉ khi Jev vừa chắc chắn vừa xác định câu hỏi không phải chuyện riêng, Claude
mới nhận đáp án âm thầm rồi đi tiếp. Còn lại, câu hỏi tới tay bạn y hệt như
khi chưa cài ask-jev.

### Lựa chọn cần định nghĩa thật sự

Để Jev phán đoán được, mỗi lựa chọn cần một description **định nghĩa** nó —
không chỉ là cái nhãn. Lấy ví dụ "Đây có phải burger không?" với lựa chọn chỉ
ghi "Có": chẳng có gì để đối chiếu cả. "Có" cần một description kiểu *"Một
món ăn nóng: miếng thịt bằm nướng kẹp trong bánh mì tròn cắt đôi"* — thứ bạn
có thể cầm bằng chứng lên mà kiểm chứng được.

Thiếu description ở bất kỳ lựa chọn nào trong câu hỏi, ask-jev không gọi Jev
luôn — nó trả câu hỏi ngược lại cho Claude kèm hướng dẫn hỏi lại với định
nghĩa đầy đủ. Vòng đó không có gì tới tay bạn; Claude chỉ việc thử lại.

Bên dưới, mỗi lựa chọn được gửi dạng `{what, not_for}` — `not_for` nêu tên
các lựa chọn anh em mà nó không được trùng, để các định nghĩa loại trừ nhau
chứ không chỉ đứng cạnh nhau.

### Nhiều câu hỏi, và multiSelect

Nhiều câu hỏi trong cùng một lệnh `AskUserQuestion` được trả lời độc lập với
nhau. Câu nào Jev chắc thì dùng luôn; câu nào không thì trả lại cho bạn — lý
do đưa ngược cho Claude nêu tên các câu đã trả lời và nói chỉ hỏi lại những
câu còn thiếu, để một câu trả lời chắc chắn không bị bỏ đi chỉ vì câu bên
cạnh còn mập mờ.

Câu hỏi `multiSelect` cũng qua Jev: mỗi lựa chọn thành một câu hỏi có/không
riêng ("lựa chọn này có áp dụng không?") thay vì một câu chọn duy nhất. Một
lựa chọn được chọn khi xác suất vượt `JEV_ASK_THRESHOLD`, bị loại khi xuống
dưới `1 - JEV_ASK_THRESHOLD`, còn cả câu hỏi vẫn chưa giải quyết nếu có lựa
chọn nằm lửng lơ ở giữa. Đáp án đã giải quyết là danh sách nhãn được chọn nối
bằng dấu phẩy — có thể là "none".

### Khi nào nó im lặng

| Điều kiện | Vì sao |
|---|---|
| câu hỏi là chuyện riêng (`personal > 0.5`) | quyền của bạn, không phải của model |
| Jev không đủ chắc (`< JEV_ASK_THRESHOLD`) | đoán mò thì thà hỏi còn hơn |
| có lựa chọn thiếu description | nhãn trần không phải thứ Jev phán đoán được — trả về cho Claude, không đưa cho Jev |
| transcript không có ngữ cảnh dùng được | không có gì cho Jev chấm |
| không có khoá, Jev lỗi, hoặc quá 8 giây | một helper hỏng không bao giờ được phép là lý do bạn không trả lời được |

## 2. Hỏi Jev trước khi tự quyết

Một hook `SessionStart` nhắc luôn quy tắc hỏi Jev trước mọi quyết định —
phân loại, chọn giữa các phương án cố định, có/không dựa trên bằng chứng,
xếp hạng — chứ không chỉ khi `AskUserQuestion` được gọi. Hai hook chạy ở mỗi
đầu phiên: `self-register.mjs`, vá bug của Claude Code khiến `PreToolUse`
hook khai trong plugin không chạy (xem Ghi chú triển khai), và
`session-start.mjs`, tiêm luật vào. Cả hai đều im lặng nếu chưa có khoá API.

Nhắc một lần đầu phiên rất dễ bị quên sau vài chục lượt, nên gate `prompt`
(bên dưới) tiêm lại đúng một dòng luật đó ở **mỗi** lượt qua hook
`UserPromptSubmit`. Đặt `JEV_REMIND=0` để tắt (ví dụ thấy lặp lại phiền); nó
cũng tự im lặng nếu chưa có khoá API.

Không chỉ tự trả lời `AskUserQuestion`, Claude còn có thể hỏi Jev cho *bất kỳ*
quyết định nào — phân loại, chọn phương án, có/không, chấm điểm — qua skill và
CLI đi kèm:

```
echo '{"state": ..., "questions": ...}' | node ~/.claude/plugins/marketplaces/ask-jev/bin/jev.mjs
```

Để tiện lợi, thêm vào shell profile của bạn:
```
alias jev='node ~/.claude/plugins/marketplaces/ask-jev/bin/jev.mjs'
```
Rồi dùng `jev` trực tiếp từ bất kỳ terminal nào.

Request:

```json
{
  "state": { "item": "Two beef patties, cheese, and pickles between a sesame bun." },
  "questions": {
    "isHamburger": {
      "type": "boolean",
      "instructions": { "question": "Does `item` match the definition of a hamburger?", "focus": "Judge the food itself, not what it's called." },
      "criteria": {
        "true": "A hot sandwich: a cooked ground-meat patty inside a sliced bun",
        "false": "Anything else — a cold sandwich, a non-ground protein, no bun, or not a sandwich at all"
      }
    }
  }
}
```

Response:

```json
{ "isHamburger": { "probability": 0.97, "confidence": 0.95 } }
```

Skill (`skills/ask-jev/SKILL.md`) giải thích thế nào là một request tốt —
bằng chứng dán nguyên vào `state`, mỗi câu hỏi một quyết định, tiêu chí quan
sát được và loại trừ lẫn nhau — kèm ví dụ cụ thể.

## 3. Cổng tự động

Ngoài tự trả lời `AskUserQuestion`, bốn hook chủ động hỏi Jev đúng lúc một
người review thật sẽ lên tiếng — Claude không cần tự nhận ra đây là một
quyết định cần hỏi. Cả bốn bật sẵn, tắt riêng từng cái bằng `JEV_GATES`
(danh sách phẩy; `JEV_GATES=` tắt hết).

| Gate | Chạy lúc | Jev phán | Kết quả |
|---|---|---|---|
| `permission` | `PreToolUse` (Bash/Edit/Write/MultiEdit/NotebookEdit) | Việc này chạy không cần hỏi có an toàn không? | `p ≥ 0.9` → tự allow; `p ≤ 0.2` → ép hỏi lại; còn lại giữ nguyên |
| `stop` | `Stop` | Claude dừng khi việc còn dang dở không? | `p ≥ 0.85` → chặn dừng kèm lý do; chặn lặp lại thì bị hãm 30s để tránh vòng lặp |
| `bash` | `PostToolUse` (Bash) | success / error / tests_failed / needs_attention | Không phải `success` với `p ≥ 0.8` → gắn thêm một dòng ngữ cảnh cho Claude |
| `prompt` | `UserPromptSubmit` | Prompt có mập mờ không? (bỏ qua nếu dưới 12 ký tự hoặc bắt đầu bằng `/`) | Thêm dòng nhắc "hỏi Jev", cộng một dòng cảnh báo mập mờ nếu `p ≥ 0.85` |

**Jev thấy gì.** Mỗi gate — và cả hook `AskUserQuestion` ở mục 1 — dựng
cùng một `state` có cấu trúc (`lib/context.mjs`), nhắm tới thứ một người
review thật sự nhìn vào:

- `task`: tin nhắn đầu tiên của phiên (yêu cầu gốc) và tin nhắn mới nhất,
  nguyên văn.
- `conversation`: các lượt trong phiên, mới nhất trước, kèm tên tool đã
  dùng và tóm tắt ngắn kết quả mỗi tool trả về.
- `workspace`: branch git hiện tại, `git status --short`, `git diff --stat`.
- `action`: phần riêng của từng gate — lệnh/sửa đổi đang định chạy, output
  Bash đang được phân loại, hoặc tin nhắn cuối của assistant.

Tất cả bị chặn ở `JEV_STATE_CHARS` (mặc định `60000`; docs của Jev không nêu
giới hạn nào nên đây là trần tự đặt), lấp theo thứ tự ưu tiên ở trên —
`task` trước, rồi lấp `conversation` bằng phần còn lại. Một state thật ~33
nghìn ký tự đo được khoảng 1.8s round-trip; mỗi gate tự timeout 4s (8s ở mức
hook), nên state chậm hoặc quá khổ chỉ khiến gate "im lặng" chứ không chặn
bạn. Hạ `JEV_STATE_CHARS` nếu muốn gate nhanh hơn, đổi lại ít ngữ cảnh hơn.

Quy tắc fail-open giống mọi nơi khác: không có khoá API, gateway lỗi, hay
timeout đều khiến gate im lặng — không bao giờ chặn bạn.

## Thống kê sử dụng

Mỗi lần gọi gateway và mỗi quyết định của hook được ghi thành một dòng JSON
vào `~/.claude/ask-jev.log` (đổi đường dẫn bằng `JEV_LOG_FILE`, tắt hẳn bằng
`JEV_LOG=0`). Chỉ ghi nội dung câu hỏi và nhãn các lựa chọn — không bao giờ
ghi transcript hội thoại hay payload `state` gửi cho Jev.

Xem bằng:

```
node ~/.claude/plugins/marketplaces/ask-jev/bin/jev.mjs stats
```

```
Calls: 12 (ok 11, error 1)
Latency: avg 412ms, p95 780ms

Decisions by outcome:
  answered              7  58.3%
  low_confidence         3  25.0%
  personal               2  16.7%

Recent decisions:
  2026-09-22T10:03:11.000Z  answered           Is this a bug or a feature?    bug (0.91)
```

Thu hẹp khoảng thời gian bằng `--last N` hoặc `--since 7d|24h`, thêm `--json` để lấy số liệu thô thay vì báo cáo dạng text.

**Lưu ý:** `${CLAUDE_PLUGIN_ROOT}` chỉ có sẵn bên trong hooks/skills của Claude Code; để gọi CLI từ terminal, dùng `~/.claude/plugins/marketplaces/ask-jev/bin/jev.mjs` hoặc alias `jev`.

### Trong Paseo

Repo này có sẵn `paseo.json` với hai workspace script: `jev:stats` (chạy báo
cáo ở trên) và `jev:log` (`tail -f` file log). Mở chúng từ panel scripts của
Paseo để xem số liệu sử dụng mà không cần rời khỏi app.

Muốn dashboard sống động hơn một script, cài [Paseo plugin](paseo-plugin/README.md)
— một workspace panel với ô số liệu, phân bố outcome, và bảng quyết định cập
nhật liên tục. Settings → Plugins → dán vào ô "Plugin source" → Install:

```
github:yanmad27/ask-jev:paseo-plugin
```

## Cấu hình

Tất cả đều tuỳ chọn — mặc định đã hợp lý sẵn.

| Biến | Mặc định | |
|---|---|---|
| `AI_GATEWAY_API_KEY` | đọc `~/.claude/ask-jev.key` | khoá Vercel AI Gateway của bạn |
| `JEV_ASK_THRESHOLD` | `0.8` | hạ xuống để Jev tự trả lời nhiều hơn (và cũng sai nhiều hơn) |
| `JEV_REMIND` | (bật) | đặt `0` để tắt lời nhắc "hỏi Jev" mỗi lượt |
| `JEV_GATES` | `permission,stop,bash,prompt` | danh sách phẩy các [cổng tự động](#3-cổng-tự-động) đang bật; rỗng thì tắt hết |
| `JEV_STATE_CHARS` | `60000` | số ký tự ngữ cảnh tối đa gửi cho Jev mỗi lần gọi gate — hạ xuống để gate nhanh/rẻ hơn |
| `JEV_MODEL` | `typesafe-ai/jev` | model nào Jev dùng để đánh giá |
| `JEV_GATEWAY_URL` | endpoint đánh giá của Vercel | chỉ cần đổi nếu dùng gateway riêng |

File khoá cũ `~/.claude/jev-ask.key` (từ trước khi plugin đổi tên) vẫn được
đọc như phương án dự phòng, nên không có gì hỏng nếu bạn từng đặt theo tên cũ.

## Đóng góp / Sửa plugin

Đang phát triển plugin trên máy? Trỏ marketplace vào thư mục làm việc thay vì
GitHub, để sửa xong là chạy luôn, không phải push rồi update:

```
/plugin marketplace add ~/workspace/ask-jev
```

Commit theo [Conventional Commits](https://www.conventionalcommits.org)
(`feat:`/`fix:`/`docs:`…) — release-please tự mở PR release, tự tăng version
trong `plugin.json` và gắn tag khi merge, không cần tag tay.

## Ghi chú triển khai

<details>
<summary>Hook thực sự chặn câu hỏi kiểu gì, và vì sao lại có thêm một hook bạn không bao giờ tự gọi</summary>

<br>

**Không phụ thuộc npm.** Chỉ dùng `fetch` và `fs` của Node, gọi thẳng endpoint
đánh giá của gateway. Clone về là chạy — không cần `npm install`, không có
`node_modules`.

**"Trả lời thay bạn" thực chất là một lần từ chối.** Claude Code không cho
hook trả về tool result giả. Nhưng `PreToolUse` hook trả về
`permissionDecision: "deny"` thì `permissionDecisionReason` được đưa thẳng
ngược vào model — nên "đáp án" của ask-jev thực chất là *chặn câu hỏi lại và
nói cho Claude biết đáp án*. Trong phiên bạn sẽ thấy một dòng
`Jev answered: ...` rồi Claude đi tiếp như thể chính bạn vừa gõ đáp án đó.

**Vì sao có thêm hook `SessionStart`.** Claude Code hiện không chạy
`PreToolUse` hook khai trong plugin
([anthropics/claude-code#36397](https://github.com/anthropics/claude-code/issues/36397))
— chỉ `SessionStart` từ plugin là chạy được. Nên `hooks/self-register.mjs`
chạy mỗi `SessionStart`, tự ghi entry `PreToolUse` thẳng vào
`~/.claude/settings.json` của bạn — nơi hook vẫn chạy bình thường — và tự cập
nhật lại đường dẫn mỗi khi plugin lên bản mới. Nó chỉ đụng đúng entry của
mình, phần còn lại của `settings.json` giữ nguyên. Khi nào upstream sửa xong
thì entry này thừa nhưng vô hại — tốn nhiều lắm là thêm một lần gọi gateway.

**Ngữ cảnh** lấy từ 12 lượt gần nhất của transcript phiên (bỏ lượt subagent
và lượt máy sinh), cắt còn 6000 ký tự. Mỗi câu hỏi tốn khoảng $0.00002 và mất
chừng 0.7 giây.

</details>
