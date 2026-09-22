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
| `permission` | `PreToolUse` (Bash/Edit/Write/MultiEdit/NotebookEdit) | Việc này chạy không cần hỏi có an toàn không? | `p ≥ JEV_ALLOW_THRESHOLD` → tự allow; `p ≤ 0.2` → ép hỏi lại; ở giữa, hỏi thêm `destructive` để quyết allow hay ask (không còn bucket "unsure" im lặng) |
| `stop` | `Stop` | Claude dừng khi việc còn dang dở không? | `p ≥ 0.85` → chặn dừng kèm lý do. Ở [tự trị full](#4-tự-trị), còn tự trả lời thay nếu câu cuối hỏi xin phép |
| `bash` | `PostToolUse` (Bash) | success / error / tests_failed / needs_attention | Không phải `success` với `p ≥ 0.8` → gắn thêm một dòng ngữ cảnh cho Claude |
| `prompt` | `UserPromptSubmit` | Prompt có mập mờ không? (bỏ qua nếu dưới 12 ký tự hoặc bắt đầu bằng `/`) | Safe: cảnh báo hỏi lại người dùng nếu `p ≥ 0.85`. [Tự trị full](#4-tự-trị): không bao giờ hỏi — chạy theo nghĩa đen hoặc nêu giả định rồi làm luôn |

**Jev thấy gì.** Mỗi gate — và cả hook `AskUserQuestion` ở mục 1 — dựng
cùng một `state` có cấu trúc (`lib/context.mjs`), nhắm tới thứ một người
review cẩn thận thật sự nhìn vào, lấp theo đúng thứ tự ưu tiên này (4 mục
cuối bị bỏ trước nếu hết ngân sách):

1. `preferences` — CLAUDE.md (global, project root, project `.claude/`) và
   memory bền vững, **nguyên văn file, không bao giờ là mô tả Claude tự
   viết**. Xem "Bằng chứng, không mô tả" bên dưới.
2. `user_past_choices` — 30 lần gần nhất người dùng thực sự được hỏi và đã
   chọn gì (cùng project trước), across mọi phiên. Đo được là quan trọng:
   cùng một câu hỏi delegation, `merge_now=0.98` với đoạn "user preferences"
   do LLM viết, nhưng `clean_then_merge=1.00` — đúng cái người dùng chọn —
   khi đổi sang 7 lựa chọn thật của họ.
3. `task` — `current_task` (tin nhắn mới nhất) cộng 5 tin nhắn gần nhất làm
   nền.
4. `action` — đúng thứ đang được xét: lệnh, hoặc với Edit/Write/MultiEdit là
   nội dung `before`/`after` thật, không chỉ đường dẫn.
5. `plan_and_todos` — state `TodoWrite` mới nhất và/hoặc file plan tham
   chiếu dưới `~/.claude/plans/` (đường dẫn được resolve và kiểm tra nằm
   đúng trong thư mục đó trước khi đọc — không cho `../` đi lệch ra ngoài).
6. `session_summary` — nếu phiên đã qua `/compact`, bản tóm tắt đó nguyên
   văn, để Jev không mù trước cửa sổ hiện đang thấy.
7. `conversation` — các lượt gần nhất, mới nhất trước, lấp phần ngân sách
   còn lại sau 1–6.
8. `history` — 10 quyết định gần nhất của chính Jev trong phiên, để nhất
   quán.
9. `permissions` — pattern `allow`/`deny` từ `settings.json` — lệnh đã
   allow-list thì không bao giờ bị chấm risky.
10. `workspace` — branch, `git status`, `git diff --stat`, nội dung `git
    diff` thật (bị chặn, và bỏ hẳn hunk của file `.env*`/`*.pem`/`*.key`/
    `*secret*` dù đã được track), và danh sách file.
11. `env` — cwd, giờ hiện tại, platform.

**Bằng chứng, không mô tả.** Không có gì trong `state` là mô tả do Claude tự
viết về người dùng — không có kiểu văn xuôi "user thích X" viết ngay lúc
chạy. Mỗi field hoặc là lời người dùng tự viết (tin nhắn), file của chính họ
(CLAUDE.md, MEMORY.md), hoặc bản ghi họ thực sự đã chọn gì
(`user_past_choices`, từ hook `PostToolUse` trên `AskUserQuestion` ghi lại
mọi câu trả lời thật). Một test tĩnh ép luật này: không gate nào được xây
field `preferences`/`user_*` từ một chuỗi literal.

Tất cả bị chặn ở `JEV_STATE_CHARS` (mặc định `100000` — một state thật ~33
nghìn ký tự đo được khoảng 1.8s round-trip, và một state thật 90 nghìn ký tự
vẫn 200 sạch; gateway không công bố giới hạn nào nên đây là trần tự đặt có
biên an toàn, không phải bức tường đo được thật). Trần này ép trên kích
thước thật của `JSON.stringify(state).length` khi lấp từng phần theo đúng
thứ tự ưu tiên, không phải tổng kích thước riêng từng phần cộng lại — phần
nào không vừa thì bị cắt (giữ đầu, đánh dấu `…[truncated]`) hoặc bỏ hẳn nếu
hết sạch chỗ. Mỗi gate có ngân sách 4s (riêng phần trả lời `AskUserQuestion`
của `ask-jev.mjs` là 8s) — tự chia đôi thành 2 attempt ~1850ms để dù có retry
(xem bên dưới) cũng không vượt ngân sách — và timeout trong `hooks.json` của
mỗi hook đặt bằng `budget/1000 + 1s` margin nhân với số lần gọi tuần tự gate
đó có thể làm (6s cho gate chỉ gọi 1 lần, 16s cho `stop` gọi tối đa 3 lần,
10s cho `ask-jev.mjs`). State chậm hoặc quá khổ chỉ khiến gate "im lặng"
chứ không chặn bạn. Hạ `JEV_STATE_CHARS` nếu muốn gate nhanh hơn, đổi lại
ít ngữ cảnh hơn. Mỗi lần
gọi đều log kích thước từng phần bằng ký tự dưới dạng `state_sizes` — không
bao giờ log nội dung — để tinh chỉnh ngân sách từ `bin/jev.mjs stats` mà
không lộ gì.

Quy tắc fail-open giống mọi nơi khác: không có khoá API, gateway lỗi, hay
timeout đều khiến gate im lặng — không bao giờ chặn bạn.

## 4. Tự trị

`JEV_AUTONOMY` quyết định ask-jev tự làm thay bao nhiêu thay vì hỏi bạn —
**`full` là mặc định**; đặt `safe` để quay lại hành vi trước autonomy (Jev
chỉ bao giờ tự *trả lời* thay bạn, không bao giờ tự chạy tiếp qua một câu
hỏi hay một lần dừng).

Một guardrail không bao giờ tắt, ở cả hai mode: boolean `destructive` —
"việc này có phá huỷ hay để lộ thứ không thể hoàn tác không: xoá file ngoài
workspace, mất dữ liệu, force-push/viết lại lịch sử chung, publish/deploy/
trả tiền/gửi cho bên thứ ba, lộ secret" — và `p ≥ 0.6` luôn đưa quyết định
về tay bạn, dù full autonomy hay không.

Full thay đổi gì:

- **`AskUserQuestion`** — câu hỏi `personal` (có phải chuyện của bạn không)
  một mình không còn khiến fallback nữa; chỉ `destructive` mới. Câu Jev đủ
  chắc thì vẫn được trả lời kể cả khi đọc giống sở thích riêng, miễn không
  destructive.
- **Gate `prompt`** — prompt mập mờ không còn biến thành "hỏi người dùng"
  nữa. Thay vào đó Jev chấm nghĩa đen có chạy được không: được thì Claude
  chạy tiếp và nêu giả định trong một dòng; không thì Claude chọn cách hiểu
  hợp với yêu cầu gốc nhất, nêu giả định đó, rồi chạy tiếp. Đằng nào cũng
  không có câu hỏi nào tới tay bạn.
- **Gate `stop`** — nếu tin nhắn cuối của assistant kết bằng một câu hỏi xin
  phép ("bạn có muốn tôi…", "tôi có nên…"), Jev chấm việc gì nên xảy ra: trả
  lời được và không destructive → chặn dừng lại kèm đáp án của Jev và lệnh
  không hỏi lại; đã xong việc rồi → cho dừng; destructive hoặc thật sự là
  chuyện của bạn → cho dừng để câu hỏi thật sự tới tay bạn.
- **Gate `permission`** — ngưỡng allow là `JEV_ALLOW_THRESHOLD` (mặc định
  `0.8` ở `full`, `0.9` ở `safe`) thay vì cố định `0.9`.

Mọi quyết định tự trị vẫn được log với đúng dạng `label` + `confidence` +
`reason` như mọi nơi khác — không có gì ở đây là im lặng, chỉ là không còn
đi qua bạn nữa.

## Thống kê sử dụng

Mỗi lần gọi gateway và mỗi quyết định của hook được ghi thành một dòng JSON
vào `~/.claude/ask-jev.log` (đổi đường dẫn bằng `JEV_LOG_FILE`, tắt hẳn bằng
`JEV_LOG=0`). Mỗi dòng quyết định mang theo `gate` nào tạo ra nó (`ask`,
`permission`, `stop`, `bash`, `prompt`), đáp án của Jev dạng `label` +
`confidence`, và một `reason` ngắn — đúng phần tiêu chí Jev khớp — không bao
giờ ghi transcript hội thoại hay payload `state` gửi cho Jev.

Xem bằng:

```
node ~/.claude/plugins/marketplaces/ask-jev/bin/jev.mjs stats
```

```
Calls: 19 (ok 18, error 1)
Latency: avg 512ms, p95 910ms
Jev decided: 63.2%  Fell back to user: 15.8%  User overrides: 7

Decisions by outcome:
  answered               7  36.8%
  allow                  4  21.1%
  success                3  15.8%
  low_confidence         2  10.5%
  personal               1   5.3%
  ask                    1   5.3%
  tests_failed           1   5.3%

By gate:
  ask          calls   10  positive  70.0%  answered 7, low_confidence 2, personal 1
  permission   calls    5  positive  80.0%  allow 4, ask 1
  bash         calls    4  positive  75.0%  success 3, tests_failed 1

Recent decisions:
  2026-09-22T10:03:11.000Z  answered           Is this a bug or a feature?    bug (0.91)
  2026-09-22T10:02:47.000Z  allow              rm dist/old-build.js           safe (0.97)
```

Thu hẹp khoảng thời gian bằng `--last N` hoặc `--since 7d|24h`, thêm `--json` để lấy số liệu thô thay vì báo cáo dạng text.

`decisions.by_gate` chia đúng những con số đó theo từng gate — `{ total, positive, by_outcome }` — vì mỗi gate định nghĩa "positive" khác nhau (một quyết định `ask` mà Jev trả lời thẳng, một `permission` mà Jev tự allow, một lần chạy `bash` Jev chấm `success`, …). "Fell back to user" chỉ đếm đúng hai trường hợp câu hỏi/permission thực sự quay lại tay bạn: một câu `ask` không được trả lời, hoặc một `permission` gate ép phải hỏi. "User overrides" đếm sự kiện `user_choice` — mỗi câu trả lời thật bạn đưa cho `AskUserQuestion`, được một hook `PostToolUse` ghi lại và đưa ngược vào `user_past_choices` cho các quyết định sau.

**Lưu ý:** `${CLAUDE_PLUGIN_ROOT}` chỉ có sẵn bên trong hooks/skills của Claude Code; để gọi CLI từ terminal, dùng `~/.claude/plugins/marketplaces/ask-jev/bin/jev.mjs` hoặc alias `jev`.

### Trong Paseo

Repo này có sẵn `paseo.json` với hai workspace script: `jev:stats` (chạy báo
cáo ở trên) và `jev:log` (`tail -f` file log). Mở chúng từ panel scripts của
Paseo để xem số liệu sử dụng mà không cần rời khỏi app.

Muốn dashboard sống động hơn một script, cài [Paseo plugin](paseo-plugin/README.md)
— một workspace panel với ô số liệu, bộ lọc theo gate cạnh phân bố outcome, và
bảng quyết định cập nhật liên tục (Time, Gate, Outcome, Question/Subject,
Answer, Reason — chạm vào một dòng để mở rộng câu hỏi/reason bị cắt ngắn).
Settings → Plugins → dán vào ô "Plugin source" → Install:

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
| `JEV_STATE_CHARS` | `100000` | số ký tự ngữ cảnh tối đa gửi cho Jev mỗi lần gọi gate — hạ xuống để gate nhanh/rẻ hơn |
| `JEV_AUTONOMY` | `full` | [mode tự trị](#4-tự-trị); đặt `safe` để chỉ tự trả lời thay, không bao giờ tự chạy tiếp |
| `JEV_ALLOW_THRESHOLD` | `0.8` full / `0.9` safe | ngưỡng tự allow của gate `permission` |
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

### Evals

`skills/ask-jev` và các hook được kiểm bằng các case `claude plugin eval`
trong `evals/` — trigger evals (skill có chạy đúng lúc không, và im lặng
đúng lúc không), behaviour rubrics (evidence phải verbatim, không có bucket
`undetermined`, không tự bịa sở thích người dùng), và CLI contract cho
`bin/jev.mjs`. Chạy ở máy bằng:

```
./scripts/eval.sh --trust-plugin
```

Mỗi case sinh ra một agent Claude Code thật, nên cần `claude` đã đăng nhập
(hoặc `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN` trong environment). Job
`.github/workflows/evals.yml` chạy lại bộ eval mỗi tuần nếu có secret
`CLAUDE_CODE_OAUTH_TOKEN` hoặc `ANTHROPIC_API_KEY` trong repo, không có thì
bỏ qua gọn gàng — job này không bao giờ chặn CI của pull request.

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
