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

3. Cấp cho nó một Vercel AI Gateway key (Jev nằm trong danh mục model của Vercel):

   ```bash
   echo 'vck_...' > ~/.claude/ask-jev.key && chmod 600 ~/.claude/ask-jev.key
   ```

   Đã có sẵn gateway key? Đặt biến môi trường `AI_GATEWAY_API_KEY` thay vào —
   không cần tạo file.

Vậy là xong. **Chưa đặt key →** plugin lặng lẽ không làm gì và Claude Code
vẫn hỏi bạn y hệt như trước giờ. Không có gì để hỏng cả.

## Bạn sẽ thấy gì

Khi Jev trả lời một câu hỏi thay bạn, nó hiện lên như một dòng duy nhất
trong session — `✓ Jev answered for you: ...` — rồi Claude tiếp tục làm như thể chính
bạn vừa gõ câu trả lời đó. Mọi thứ khác (câu hỏi thuộc về bạn, hoặc Jev
không chắc chắn) vẫn tới tay bạn như bình thường.

## Cách hoạt động

Bốn lớp xếp chồng lên nhau:

1. **[Tự trả lời `AskUserQuestion`](#1-tự-trả-lời-askuserquestion)** — tính
   năng cốt lõi ở trên.
2. **[Hỏi Jev trước khi phán đoán](#2-hỏi-jev-trước-khi-phán-đoán)** —
   Claude được nhắc hỏi Jev cho *mọi* phán đoán, không chỉ
   `AskUserQuestion`, qua một skill và CLI đi kèm.
3. **[Các gate tự động](#3-các-gate-tự-động)** — bốn hook chủ động hỏi Jev
   đúng những lúc một reviewer con người sẽ lên tiếng: lệnh này có an toàn
   không, assistant có dừng quá sớm không, lệnh có chạy thành công không,
   prompt có mơ hồ không.
4. **[Autonomy](#4-autonomy)** — ask-jev tự hành động thay vì hỏi bạn tới
   mức nào, với một lằn ranh không bao giờ tắt: bất cứ gì có tính phá huỷ
   luôn được đưa về cho bạn quyết.

### 1. Tự trả lời `AskUserQuestion`

Trước khi Claude Code hiện câu hỏi cho bạn, ask-jev gửi nó cho Jev để phán
đoán hai việc:

1. **Đây có phải là việc của bạn để quyết không?** Sở thích, ưu tiên riêng
   tư, hay bất cứ điều gì không thể hoàn tác (xoá, gửi, publish, tiêu tiền)
   — Jev từ chối đụng vào, dù đáp án "đúng" có vẻ hiển nhiên tới đâu.
2. **Nếu không, đáp án nào đúng** — dựa trên mọi thứ đã nói trong cuộc
   hội thoại tới giờ?

Chỉ khi Jev vừa tự tin vừa chắc chắn câu hỏi không mang tính cá nhân, Claude
mới nhận được đáp án một cách âm thầm và tiếp tục. Ngược lại, câu hỏi vẫn
tới tay bạn y như khi chưa cài ask-jev.

**Trong [Paseo](#trong-paseo), hook này đứng im.** Paseo biến `AskUserQuestion`
thành một câu hỏi native mà bạn trả lời ngay trong app, và hook của Claude Code
chỉ có thể "trả lời" bằng cách deny tool — Paseo hiển thị thành khối lỗi đỏ
`hook error` dù đáp án của Jev vẫn tới model. Nên trong Paseo (nhận biết qua
`PASEO_AGENT_ID`) hook tự-trả-lời đứng im: mọi câu hỏi tới tay bạn như bình
thường. Việc hỏi Jev trực tiếp cho các phán đoán (bên dưới) chạy qua CLI nên
vẫn hoạt động ở mọi nơi; panel thống kê vẫn ghi nhận.

<details>
<summary>Option cần định nghĩa thật sự, multiSelect, và khi nào nó im lặng</summary>

**Option cần định nghĩa thật sự.** Để Jev phán đoán được, mỗi option cần một
mô tả **định nghĩa** nó thật sự — chứ không chỉ là một cái nhãn. Lấy ví dụ
"Đây có phải hamburger không?" với option chỉ ghi "Có": chẳng có gì để đối
chiếu cả. "Có" cần một mô tả kiểu *"Một loại sandwich nóng: một miếng thịt
bằm nấu chín kẹp trong bánh mì tròn cắt đôi"* — thứ mà bạn có thể đem bằng
chứng ra đối chiếu và kiểm chứng được.

Nếu bất kỳ option nào trong câu hỏi thiếu mô tả, ask-jev không gọi Jev luôn
— nó trả câu hỏi thẳng về cho Claude kèm hướng dẫn hỏi lại với định nghĩa
đầy đủ. Không có gì tới tay bạn trong lượt đó; Claude chỉ đơn giản thử lại.

Bên dưới, mỗi option được gửi dưới dạng `{what, not_for}` — `not_for` nêu
tên những option anh em mà nó không được trùng lặp, để các định nghĩa loại
trừ lẫn nhau thay vì chỉ nằm cạnh nhau.

**Nhiều câu hỏi, và multiSelect.** Nhiều câu hỏi trong cùng một lời gọi
`AskUserQuestion` được trả lời độc lập với nhau. Câu nào Jev tự tin thì được
dùng; số còn lại được trả về cho bạn — lý do Claude nhận lại nêu tên các đáp
án đã giải quyết và nói chỉ hỏi lại phần còn thiếu, để một đáp án tự tin
không bao giờ bị bỏ chỉ vì một câu hỏi anh em còn mơ hồ.

Câu hỏi `multiSelect` cũng đi qua Jev: mỗi option trở thành một câu hỏi
yes/no riêng ("option này có áp dụng không?") thay vì chọn một. Một option
được tính là chọn khi xác suất vượt `ASK_JEV_ASK_THRESHOLD`, bị loại khi rơi
dưới `1 - ASK_JEV_ASK_THRESHOLD`, và cả câu hỏi vẫn chưa giải quyết nếu có
option nào rơi vào khoảng giữa. Đáp án đã giải quyết là danh sách nhãn được
chọn, nối bằng dấu phẩy — có thể là "none".

**Khi nào nó im lặng.**

| Điều kiện | Vì sao |
|---|---|
| câu hỏi mang tính cá nhân (`personal > 0.5`) | đó là việc của bạn, không phải của model |
| Jev không đủ tự tin (`< ASK_JEV_ASK_THRESHOLD`) | đoán bừa còn tệ hơn hỏi |
| một option thiếu mô tả | nhãn trơn thì Jev không phán đoán được — trả về cho Claude, không chuyển cho Jev |
| không có ngữ cảnh dùng được trong transcript | không có gì để Jev đối chiếu |
| chưa đặt key, Jev lỗi, hoặc mất hơn 8s | một helper hỏng không bao giờ được là lý do bạn không trả lời được |

</details>

### 2. Hỏi Jev trước khi phán đoán

Một hook `SessionStart` chèn một quy tắc ngắn nhắc Claude hỏi Jev trước bất
kỳ phán đoán nào — phân loại, chọn giữa các lựa chọn cố định, yes/no dựa
trên bằng chứng, xếp hạng — không chỉ khi `AskUserQuestion` được gọi. Hai
hook chạy ở mỗi lần bắt đầu session: `self-register.mjs`, dùng để lách một
lỗi của Claude Code khiến hook `PreToolUse` của plugin không chạy được (xem
[Ghi chú triển khai](#ghi-chú-triển-khai)), và `session-start.mjs`, chèn
quy tắc đó. Cả hai đều im lặng nếu chưa cấu hình API key.

Vì một lời nhắc lúc đầu session dễ bị quên sau chục lượt trò chuyện, gate
`prompt` (bên dưới) chèn lại đúng quy tắc một dòng đó ở **mỗi** lượt qua
hook `UserPromptSubmit`. Đặt `ASK_JEV_REMIND=0` để tắt (ví dụ nếu bạn thấy
lặp lại quá); nó vốn đã im lặng khi chưa cấu hình API key.

Ngoài việc tự trả lời `AskUserQuestion`, Claude còn có thể hỏi Jev cho *bất
kỳ* phán đoán nào — phân loại, chọn giữa các lựa chọn, trả lời yes/no, chấm
điểm theo thang — qua skill và CLI đi kèm:

```
echo '{"state": ..., "questions": ...}' | node ~/.claude/plugins/marketplaces/ask-jev/bin/jev.mjs
```

Để tiện dùng, thêm vào shell profile của bạn:
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

Skill (`skills/ask-jev/SKILL.md`) giải thích một request tốt trông ra sao —
bằng chứng dán nguyên văn vào `state`, một phán đoán cho mỗi câu hỏi, tiêu
chí quan sát được và loại trừ lẫn nhau — kèm ví dụ minh hoạ.

### 3. Các gate tự động

Ngoài việc tự trả lời `AskUserQuestion`, bốn hook chủ động hỏi Jev đúng
những lúc một reviewer con người sẽ thật sự lên tiếng — không cần Claude
gọi phán đoán tường minh. Mỗi gate bật mặc định và có thể tắt riêng bằng
`ASK_JEV_GATES` (danh sách phân tách bởi dấu phẩy; `ASK_JEV_GATES=` tắt cả bốn).

| Gate | Chạy khi | Jev phán đoán | Hiệu ứng |
|---|---|---|---|
| `permission` | `PreToolUse` (mọi tool — matcher `*`) | Chạy cái này mà không hỏi có an toàn không? | Một allowlist chỉ-đọc tĩnh (`Read`, `Grep`, `Glob`, `LS`, `WebSearch`, `WebFetch`, các lời gọi MCP dạng `list_`/`get_`/`read_`/`search_`/`inspect_`/`capture_`, …) tự động cho phép với **zero lời gọi mạng**. Mọi thứ khác hỏi Jev cả `safe` lẫn `destructive` cùng lúc: `p(destructive) ≥ 0.6` luôn buộc phải hỏi; ngược lại `p(safe) ≥ ASK_JEV_ALLOW_THRESHOLD` và `p(destructive) < 0.3` → tự cho phép; còn lại thì hỏi (không có nhóm "không chắc" âm thầm nào). Ở [autonomy full](#4-autonomy), bất cứ gì Jev đánh giá không phá huỷ (`< 0.3`) đều được tiếp tục dù `safe` không đạt ngưỡng; `0.3–0.6` hỏi; `≥ 0.6` luôn hỏi |
| `stop` | `Stop` | Assistant có dừng lại trong khi việc còn dang dở không? | `p ≥ 0.85` → chặn lại kèm lý do. Ở [autonomy full](#4-autonomy), còn tự giải quyết luôn câu "nên…?" còn treo thay cho người dùng |
| `bash` | `PostToolUse` (Bash) | success / error / tests_failed / needs_attention | Kết quả khác `success` với `p ≥ 0.8` sẽ thêm một dòng ngữ cảnh cho Claude |
| `prompt` | `UserPromptSubmit` | Prompt có mơ hồ không? (bỏ qua nếu dưới 12 ký tự hoặc bắt đầu bằng `/`) | Chế độ safe: cảnh báo nên hỏi lại người dùng ở `p ≥ 0.85`. [Autonomy full](#4-autonomy): không bao giờ hỏi — tiến hành theo cách hiểu nghĩa đen hoặc nêu rõ giả định |

Đường tắt chỉ-đọc và tiêu chí `destructive` nằm ở `lib/gate.mjs`, dùng chung
giữa hook `permission` và `bin/jev-eval.mjs`, để việc replay dùng đúng luật
mà một quyết định thật sự sẽ dùng. `AskUserQuestion` không đi qua gate này —
nó có hook riêng (mục 1).

<details>
<summary>Thế nào là "phá huỷ" (và thế nào là không)</summary>

**Thế nào là phá huỷ.** Mất mát hoặc lộ thông tin không thể hoàn tác — không
undo được, không lấy lại được dữ liệu hay lòng tin:

- Xoá hoặc ghi đè một file nằm ngoài cả workspace lẫn các thư mục scratch
  (`/tmp`, `$TMPDIR`, `~/.cache`, `~/.paseo/worktrees`, git worktree), hoặc
  `rm -rf` trên đường dẫn không phải scratch
- `git push --force`/`--force-with-lease`, viết lại lịch sử dùng chung, hoặc
  push thẳng vào `main`/`master`/nhánh được bảo vệ khác
- Xoá một remote branch hoặc tag
- `npm publish`/`paseo plugin install` từ nguồn không đáng tin, deploy, trả
  tiền, hoặc email/nhắn tin cho bên thứ ba
- In ra hoặc làm lộ một secret hay key, hoặc drop một database
- Sửa `~/.ssh`, `~/.claude/settings*.json`, hoặc file rc của shell

Có thể hoàn tác, nên **không** phải phá huỷ:

- Ghi trong workspace hoặc thư mục scratch (`/tmp`, `$TMPDIR`, `~/.cache`,
  `~/.paseo/worktrees`, git worktree, `~/.claude/plans/`,
  `~/.claude/projects/*/memory/`, `~/.claude/todos/`)
- `git commit`/`branch`/`checkout`/`merge`/`rebase` trên nhánh local
- `git push` lên một feature branch
- `gh pr create`/`edit`/`checks`/`merge --squash` (merge chỉ thật sự xảy ra
  khi CI và branch protection cho phép)
- Đọc hoặc network GET
- Vòng lặp `sleep`/polling

</details>

<details>
<summary>Jev được cho xem gì (thứ tự ưu tiên của <code>state</code>)</summary>

Mọi gate — và hook `AskUserQuestion` ở mục 1 — đều dựng cùng một `state` có
cấu trúc (`lib/context.mjs`), nhắm tới những gì một reviewer con người cẩn
thận thật sự sẽ xem, điền theo thứ tự ưu tiên sau (bốn mục thấp nhất bị bỏ
trước nếu hết ngân sách):

1. `preferences` — CLAUDE.md (global, project root, project `.claude/`) và
   memory bền vững, **nguyên văn nội dung file** — không bao giờ là mô tả
   Claude tự viết về người dùng. Xem "Bằng chứng, không phải mô tả cảm
   tính" bên dưới.
2. `user_past_choices` — 30 lần gần nhất người dùng thật sự được hỏi và đã
   chọn gì (ưu tiên cùng project trước), trên mọi session. Đã đo được là có
   ý nghĩa: cùng một câu hỏi về delegation cho điểm `merge_now=0.98` với một
   đoạn "user preferences" do LLM viết, nhưng `clean_then_merge=1.00` —
   option người dùng thật sự chọn — khi cho xem 7 lựa chọn thật của họ thay
   vào đó.
3. `task` — `current_task` (tin nhắn mới nhất của người dùng) cộng 5 tin
   nhắn gần nhất để lấy bối cảnh.
4. `action` — chính xác điều đang được phán đoán: câu lệnh, hoặc với
   Edit/Write/MultiEdit là nội dung `before`/`after` thật, không chỉ đường
   dẫn.
5. `plan_and_todos` — trạng thái `TodoWrite` mới nhất và/hoặc một file plan
   được tham chiếu dưới `~/.claude/plans/` (đường dẫn được resolve và kiểm
   tra nằm trong thư mục đó trước khi đọc — không cho `../` traversal).
6. `session_summary` — nếu session đã qua `/compact`, bản tóm tắt đó nguyên
   văn, để Jev không mù trước mọi thứ trước cửa sổ hiển thị.
7. `conversation` — các lượt gần đây, mới nhất trước, lấp đầy phần ngân
   sách còn lại sau mục 1–6.
8. `history` — 10 quyết định gần nhất của chính Jev trong session, để giữ
   nhất quán.
9. `permissions` — pattern `allow`/`deny` từ `settings.json` — một lệnh đã
   nằm trong allowlist không bao giờ bị đánh giá là rủi ro.
10. `workspace` — branch, `git status`, `git diff --stat`, nội dung
    `git diff` thật (có giới hạn, hunk của các file
    `.env*`/`*.pem`/`*.key`/`*secret*` bị bỏ dù có track), và danh sách file.
11. `env` — cwd, thời gian hiện tại, platform.

**Bằng chứng, không phải mô tả cảm tính.** Không có gì trong `state` là mô
tả Claude tự viết về người dùng — không có đoạn "user prefers X" viết ngay
tại chỗ. Mỗi field đều là lời của chính người dùng (tin nhắn), file của
chính họ (CLAUDE.md, MEMORY.md), hoặc bản ghi những gì họ thật sự chọn
(`user_past_choices`, từ một hook `PostToolUse` trên `AskUserQuestion` ghi
lại mọi câu trả lời thật). Một test tĩnh áp đặt điều này: không gate nào
được phép dựng field `preferences`/`user_*` từ một chuỗi literal.

Toàn bộ bị giới hạn ở `ASK_JEV_STATE_CHARS` (mặc định `100000` — một state
thật ~33k ký tự đo được round-trip ~1.8s và một state thật 90k ký tự vẫn
nhận 200 sạch; gateway không công bố giới hạn nào, nên đây là trần tự đặt
có biên độ dư, không phải một bức tường đã đo). Giới hạn được áp trên độ
dài `JSON.stringify(state).length` thật sự khi các phần được thêm vào theo
thứ tự ưu tiên, không phải tổng kích thước nội bộ của từng phần — một phần
không vừa sẽ bị cắt (giữ phần đầu, đánh dấu `…[truncated]`) hoặc bỏ hẳn nếu
không còn chỗ. Mỗi lời gọi gate được cấp ngân sách 4s (việc trả lời
`AskUserQuestion` của `ask-jev.mjs` được cấp 8s) — chia nội bộ thành hai lần
thử ~1850ms để một lần retry không bao giờ vượt ngân sách — và timeout
trong `hooks.json` cho mỗi hook được đặt là `budget/1000 + 1s` biên độ nhân
với số lời gọi tuần tự mà một gate có thể thực hiện (6s cho các gate gọi một
lần, 16s cho tối đa ba lần của `stop`, 10s cho `ask-jev.mjs`). Một state
chậm hoặc quá khổ sẽ suy biến thành "không phát ra gì" thay vì chặn bạn lại.
Giảm `ASK_JEV_STATE_CHARS` nếu bạn muốn gate nhanh hơn, đánh đổi bằng ít
ngữ cảnh hơn. Mỗi lời gọi ghi log kích thước theo ký tự của từng phần dưới
dạng `state_sizes` — không bao giờ ghi nội dung — để ngân sách có thể tinh
chỉnh từ `bin/jev.mjs stats` mà không lộ gì cả.

Cùng nguyên tắc fail-open như mọi nơi khác: không có API key, gateway lỗi,
hoặc timeout đều khiến gate im lặng — không bao giờ là một điểm chặn.

</details>

### 4. Autonomy

`ASK_JEV_AUTONOMY` kiểm soát mức độ ask-jev tự hành động thay vì hỏi bạn —
**`full` là mặc định**; đặt thành `safe` để quay về hành vi trước khi có
autonomy (Jev chỉ bao giờ tự *trả lời* thay bạn, không bao giờ tự tiến hành
qua một câu hỏi hay một lần dừng).

Một lằn ranh không bao giờ tắt, dù ở chế độ nào: một boolean `destructive` —
xem ["thế nào là phá huỷ"](#3-các-gate-tự-động) — và `p ≥ 0.6` luôn đưa
quyết định về cho bạn.

Những gì thay đổi ở `full`:

- **`AskUserQuestion`** — kiểm tra `personal` (đây có phải việc của người
  dùng không?) không còn tự nó gây fallback; chỉ `destructive` mới gây. Một
  câu hỏi Jev tự tin vẫn được trả lời dù nó đọc như sở thích cá nhân, miễn
  là không phá huỷ.
- **gate `prompt`** — một prompt mơ hồ không bao giờ biến thành "hỏi người
  dùng" nữa. Thay vào đó Jev phán đoán xem cách hiểu nghĩa đen có khả thi
  không: nếu có, Claude tiến hành và nêu rõ giả định trong một dòng; nếu
  không, Claude chọn cách hiểu nhất quán nhất với task ban đầu, nêu rõ giả
  định đó, và tiến hành. Dù theo cách nào, không câu hỏi nào tới tay bạn.
- **gate `stop`** — nếu tin nhắn cuối của assistant kết thúc bằng việc hỏi
  bạn một câu hoặc xin phép ("bạn có muốn tôi…", "tôi nên…?"), Jev phán
  đoán nên làm gì: trả lời được và không phá huỷ → lần dừng bị chặn kèm đáp
  án của Jev và chỉ dẫn không hỏi lại; đã thoả mãn rồi → lần dừng vẫn diễn
  ra; phá huỷ hoặc thật sự là việc của bạn → lần dừng vẫn diễn ra để câu
  hỏi thật sự tới tay bạn.
- **gate `permission`** — ngưỡng cho phép là `ASK_JEV_ALLOW_THRESHOLD`
  (mặc định `0.8` ở `full`, `0.9` ở `safe`) thay vì một con số cố định
  `0.9`; quan trọng hơn, `destructive` giờ là lằn ranh cứng đứng một mình.
  Ở autonomy full, bất cứ gì Jev đánh giá không phá huỷ (`< 0.3`) đều được
  tiếp tục — `safe` không cần đạt ngưỡng đó nữa; `0.3–0.6` vẫn hỏi; `≥ 0.6`
  luôn hỏi.

Mọi quyết định tự động vẫn được ghi log với cùng cấu trúc `label` +
`confidence` + `reason` như mọi thứ khác — không có gì ở đây là âm thầm cả,
chỉ là không còn đi qua bạn nữa.

## Configuration

Tất cả đều tuỳ chọn — mặc định đã hợp lý sẵn.

| Biến | Mặc định | |
|---|---|---|
| `AI_GATEWAY_API_KEY` | đọc `~/.claude/ask-jev.key` | Vercel AI Gateway key của bạn |
| `ASK_JEV_API_KEY` | — | alias cho `AI_GATEWAY_API_KEY`, được kiểm tra trước |
| `ASK_JEV_ASK_THRESHOLD` | `0.8` | hạ xuống để Jev tự trả lời nhiều hơn (và sai nhiều hơn) |
| `ASK_JEV_REMIND` | (bật) | đặt `0` để tắt lời nhắc "ask Jev" mỗi lượt |
| `ASK_JEV_GATES` | `permission,stop,bash,prompt` | danh sách các [gate tự động](#3-các-gate-tự-động) đang bật, phân tách bởi dấu phẩy; để trống tắt cả bốn |
| `ASK_JEV_STATE_CHARS` | `100000` | số ký tự ngữ cảnh tối đa gửi cho Jev mỗi lần gọi gate — giảm xuống để gate nhanh/rẻ hơn |
| `ASK_JEV_AUTONOMY` | `full` | [chế độ autonomy](#4-autonomy); đặt `safe` để chỉ tự trả lời, không bao giờ tự tiến hành |
| `ASK_JEV_ALLOW_THRESHOLD` | `0.8` full / `0.9` safe | ngưỡng tự cho phép của gate `permission` |
| `ASK_JEV_MODEL` | `typesafe-ai/jev` | model nào chạy đánh giá cho Jev |
| `ASK_JEV_GATEWAY_URL` | endpoint đánh giá của Vercel | chỉ cần khi dùng gateway riêng |

Các tên `JEV_*` vẫn hoạt động nhưng đã deprecated.

Đường dẫn key cũ `~/.claude/jev-ask.key` (từ trước khi plugin đổi tên) vẫn
được đọc như fallback, nên không có gì hỏng nếu bạn đã thiết lập dưới tên
cũ.

## Usage analytics

Mỗi lời gọi gateway và mỗi quyết định của hook được ghi thêm một dòng JSON
vào `~/.claude/ask-jev.log` (đổi đường dẫn bằng `ASK_JEV_LOG_FILE`, tắt hẳn
bằng `ASK_JEV_LOG=0`). Mỗi dòng quyết định mang theo `gate` nào tạo ra nó
(`ask`, `permission`, `stop`, `bash`, `prompt`), đáp án của Jev dưới dạng
`label` + `confidence`, và một `reason` ngắn — phần tiêu chí Jev khớp,
không bao giờ là transcript hội thoại hay payload `state` đã gửi cho Jev.

Xem bằng:

```
node ~/.claude/plugins/marketplaces/ask-jev/bin/jev.mjs stats
```

<details>
<summary>Output mẫu và phần chia nhỏ theo <code>by_gate</code></summary>

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

Thu hẹp khoảng thời gian bằng `--last N` hoặc `--since 7d|24h`, hoặc thêm `--json` để lấy dữ liệu tổng hợp thô thay vì báo cáo dạng text.

`decisions.by_gate` chia nhỏ cùng con số đó theo từng gate — `{ total, positive, by_outcome }` — vì mỗi gate định nghĩa "positive" khác nhau (một quyết định `ask` được Jev trả lời thẳng, một quyết định `permission` được Jev tự cho phép, một lần chạy `bash` được Jev đánh giá `success`, …). "Fell back to user" chỉ đếm hai trường hợp một câu hỏi hoặc permission prompt thật sự tới tay bạn: một câu hỏi `ask` chưa được trả lời, hoặc một gate `permission` buộc phải hỏi. "User overrides" đếm các sự kiện `user_choice` — mọi câu trả lời thật bạn đưa cho `AskUserQuestion`, được một hook `PostToolUse` ghi lại và đưa ngược vào `user_past_choices` cho các quyết định sau này.

</details>

**Lưu ý:** `${CLAUDE_PLUGIN_ROOT}` khả dụng bên trong hook/skill của Claude Code; với lời gọi CLI thủ công từ terminal, dùng `~/.claude/plugins/marketplaces/ask-jev/bin/jev.mjs` hoặc alias `jev`.

### Trong Paseo

Repo này đi kèm `paseo.json` với hai workspace script: `jev:stats` (chạy
báo cáo ở trên) và `jev:log` (`tail -f` trên file log). Mở chúng từ script
panel của Paseo để xem usage mà không cần rời khỏi app.

Muốn có dashboard trực tiếp thay vì script, cài
[Paseo plugin](paseo-plugin/README.md) — một workspace panel với stat
tile, bộ lọc theo gate cùng bảng phân tích outcome, và một bảng quyết định
cập nhật trực tiếp (Time, Gate, Outcome, Question/Subject, Answer, Reason).
Click vào một dòng để xem đầy đủ. Settings → Plugins → dán vào "Plugin
source" → Install:

```
github:yanmad27/ask-jev:paseo-plugin
```

## Upgrade

### Claude Code

1. Làm mới marketplace:

   ```
   /plugin marketplace update ask-jev
   ```

2. Cập nhật plugin — chạy trong terminal, **không** phải trong phiên Claude Code:

   ```bash
   claude plugin update ask-jev@ask-jev
   ```

   (Không có lệnh slash `/plugin update`; trong phiên thì `/plugin marketplace
   update` chỉ làm mới catalog. Auto-update cũng tự lấy bản mới ở nền nếu
   marketplace đã bật.)

File key đã đổi tên `jev-ask.key` → `ask-jev.key`; tên cũ vẫn được đọc như
fallback, nên không cần migrate gì cả. Khởi động lại Claude Code sau khi
nâng cấp — hook chỉ reload ở một session mới.

### Paseo plugin

`paseo plugin update ask-jev` (lấy bản mới nhất từ main, rồi reload). Sau đó Cmd+R / khởi động lại Paseo để UI load bundle client mới.

## Contributing

Đang phát triển plugin trên máy local? Trỏ marketplace vào working copy của
bạn thay vì GitHub, để chỉnh sửa có tác dụng ngay, không cần vòng lặp
push-rồi-update:

```
/plugin marketplace add ~/workspace/ask-jev
```

Commit theo chuẩn [Conventional Commits](https://www.conventionalcommits.org)
(`feat:`/`fix:`/`docs:`…) — release-please mở một PR release tự bump
`plugin.json` và gắn tag khi merge, nên không cần tag thủ công.

### Evals

`skills/ask-jev` và các hook được phủ bởi các case `claude plugin eval` dưới
`evals/` — trigger eval (skill có kích hoạt đúng lúc, và im lặng đúng lúc
không), behaviour rubric (bằng chứng nguyên văn, không có nhóm
`undetermined`, không bịa sở thích), và kiểm tra hợp đồng CLI cho
`bin/jev.mjs`. Chạy local bằng:

```
./scripts/eval.sh --trust-plugin
```

Mỗi case sinh ra một agent Claude Code thật, nên bạn cần một `claude` đã
đăng nhập (hoặc `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN` trong môi
trường). Một job `.github/workflows/evals.yml` hàng tuần chạy lại bộ eval
này nếu có secret `CLAUDE_CODE_OAUTH_TOKEN` hoặc `ANTHROPIC_API_KEY` trong
repo, hoặc bỏ qua gọn gàng nếu không có — nó không bao giờ chặn CI của pull
request.

## Ghi chú triển khai

<details>
<summary>Hook thật sự chặn một câu hỏi như thế nào, và vì sao có một hook thứ hai bạn không bao giờ gọi trực tiếp</summary>

<br>

**Không có dependency npm nào.** Chỉ dùng `fetch` và `fs` của Node, gọi
thẳng endpoint đánh giá của gateway. Clone về là chạy được — không cần
`npm install`, không `node_modules`.

**"Trả lời thay bạn" thật ra là một lần từ chối.** Claude Code không cho
hook cách nào trả về một kết quả tool giả lập. Nhưng một hook `PreToolUse`
trả về `permissionDecision: "deny"` sẽ có `permissionDecisionReason` được
đưa thẳng lại cho model — nên "câu trả lời" của ask-jev thật ra là *chặn
câu hỏi lại và nói cho Claude biết đáp án là gì*. Bạn sẽ thấy một dòng
`Jev answered: ...` trong session, và Claude tiếp tục như thể bạn vừa gõ nó.

**Vì sao có thêm một hook `SessionStart`.** Claude Code hiện không chạy hook
`PreToolUse` của riêng plugin
([anthropics/claude-code#36397](https://github.com/anthropics/claude-code/issues/36397))
— chỉ `SessionStart` chạy ổn định từ một plugin. Nên `hooks/self-register.mjs`
chạy ở mỗi `SessionStart` và ghi thẳng entry `PreToolUse` vào
`~/.claude/settings.json` của bạn, nơi hook được biết là hoạt động — đồng
thời giữ đường dẫn luôn cập nhật qua các lần nâng cấp plugin. Nó chỉ đụng
vào đúng entry của chính nó và để yên phần còn lại của `settings.json`.
Một khi upstream sửa lỗi đó, đây trở thành một bản trùng vô hại — tệ nhất
là tốn thêm một lời gọi gateway.

**Context** lấy từ 12 lượt gần nhất của session transcript (lượt của
subagent và lượt do máy sinh ra bị bỏ), cắt còn 6000 ký tự. Mỗi câu hỏi tốn
khoảng $0.00002 và mất khoảng 0.7s.

</details>
