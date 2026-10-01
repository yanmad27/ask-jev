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

Claude Code hay dừng lại hỏi bạn (`AskUserQuestion`), và đáp án nhiều khi đã
nằm sẵn trong cuộc hội thoại. ask-jev đưa câu hỏi đó cho Jev — một model nhỏ,
nhanh, chuyên phán đoán thay vì trò chuyện, trả về xác suất thay vì chữ — rồi
hiện đề xuất của Jev ngay cạnh câu hỏi. **Jev đề xuất; bạn quyết định.** Jev
không bao giờ trả lời `AskUserQuestion` thay bạn và không bao giờ chặn nó: câu
hỏi luôn tới tay bạn, với các option và nhãn của chúng còn nguyên. Mặc định
dòng của Jev được nối vào nội dung câu hỏi (xem
[cài đặt kênh](#1-đề-xuất-cho-askuserquestion)).

```
"Dùng thư viện nào để parse ngày?"     → Jev đề xuất: "date-fns" (#1) (1.00) — [grounded in your messages/past choices]
"Đóng gói thành plugin hay skill?"     → Jev đề xuất: "Plugin" (#1) (0.95) — [grounded in your messages/past choices]
"Bạn muốn giao diện tông màu nào?"     → Jev nghiêng về: "Teal" (#2) (0.55) — [no direct statement from you — a guess]
"Có xoá luôn 3 environment cũ không?"  → Jev đề xuất: "Giữ lại" (#2) (0.88) — [grounded in your messages/past choices]
```

(Dòng đề xuất mà hook của Claude Code hiển thị bằng tiếng Việt: `đề xuất` =
"recommends", `nghiêng về` = "leans towards"; phần `<reason>` giữ nguyên
tiếng Anh như mô tả option và tag.)

## Cài đặt

1. Thêm marketplace (một lần mỗi máy):

   ```
   /plugin marketplace add yanmad27/ask-jev
   ```

2. Cài plugin:

   ```
   /plugin install ask-jev@ask-jev
   ```

3. Lấy key tại [console.typesafe.ai/keys](https://console.typesafe.ai/keys)
   và đặt vào biến môi trường `TYPESAFE_API_KEY` — hoặc ghi vào file:

   ```bash
   echo '<key của bạn>' > ~/.claude/ask-jev.key && chmod 600 ~/.claude/ask-jev.key
   ```

   **Vercel AI Gateway (legacy):** key `vck_...` cũ vẫn chạy — được tự nhận
   diện và đi qua gateway. Ép provider bằng `ASK_JEV_PROVIDER=typesafe|vercel`.
   Đọc key từ `AI_GATEWAY_API_KEY` đã deprecated; hãy dùng `TYPESAFE_API_KEY`.

Vậy là xong. **Chưa đặt key →** plugin lặng lẽ không làm gì và Claude Code
vẫn hỏi bạn y hệt như trước giờ. Không có gì để hỏng cả.

## Bạn sẽ thấy gì

Khi Claude hỏi bạn một câu, ask-jev thêm một dòng đề xuất cho mỗi câu hỏi
vào session:

```
Jev đề xuất: "Plugin" (#1) (0.95) — [grounded in your messages/past choices]
Jev nghiêng về: "Teal" (#2) (0.55) — [no direct statement from you — a guess]
```

- **`Jev đề xuất: "X" (#n) (0.86) — <reason>`** — độ tin của Jev vào `X` bằng hoặc
  cao hơn `ASK_JEV_ASK_THRESHOLD` (mặc định `0.8`).
- **`Jev nghiêng về: "X" (#n) (0.55) — <reason>`** — đề xuất yếu: dưới ngưỡng đó.
- **`X` là nhãn của option, đặt trong dấu ngoặc kép và cắt tối đa 40 ký tự**, kèm
  số thứ tự option `#n` — nhãn do agent viết nên chỉ dạng ngắn, có đánh số mới vào
  dòng của Jev. Mô tả đầy đủ của option vẫn hiện ngay trên option.
- **`<reason>` không phải lời giải thích của Jev** — classifier chỉ trả về
  xác suất, không trả về chữ. Đó là một thẻ do chính plugin sinh ra: lời của bạn
  hoặc lựa chọn trong quá khứ có làm căn cứ cho pick
  (`[grounded in your messages/past choices]`), hay chỉ là đoán
  (`[no direct statement from you — a guess]`), hay thiếu điểm grounded
  (`[grounding unavailable]`). Không chép chữ nào do agent viết vào đó.
- **Nếu Jev lỗi** (lỗi provider, timeout, hết credits) câu hỏi vẫn
  tới tay bạn, kèm một ghi chú được nối vào giống như đề xuất: `Jev: không có đề xuất (lỗi <status>) — bạn tự quyết`.
  Lỗi billing / HTTP 402 nói `hết credits — credits exhausted` đúng một lần
  mỗi session, sau đó là ghi chú chung.
- **Chưa đặt API key** → hoàn toàn im lặng.

Câu hỏi không bao giờ bị trả lời hay từ chối. Ở kênh `annotate` mặc định (bên
dưới), nội dung câu hỏi mang dòng của Jev (hoặc ghi chú lỗi) và mô tả của
option được đề xuất có thêm ` (Jev đề xuất)`; nhãn option không bao giờ bị đổi.
Các ví dụ ở trên chỉ mang tính minh hoạ.

## Cách hoạt động

Bốn lớp xếp chồng lên nhau:

1. **[Đề xuất cho `AskUserQuestion`](#1-đề-xuất-cho-askuserquestion)** — tính
   năng cốt lõi ở trên: Jev đề xuất, bạn trả lời.
2. **[Hỏi Jev trước khi phán đoán](#2-hỏi-jev-trước-khi-phán-đoán)** —
   Claude có thể hỏi Jev qua CLI cho các phán đoán *nội bộ* của chính nó
   (chọn model/tier nào, phân loại một thứ) — không bao giờ cho việc thuộc về
   bạn quyết.
3. **[Các gate tự động](#3-các-gate-tự-động)** — bốn hook chủ động hỏi Jev
   đúng những lúc một reviewer con người sẽ lên tiếng: lệnh này có an toàn
   không, assistant có dừng quá sớm không, lệnh có chạy thành công không,
   prompt có mơ hồ không.
4. **[Autonomy](#4-autonomy)** — các *gate* tự hành động thay vì hỏi bạn tới
   mức nào, với một lằn ranh không bao giờ tắt: bất cứ gì có tính phá huỷ
   luôn được đưa về cho bạn quyết.

### 1. Đề xuất cho `AskUserQuestion`

Khi Claude Code sắp hiện một câu hỏi cho bạn, ask-jev gửi nó cho Jev cùng
với ngữ cảnh session, và Jev chấm điểm từng option. **Jev không bao giờ trả
lời.** Nó không thể chọn một option, từ chối tool, hay trả một kết quả về cho
Claude — hook `PreToolUse` chỉ thêm thông tin, không làm gì khác.

Thứ Jev được xem là `state` được mô tả ở mục "Jev được cho xem gì" trong
[Các gate tự động](#3-các-gate-tự-động): các tin nhắn **bạn đã gõ** (mục `task` chỉ chứa những tin đó — kết quả
tool và output của chính Claude không nằm trong đó), cuộc hội thoại gần đây,
file CLAUDE.md và memory của bạn, và **các lựa chọn trong quá khứ** của bạn.
Hai điều cần biết về lựa chọn trong quá khứ:

- chúng được đọc từ [log cục bộ](#usage-analytics) — 30 câu trả lời
  `AskUserQuestion` gần nhất được ghi ở đó, **trên mọi project và mọi
  session** của bạn (cùng project trước), không chỉ project hiện tại;
- nên nội dung câu hỏi và option bạn đã chọn ở một project khác có thể được
  gửi cho Jev khi bạn đang làm việc ở project này.

Rồi Jev phán đoán một việc cho mỗi câu hỏi: **dựa trên bằng chứng đó, bạn sẽ
chọn option nào?** (và liệu lời của chính bạn hoặc lựa chọn trong quá khứ có
thật sự làm căn cứ cho pick đó không). Không còn bộ lọc "đây có phải việc của
bạn không?" nữa — câu hỏi về sở thích, cá nhân, thậm chí phá huỷ cũng đều nhận
được đề xuất, vì bạn là người quyết. Xem [Bạn sẽ thấy gì](#bạn-sẽ-thấy-gì) để
biết định dạng.

Dòng đề xuất có dạng `Jev đề xuất: "<nhãn>" (#n) (<độ tin>) — <thẻ grounded>`
(`Jev nghiêng về:` khi độ tin dưới ngưỡng). "Lý do" một dòng là một **thẻ grounded** do
chính plugin sinh ra — lựa chọn có dựa trên lời bạn nói hay lựa chọn trước đây của bạn không —
và không bao giờ là văn bản chép từ mô tả option của agent (mô tả vẫn hiện ngay trên option),
nên plugin không bao giờ chép mô tả do agent viết vào dòng của Jev. Nếu câu hỏi, header, nhãn hay mô tả do agent viết đã chứa
dấu hiệu của Jev, hook không chú thích gì: nó quay về kênh `message` (best effort) và ghi một diagnostic
`jev_marker_in_agent_text`.

**Đề xuất tới tay bạn thế nào** là một cài đặt, `ASK_JEV_ADVICE_CHANNEL`:

| Kênh | Điều gì xảy ra |
|---|---|
| `annotate` (mặc định) | Hook trả về `permissionDecision: "ask"` kèm `updatedInput`: dòng đề xuất (hoặc, khi Jev lỗi, ghi chú lỗi) được nối vào nội dung câu hỏi và mô tả của option được đề xuất thêm ` (Jev đề xuất)`; nhãn option không đổi. Nó cũng phát cùng nội dung đó dưới dạng `systemMessage` cấp cao nhất. Nó vẫn hỏi bạn — hook bỏ mọi khoá giống "câu trả lời" (`answers`, `annotations`, …) khỏi `updatedInput`, nên không bao giờ điền sẵn đáp án được |
| `message` (tuỳ chọn) | Chỉ một dòng `systemMessage` cấp cao nhất cho mỗi câu hỏi; bản thân câu hỏi đi qua nguyên vẹn |

`annotate` là mặc định vì ở Claude Code 2.1.284, một `systemMessage` đứng một
mình chỉ hiện trong transcript *sau khi* hộp thoại đã đóng — quá muộn để giúp
bạn chọn. Vì nội dung câu hỏi là thứ Claude Code dùng làm khoá của câu trả lời,
câu trả lời Claude nhận được mang khoá là câu hỏi đã chú thích, nên Claude cũng
thấy dòng của Jev ở đó, được gắn nhãn là của Jev. [Log](#usage-analytics) giữ
câu hỏi **gốc** làm văn bản chuẩn.

`annotate` (`permissionDecision: "ask"` + `updatedInput`) đã được xác minh trong một phiên Claude Code
2.1.284 thật ở chế độ mặc định và `bypassPermissions` (hộp thoại mở với câu hỏi đã chú thích, chờ bạn,
rồi trả đúng lựa chọn của bạn); `acceptEdits` và `plan` cũng dùng nó. Ở chế độ khác (`dontAsk`, giá trị lạ) hook dùng
kênh `message`: chỉ một `systemMessage`, không có `permissionDecision`, không có `updatedInput`.

Với nhiều câu hỏi trong một lời gọi, mỗi câu có một dòng riêng, tiền tố
`[1/3]`, `[2/3]`, …; câu hỏi `multiSelect` được phán đoán từng option và có
thể đề xuất nhiều option (hoặc không option nào).

**Trong [Paseo](#trong-paseo), cài [Paseo plugin](paseo-plugin/README.md) —
nó đề xuất ngay trong app, và vẫn không bao giờ trả lời.** Plugin theo dõi
permission request đang chờ và thêm một timeline item cho mỗi câu hỏi
(`ask-jev.advice`) — một item riêng, không phải chữ trên card. Nó không bao
giờ gọi `respondToPermission` cho một câu hỏi. Nếu Jev lỗi, một item
`ask-jev.advice` cho biết không có đề xuất (402 thêm rằng credits của Jev đã
hết, một lần mỗi agent session); thiếu key thì im lặng. Hook `AskUserQuestion`
của Claude Code đứng im dưới `PASEO_AGENT_ID` (ghi log là `standdown`, không
phải `decision`) nên hai bên không bao giờ đề xuất đôi. Không có plugin thì câu
hỏi trong Paseo tới tay bạn không kèm đề xuất.

**Giới hạn đã biết:** một advice item đang được append dở dang khi bạn trả lời
vẫn có thể hiện ra sau đó (không huỷ được). Câu trả lời của bạn khi đó được ghi
là `no_advice`, vì lúc bạn chọn thì đề xuất chưa hiện.

Plugin cần cùng API key Jev như các hook — `~/.claude/ask-jev.key`, hoặc
`TYPESAFE_API_KEY`/`ASK_JEV_API_KEY` — nhưng nó được đọc từ môi trường và
thư mục home của **Paseo daemon**, không phải shell bạn đang gõ. Nếu bạn
chỉ export key trong shell rc, daemon có thể không bao giờ thấy được; file
key tránh được chuyện đó. Chỉ cài **một** bản của plugin: hai bản cùng nạp
trong một process (ví dụ `ask-jev` và một `ask-jev-dev` cục bộ) dùng chung
một dedupe map trong bộ nhớ nên chúng không cùng đề xuất cho một request,
nhưng chẳng có lý do gì để chạy hai bản.

<details>
<summary>Option cần định nghĩa thật sự, multiSelect, và khi nào không có đề xuất</summary>

**Option cần định nghĩa thật sự.** Để Jev phán đoán được, mỗi option cần một
mô tả **định nghĩa** nó thật sự — chứ không chỉ là một cái nhãn. Lấy ví dụ
"Đây có phải hamburger không?" với option chỉ ghi "Có": chẳng có gì để đối
chiếu cả. "Có" cần một mô tả kiểu *"Một loại sandwich nóng: một miếng thịt
bằm nấu chín kẹp trong bánh mì tròn cắt đôi"* — thứ mà bạn có thể đem bằng
chứng ra đối chiếu và kiểm chứng được. Mô tả này cũng chính là thứ `<reason>`
của Jev trích lại cho bạn.

Nếu bất kỳ option nào trong câu hỏi thiếu mô tả (hoặc câu hỏi có ít hơn hai
option), ask-jev không gọi Jev cho câu hỏi đó: không thêm đề xuất, không thêm
ghi chú, và câu hỏi tới tay bạn như Claude đã hỏi. Câu hỏi bị bỏ qua được ghi
log là `advice_unavailable` (`missing_definition` / `single_option`).

Bên dưới, mỗi option được gửi dưới dạng `{what, not_for}` — `not_for` nêu
tên các option anh em mà nó không được chồng lấn, để các định nghĩa loại trừ
lẫn nhau thay vì chỉ nằm cạnh nhau.

**Nhiều câu hỏi, và multiSelect.** Nhiều câu hỏi trong cùng một lời gọi
`AskUserQuestion` được đề xuất độc lập; lỗi ở một câu không ảnh hưởng các câu
khác.

Câu hỏi `multiSelect` cũng đi qua Jev: mỗi option trở thành một câu hỏi
yes/no riêng ("option này có áp dụng không?") thay vì chọn một. Mọi option từ
0.5 trở lên đều được đề xuất — có thể không có option nào — và độ tin của đề
xuất là độ tin của option kém dứt khoát nhất.

**Khi nào bạn không nhận được đề xuất (hook Claude Code).**

| Điều kiện | Bạn thấy gì |
|---|---|
| chưa đặt API key | không có gì cả |
| không có ngữ cảnh dùng được trong transcript | không có gì (log `advice_unavailable: no_context`) |
| một option thiếu mô tả, hoặc chỉ có một option | không có gì (log `missing_definition` / `single_option`) |
| Jev lỗi hoặc mất hơn 8s | câu hỏi kèm `Jev: không có đề xuất (…) — bạn tự quyết` (nối vào câu hỏi ở `annotate`, là một `systemMessage` ở `message`) |
| chạy trong Paseo | hook Claude Code đứng im; Paseo plugin (nếu có cài) đề xuất thay |

</details>

### 2. Hỏi Jev trước khi phán đoán

CLI của Jev dành cho các phán đoán **nội bộ của chính Claude** — dùng model
hay tier nào, phân loại một thứ nội bộ ra sao — nơi đáp án suy ra được từ bằng
chứng Claude đã có. Nó **không** phải đường vòng qua bạn: bất cứ gì bạn sẽ
quyết (sở thích, push / PR / merge / deploy, mọi tác động ra bên ngoài như
gửi, upload, mời, mua hay xoá) đều đi qua `AskUserQuestion`, nơi Jev chỉ đề
xuất và bạn trả lời.

Một hook `SessionStart` chèn một quy tắc ngắn nói đúng điều đó. Hai
hook chạy ở mỗi lần bắt đầu session: `self-register.mjs`, là cách lách để
tương thích với các bản Claude Code mà hook `PreToolUse` của plugin không chạy (xem
[Ghi chú triển khai](#ghi-chú-triển-khai)), và `session-start.mjs`, chèn
quy tắc đó. Cả hai đều im lặng nếu chưa cấu hình API key.

Vì một lời nhắc lúc đầu session dễ bị quên sau chục lượt trò chuyện, gate
`prompt` (bên dưới) chèn lại đúng quy tắc một dòng đó ở **mỗi** lượt qua
hook `UserPromptSubmit`. Đặt `ASK_JEV_REMIND=0` để tắt (ví dụ nếu bạn thấy
lặp lại quá); nó vốn đã im lặng khi chưa cấu hình API key.

Claude có thể hỏi Jev cho những phán đoán nội bộ đó — phân loại, chọn giữa
các lựa chọn, trả lời yes/no, chấm điểm theo thang — qua skill và CLI đi kèm.
Khi độ tin bằng hoặc cao hơn `ASK_JEV_ASK_THRESHOLD`, Claude có thể hành động
theo đáp án và báo cáo bằng một dòng, `Jev chose "X" (0.93)` (bản thân CLI in
JSON thô bên dưới; dòng báo cáo là một chỉ dẫn dành cho Claude). Dưới ngưỡng,
Claude nêu lựa chọn thủ công của chính nó và nói rõ điều đó:

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

**CLI kiểm tra request trước khi gọi Jev** (`lib/cli-validate.mjs`, chỉ dùng
regex, không gọi model). Không có cách ghi đè.

*Bị từ chối* — exit code 2, không bao giờ gọi provider, Claude quay về lựa
chọn thủ công của chính nó:

- một key trong `state` là lời mô tả của chính Claude về bạn (`user_profile`,
  `user_taste`, `about_user`, …) thay vì lời của bạn;
- một câu hỏi về sở thích mà trong `state` không có lời của chính bạn hay lựa
  chọn trong quá khứ;
- Claude nhờ Jev đánh giá output của chính nó ("fix của tôi đúng chưa?");
- một câu hỏi nhờ Jev quyết một việc thuộc về bạn — push / PR / merge / deploy
  / gửi / xoá và tương tự — theo khung "tôi có nên…?" / "ok để…?", hoặc một
  option có nhãn gồm hành động và đối tượng của nó (`Push to origin`,
  `delete it`, `do_not_push`);
- bất kỳ chuỗi câu hỏi, instruction hay criteria nào dài quá 4096 ký tự.

*Bị gắn cờ* — một cảnh báo ở stderr và trong log, lời gọi vẫn đi tiếp: một
câu hỏi trông có thể kiểm tra được bằng lệnh chỉ-đọc (hãy chạy nó và đưa output
vào `state`); một đoạn văn trong `state` đọc như mô tả sở thích của bạn; một
nhãn chỉ gồm một từ hành động hoặc một criterion giống hành động mà không có
khung quyết định, có thể chỉ là phân loại thông thường (`release`,
`Merge the PR now`); bằng chứng lặp nguyên văn câu hỏi hoặc nhiều nhãn option.

### 3. Các gate tự động

Bên cạnh đề xuất cho `AskUserQuestion`, bốn hook chủ động hỏi Jev đúng
những lúc một reviewer con người sẽ thật sự lên tiếng — không cần Claude
gọi phán đoán tường minh. Mỗi gate bật mặc định và có thể tắt riêng bằng
`ASK_JEV_GATES` (danh sách phân tách bởi dấu phẩy; `ASK_JEV_GATES=` — đặt nhưng
để trống — tắt cả bốn). Các gate không đổi khi chuyển sang thiết kế chỉ-đề-xuất.

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

Mọi gate — và đề xuất cho `AskUserQuestion` ở mục 1 — đều dựng cùng một `state` có
cấu trúc (`lib/context.mjs`), nhắm tới những gì một reviewer con người cẩn
thận thật sự sẽ xem, điền theo thứ tự ưu tiên sau (bốn mục thấp nhất bị bỏ
trước nếu hết ngân sách):

1. `preferences` — CLAUDE.md (global, project root, project `.claude/`) và
   memory bền vững, **nguyên văn nội dung file** — không bao giờ là mô tả
   Claude tự viết về người dùng. Xem "Bằng chứng, không phải mô tả cảm
   tính" bên dưới.
2. `user_past_choices` — 30 lần gần nhất người dùng thật sự được hỏi và đã
   chọn gì, đọc từ log cục bộ (`readUserPastChoices`): **trên mọi project và
   mọi session**, cùng project (`cwd`) trước. Khi Jev đã đề xuất, mục đó còn
   mang `jev_recommended` và việc bạn có `agreement` hay không. Đã đo được là có
   ý nghĩa: cùng một câu hỏi về delegation cho điểm `merge_now=0.98` với một
   đoạn "user preferences" do LLM viết, nhưng `clean_then_merge=1.00` —
   option người dùng thật sự chọn — khi cho xem 7 lựa chọn thật của họ thay
   vào đó.
3. `task` — `current_task` (tin nhắn mới nhất của người dùng) cộng 5 tin
   nhắn gần nhất để lấy bối cảnh — **chỉ văn bản do người gõ**; kết quả tool
   và output của Claude không nằm ở đây.
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

Toàn bộ bị giới hạn ở `ASK_JEV_STATE_CHARS` (mặc định `70000` — một state
thật ~33k ký tự đo được round-trip ~1.8s; api.typesafe.ai giới hạn `state`
32k token, text dày kiểu log 80k ký tự vẫn qua còn 90k bị từ chối với
`max_tokens_exceeded`, nên 70k là mức có biên độ dư). Giới hạn được áp trên độ
dài `JSON.stringify(state).length` thật sự khi các phần được thêm vào theo
thứ tự ưu tiên, không phải tổng kích thước nội bộ của từng phần — một phần
không vừa sẽ bị cắt (giữ phần đầu, đánh dấu `…[truncated]`) hoặc bỏ hẳn nếu
không còn chỗ. Mỗi lời gọi gate được cấp ngân sách 4s (đề xuất
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

Cùng nguyên tắc fail-open như mọi nơi khác: không có API key, API lỗi,
hoặc timeout đều khiến gate im lặng — không bao giờ là một điểm chặn.

</details>

### 4. Autonomy

`ASK_JEV_AUTONOMY` kiểm soát mức độ các [gate tự động](#3-các-gate-tự-động)
tự hành động thay vì hỏi bạn — **`full` là mặc định**; đặt thành `safe` để
quay về hành vi trước khi có autonomy (các gate không bao giờ tự tiến hành qua
một câu hỏi hay một lần dừng). **Nó không ảnh hưởng tới `AskUserQuestion`:**
mục đó chỉ-đề-xuất ở cả hai chế độ — Jev đề xuất, bạn trả lời.

Một lằn ranh không bao giờ tắt, dù ở chế độ nào: một boolean `destructive` —
xem ["thế nào là phá huỷ"](#3-các-gate-tự-động) — và `p ≥ 0.6` luôn đưa
quyết định về cho bạn.

Những gì thay đổi ở `full`:

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

Mọi quyết định của gate vẫn được ghi log với cùng cấu trúc `label` +
`confidence` + `reason` như mọi thứ khác — không có gì ở đây là âm thầm cả,
chỉ là không còn đi qua bạn nữa.

## Configuration

Tất cả đều tuỳ chọn — mặc định đã hợp lý sẵn.

| Biến | Mặc định | |
|---|---|---|
| `TYPESAFE_API_KEY` | đọc `~/.claude/ask-jev.key` | key của bạn từ [console.typesafe.ai/keys](https://console.typesafe.ai/keys) |
| `ASK_JEV_API_KEY` | — | ghi đè mọi biến key khác, được kiểm tra trước |
| `AI_GATEWAY_API_KEY` | — | deprecated: Vercel AI Gateway key cũ, chỉ là fallback |
| `ASK_JEV_PROVIDER` | suy từ key | `typesafe` hoặc `vercel`; key `vck_` suy ra `vercel`, còn lại `typesafe` |
| `ASK_JEV_ASK_THRESHOLD` | `0.8` | ranh giới "mạnh" cho đề xuất `AskUserQuestion` (`Jev đề xuất` từ ngưỡng này trở lên, `Jev nghiêng về` bên dưới) và độ tin mà Claude có thể hành động theo đáp án CLI |
| `ASK_JEV_ADVICE_CHANNEL` | `annotate` | cách hiển thị đề xuất `AskUserQuestion`: `annotate` (nối vào câu hỏi và option được đề xuất qua `updatedInput`, kèm một `systemMessage`) hoặc `message` (chỉ `systemMessage` — chỉ thấy sau khi hộp thoại đóng); giá trị khác đều là `annotate`. `annotate` tự động quay về `message` ngoài các chế độ quyền mặc định/`acceptEdits`/`plan`/`bypassPermissions`, hoặc khi văn bản của agent chứa dấu hiệu của Jev |
| `ASK_JEV_REMIND` | (bật) | đặt `0` để tắt lời nhắc "ask Jev" mỗi lượt |
| `ASK_JEV_GATES` | `permission,stop,bash,prompt` | danh sách các [gate tự động](#3-các-gate-tự-động) đang bật, phân tách bởi dấu phẩy; đặt nhưng để trống (`ASK_JEV_GATES=`) tắt cả bốn |
| `ASK_JEV_STATE_CHARS` | `70000` | số ký tự ngữ cảnh tối đa gửi cho Jev mỗi lần gọi gate — giảm xuống để gate nhanh/rẻ hơn |
| `ASK_JEV_AUTONOMY` | `full` | [chế độ autonomy](#4-autonomy); đặt `safe` để các gate không bao giờ tự tiến hành; không ảnh hưởng đề xuất `AskUserQuestion` |
| `ASK_JEV_ALLOW_THRESHOLD` | `0.8` full / `0.9` safe | ngưỡng tự cho phép của gate `permission` |
| `ASK_JEV_MODEL` | `jev-latest` (`typesafe-ai/jev` khi dùng `vercel`) | model nào chạy đánh giá cho Jev |
| `ASK_JEV_LOG_FILE` | `~/.claude/ask-jev.log` | nơi ghi [log usage](#usage-analytics) |
| `ASK_JEV_LOG` | (bật) | đặt `0` để không ghi log |
| `ASK_JEV_API_URL` | `https://api.typesafe.ai/v1/systemone` (endpoint của Vercel khi dùng `vercel`) | chỉ cần khi dùng endpoint riêng; `ASK_JEV_GATEWAY_URL` vẫn được đọc như alias |

Các tên `JEV_*` vẫn hoạt động nhưng đã deprecated.

Đường dẫn key cũ `~/.claude/jev-ask.key` (từ trước khi plugin đổi tên) vẫn
được đọc như fallback, nên không có gì hỏng nếu bạn đã thiết lập dưới tên
cũ.

## Usage analytics

Mỗi lời gọi API và mỗi quyết định — một gate, một đề xuất cho
`AskUserQuestion`, câu trả lời của chính bạn, hay một lời gọi CLI trực tiếp
tới `bin/jev.mjs` — được ghi thêm một dòng JSON vào `~/.claude/ask-jev.log`
(đổi đường dẫn bằng `ASK_JEV_LOG_FILE`, tắt hẳn bằng `ASK_JEV_LOG=0`). Mỗi
dòng đều có một `event_id` duy nhất.

**Log là riêng tư, nhưng không hề không có lời của bạn.** Nó không chứa
`state` gửi cho Jev hay transcript của session, nhưng có chứa những đoạn trích
ngắn về điều bạn và Claude đã nói — liệt kê bên dưới. Hãy coi nó như lịch sử
shell. Ký tự điều khiển, zero-width và bidi override bị lọc khỏi mọi chuỗi
trước khi ghi một dòng, và `jev stats` lọc lại lần nữa khi in (để dòng cũ hay
văn bản độc hại không chèn được escape vào terminal).

<details>
<summary>Log lưu những gì, từng trường một</summary>

**File.** Được tạo với mode `0600`; một log có sẵn mà mở hơn mức đó sẽ được
siết lại về `0600` lần đầu một process ghi vào. Các file marker cho ghi chú
billing (`.ask-jev-billing-<hash của session id>`, rỗng, `0600`) nằm cạnh log,
hoặc trong `ASK_JEV_STATE_DIR` nếu được đặt.

**Mọi dòng (schema 2)** được đóng dấu `schema`, `version`, `invocation_id`,
`session_id`, `autonomy`, `threshold`, `source` (`hook` / `paseo` / `cli`),
`repo` (URL git remote đã bỏ credential, query và fragment) và `agent` (id
agent Paseo, nếu có).

**Các loại dòng**

| `kind` | Ghi lại gì |
|---|---|
| `call` | một request tới Jev: status, latency, số lần thử, provider/model, kích thước (số ký tự) của từng phần `state` (`state_sizes` — chỉ có kích thước) |
| `decision` | một quyết định của gate, hoặc với `gate:"ask"` (`mode:"advisory"`) outcome `advised` hay `advice_unavailable` cho mỗi câu hỏi |
| `provider_error` | một lời gọi Jev thất bại: lớp lỗi, HTTP status, văn bản lỗi đã redact, ghi chú billing đã hiện chưa |
| `outcome` | bạn đã trả lời `AskUserQuestion` bằng gì, cạnh điều Jev đề xuất (`agreement`: `agree` / `disagree` / `partial` / `free_text` / `no_advice` / `unparsed`) |
| `standdown` | hook Claude Code đứng sang bên vì Paseo đang đề xuất (`diagnostic` cho các sự kiện Paseo liên quan) |
| `user_choice` | các dòng cũ từ trước schema 2; vẫn được đọc để lấy lựa chọn trong quá khứ |

**Văn bản được lưu** (một giới hạn tập trung, áp dụng cho mọi dòng trước khi ghi):

| Trường | Chứa | Giới hạn |
|---|---|---|
| `question` / `question_text` | xem bảng kế tiếp; luôn là câu hỏi **gốc**, kể cả khi bản đã chú thích mới là bản được hiện | 300 ký tự |
| `options`, `chosen`, `recommended` | nhãn option, lựa chọn của bạn, pick của Jev — mỗi phần tử của danh sách bị cắt riêng, tối đa 50 phần tử | 300 mỗi phần tử |
| `advice_text` | dòng đề xuất bạn đã thấy | 300 |
| `reason` | tiêu chí khớp, hoặc với đề xuất là thẻ grounded | 160 |
| `question_name` | tên câu hỏi của CLI | 120 |
| `warnings` | cờ kiểm tra của CLI (`class`, `path`, `message`), tối đa 20 | 300 mỗi chuỗi |
| `error` / `message` | văn bản lỗi của provider, đã redact key, token và credential trong URL | 200 |
| `cwd` | trên dòng `outcome`, thư mục làm việc | — |

`question` là nơi lời của chính bạn có thể xuất hiện. Theo từng loại dòng:

| Dòng | `question` chứa |
|---|---|
| đề xuất `AskUserQuestion` / `outcome` | nội dung câu hỏi Claude đã hỏi bạn; `chosen` là option bạn chọn **hoặc văn bản tự do bạn gõ** cho "Other" |
| gate `permission` | câu lệnh Bash sắp chạy, hoặc `<tool> <đường dẫn file>` với các tool khác |
| gate `bash` | câu lệnh Bash đã chạy (không phải output của nó) |
| gate `prompt` | **prompt bạn đã gửi** (chỉ những prompt gate phán đoán: từ 12 ký tự, không bắt đầu bằng `/`) |
| gate `stop` | tin nhắn cuối của Claude trong lượt đó |
| CLI (`gate:"cli"`) | câu hỏi Claude viết cho Jev; `options` là tên các criteria |

Vì các trường đó là văn bản tự do, một câu lệnh hay prompt chứa secret sẽ bị
ghi đúng như đã gõ (tới mức giới hạn). Chỉ văn bản **lỗi** của provider được
redact. Nếu điều đó quan trọng với bạn, đặt `ASK_JEV_LOG=0`.

**Không lưu:** payload `state`, transcript, nội dung CLAUDE.md / memory,
output của lệnh, và API key.

**Log cũng được đọc ngược lại.** Các dòng `outcome` trong quá khứ của bạn nuôi
`user_past_choices` và các quyết định gate gần đây nuôi `history` trong các
request sau, nên văn bản `question` / `chosen` của một session (và một
project) có thể được gửi cho Jev ở session khác. Xoá file để xoá "trí nhớ" đó.

</details>

Xem nó bằng:

```
node ~/.claude/plugins/marketplaces/ask-jev/bin/jev.mjs stats
```

<details>
<summary>Output mẫu và ý nghĩa từng dòng</summary>

```
Calls: 19 (ok 18, error 1)  error rate 5.3%
Latency: avg 512ms, p95 910ms
Human answers: 8   Agreement with Jev: 71.4% (5 of 7 compared; disagree 1, partial 1)
Advice on AskUserQuestion: 9 questions, advised 7 (strong 5, weak 2), unavailable 2
Positive outcomes: 78.9%  Fallbacks: 15.8%
  (CLI rows: positive = a strong result, confidence at or above the threshold; the log only observes the result, not whether the agent acted on it)

By entry point:
  entry point    decisions  calls  errors  error rate
  hook                  16     16       1        6.3%
  paseo                  2      2       0        0.0%
  cli                    1      1       0        0.0%

Stand-downs (not decisions, not errors): 3  paseo 3
Provider errors: 1  server 1

Decisions by outcome:
  advised                7   36.8%
  allow                  4   21.1%
  success                3   15.8%
  advice_unavailable     2   10.5%
  ask                    1    5.3%
  tests_failed           1    5.3%
  true                   1    5.3%

By gate:
  ask          calls    9  positive  77.8%  advised 7, advice_unavailable 2
  permission   calls    5  positive  80.0%  allow 4, ask 1
  bash         calls    4  positive  75.0%  success 3, tests_failed 1
  cli          calls    1  positive 100.0%  true 1

Recent decisions:
  2026-09-22T10:03:11.000Z  advised            Is this a bug or a feature?    bug (0.91)
  2026-09-22T10:02:47.000Z  allow              rm dist/old-build.js           safe (0.97)
```

Các con số chỉ mang tính minh hoạ. Thu hẹp khoảng thời gian bằng `--last N` hoặc `--since 7d|24h`, hoặc thêm `--json` để lấy số liệu tổng hợp thô thay vì báo cáo dạng văn bản.

- **Human answers** — mọi câu trả lời bạn đưa cho một `AskUserQuestion` (một dòng `outcome`, hoặc `user_choice` cũ), dù Jev có đề xuất hay không.
- **Agreement with Jev** — trong các câu trả lời mà đề xuất của Jev đã được hiện, tỷ lệ khớp chính xác với nó (`agree`); `partial` là một câu trả lời `multiSelect` có phần trùng. Câu trả lời tự do và câu không có đề xuất không được đem ra so sánh.
- **By entry point** — số quyết định, số lời gọi Jev, số lỗi và tỷ lệ lỗi theo từng cổng vào (`hook`, `paseo`, `cli`). Quyết định của CLI được tính vào tổng.
- **Stand-downs** được liệt kê riêng: chúng không phải quyết định, cũng không phải lỗi.
- **Positive** có nghĩa khác nhau ở mỗi gate (một câu hỏi `ask` Jev đã đề xuất, một quyết định `permission` Jev tự cho phép, một lần chạy `bash` Jev đánh giá `success`, …). **Với CLI, nó nghĩa là một kết quả mạnh — độ tin bằng hoặc cao hơn ngưỡng — chứ không phải bằng chứng rằng agent đã hành động theo.** "Fallbacks" đếm các câu hỏi không có đề xuất, các gate `permission` buộc phải hỏi, và kết quả CLI dưới ngưỡng.

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
Click vào một dòng để xem đầy đủ; panel còn hiện "Human answers" và "Agreement
with Jev". Cùng một plugin đó cũng đề xuất cho
`AskUserQuestion` (xem [ở trên](#1-đề-xuất-cho-askuserquestion)) — cài một
lần là đủ cho cả hai. Settings → Plugins → dán vào "Plugin
source" → Install:

```
github:yanmad27/ask-jev:paseo-plugin
```

## Upgrade

### Claude Code

Chạy trong terminal, **không** phải trong phiên Claude Code:

```bash
claude plugin update ask-jev@ask-jev
```

(Không có lệnh slash `/plugin update`. Auto-update cũng tự lấy bản mới ở nền nếu
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

Sửa `lib/*.mjs`? [Paseo plugin](paseo-plugin/README.md) dùng lại đúng chính
sách đó từ một bản sao y hệt dưới `paseo-plugin/shared/` (Paseo chỉ stage
`paseo-plugin/`, nên không đọc trực tiếp `../lib/` được). Chạy
`./scripts/sync-paseo-shared.sh` sau khi sửa `lib/` — CI áp đặt điều này
bằng `scripts/sync-paseo-shared.sh --check` và fail build nếu hai bên lệch
nhau.

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
thẳng API của Jev. Clone về là chạy được — không cần
`npm install`, không `node_modules`.

**Hook `AskUserQuestion` chỉ thêm thông tin.** Nó không bao giờ trả về
`permissionDecision: "deny"` hay `"allow"`, và không bao giờ đặt `answers` vào
`updatedInput`. Kênh `annotate` mặc định trả về `permissionDecision: "ask"`
kèm các câu hỏi đã chú thích (vẫn hỏi bạn) cùng một `systemMessage` cấp cao
nhất; kênh `message` tuỳ chọn chỉ phát `systemMessage`. Mọi lỗi nội bộ đều để
câu hỏi đúng như Claude đã viết.

**Hook `PostToolUse` đọc lại gì.** Claude Code (2.1.284+) đưa cho nó một
`tool_response` dạng object `{questions, answers, annotations}`, với `answers`
khoá theo nội dung câu hỏi; bản cũ dùng phản hồi dạng văn bản, vẫn được parse.
Với mỗi câu hỏi nó ghi một dòng `outcome` có `recommended`, `chosen` và
`agreement` (`agree` / `disagree` / `partial` / `free_text` / `unparsed`, hoặc
`no_advice` khi chưa hiện đề xuất nào). Cả nội dung câu hỏi gốc lẫn bản đã chú
thích đều được chấp nhận làm khoá; dòng log lưu bản gốc.

**Vì sao có thêm một hook `SessionStart`.** `hooks/self-register.mjs` là cách lách
để tương thích với các bản Claude Code dính
[anthropics/claude-code#36397](https://github.com/anthropics/claude-code/issues/36397),
nơi hook `PreToolUse` của riêng plugin không chạy. Nó chạy ở mỗi `SessionStart`
và ghi thẳng entry `PreToolUse` vào `~/.claude/settings.json` của bạn, đồng thời
giữ đường dẫn luôn cập nhật qua các lần nâng cấp plugin. Nó chỉ đụng vào đúng entry
của chính nó và để yên phần còn lại của `settings.json`. Claude Code 2.1.284 chạy
**cả hai** đăng ký; khoá chống trùng trong hook chặn lần gọi thứ hai, nên vẫn chỉ có
đúng một lời gọi provider và một đề xuất cho mỗi câu hỏi.

**Context** là `state` có cấu trúc được mô tả ở mục "Jev được cho xem gì" trong
[Các gate tự động](#3-các-gate-tự-động), không phải một cửa sổ lượt cố định:
tối đa 70.000 ký tự theo mặc định (`ASK_JEV_STATE_CHARS`), gồm 5 tin nhắn bạn
gõ gần nhất (mỗi tin ≤3.000 ký tự), các lượt hội thoại (mỗi lượt ≤4.000, bỏ
lượt của subagent và do máy sinh ra), CLAUDE.md và memory, git diff, và các lựa
chọn trong quá khứ của bạn trên mọi project. Transcript chỉ được đọc từ 2 MB
cuối.

</details>
