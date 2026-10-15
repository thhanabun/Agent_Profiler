# เปรียบเทียบแผน Mission OS กับ Subharness ปัจจุบัน และแผนแบ่งงาน

วันที่ตรวจ: 16 ตุลาคม 2026

อัปเดตหลังการวิเคราะห์: เพิ่ม Mission/web/Supabase templates และแก้ README เรื่อง Codex แล้ว รายงานด้านล่างเป็น snapshot ก่อนเพิ่มโครง สถานะล่าสุดและงานส่งต่อดู [UX/UI handoff](HANDOFF_UX_UI.md) และ [Backend handoff](HANDOFF_BACKEND.md) การมี template ยังไม่ใช่การ implement business flow สำเร็จ

## 1. ขอบเขตและข้อสรุป

เอกสารอ้างอิงคือ `C:/Users/thana/Downloads/final.md` และ `C:/Users/thana/Downloads/final-review.md` เทียบกับ source ใน `C:/Users/thana/work/U-hack` เอกสารทั้งสองเป็นข้อเสนอและเกณฑ์ตรวจ ไม่ใช่คำสั่งให้ลงมือเปลี่ยนโปรเจกต์ในการตรวจครั้งนี้

**โปรเจกต์ปัจจุบันมีฐาน CLI สำหรับ coding agents ค่อนข้างชัด แต่ยังไม่มีชั้น Mission OS ที่เอกสารใหม่เสนอ การเติมหน้าเว็บอย่างเดียวจึงไม่ทำให้ตรงแผนใหม่**

| ประเด็น | โค้ดปัจจุบัน | เป้าหมายใน `final.md` |
|---|---|---|
| ผู้ใช้หลัก | คนทำงานกับ coding harness บนเครื่อง | ผู้จัด workshop/community |
| สิ่งที่เริ่ม | Chat/session + project directory + agent profiles | Mission + เป้าหมาย + brief/CSV + ข้อจำกัด |
| งานที่ทำ | Planner เลือก worker แล้วให้ native harness ทำงานในโปรเจกต์ | อ่านข้อมูล วางกำหนดการ คำนวณ ตรวจข้อขัดแย้ง และเตรียมเปิดรับสมัคร |
| Harness | OpenCode/Codex/Claude ผ่าน native runtime | ตัวควบคุม task และเครื่องมือที่จำกัดขอบเขตของ Mission |
| ข้อมูลหลัก | Local JSON session, ข้อความ, task, native session IDs, file diffs | Canonical fields, immutable revisions, artifact versions, checks, approved bundles |
| สิ่งส่งมอบ | ไฟล์ในโปรเจกต์และ handoff | หน้าอีเวนต์จริง + ใบสมัครใน DB + CSV |
| การรัน | Node process บนเครื่องผู้ใช้ | Backend ที่เว็บเรียกได้ โดยไม่ต้องเปิดเครื่องทีมค้างไว้ |
| การแชร์ | `.agentpack`, OCI image, ORAS registry, team lock | เปิดเผยเฉพาะ published event และรับสมัคร |
| หน้าตา | Ink TUI: tasks / chat / inspector | Web: files / outputs / workers และ public page บนมือถือ |

นี่เป็นการเปลี่ยนทั้ง use case, data model และวิธีรัน ไม่ใช่แค่เปลี่ยน frontend จาก CLI เป็นเว็บ ถ้ายังยึดเป้าหมาย CLI เดิม ให้ใช้แผนในข้อ 6; ถ้ายึด Mission OS ตามไฟล์ใหม่ ให้ใช้ข้อ 7–10 โดยเก็บ CLI ไว้ก่อน

## 2. โครงโปรเจกต์ที่มีอยู่จริง

```text
bin/subharness.mjs          จุดเปิด executable
src/cli.tsx                คำสั่ง CLI และการเริ่ม terminal/stdio host
src/workspace-ui.tsx       เลือกทีม สร้าง chat และเปิด session เดิม
src/ui.tsx                 TUI สามคอลัมน์และคำขออนุญาต
src/core.ts                exports สำหรับ UI/host อื่น ใช้ได้โดยไม่ import Ink
src/application.ts         SessionManager: resolve profiles, create/open/shutdown
src/protocol.ts            JSONL stdio protocol สำหรับ local UI host
src/engine.ts              planner → task dependencies → workers → checkpoint
src/schema.ts              Profile / Plan / Task validation
src/adapters.ts            OpenCode/Claude adapters และ runtime readiness
src/codex.ts               Native Codex app-server adapter
src/workspace.ts           เก็บก่อน/หลังงานเพื่อแสดงไฟล์ที่เปลี่ยน
src/storage.ts             Atomic JSON writes และ lock ของ state directory
src/profiles.ts            โหลด ตรวจ fork และ stage profile source
src/bundles.ts             ZIP .agentpack และ archive validation
src/images.ts              OCI image identity/build/fork/inspect/diff
src/registry.ts            ORAS push/pull และ metadata catalogs
src/teams.ts               Team manifests และ exact-digest locks
profiles/                  orchestrator, implement, codex, review, ui
test/                      Automated fixtures และ opt-in live integrations
benchmarks/wordstats.ts    Benchmark งานเขียนโค้ดหนึ่งงาน
docs/                      Architecture, protocol, images, test evidence
```

### สิ่งที่ทำแล้วและใช้ต่อได้

- Profile รวม harness/model/instructions/skills/plugins; เลือก orchestrator และ workers ต่อ session ได้ โดย role ใน manifest เป็นเพียง default hint
- มี OpenCode, Codex และ Claude adapters ใน source ไม่ใช่สองตัวตามข้อความเก่าบางส่วนของ README; Pi ยังไม่มี
- Planner ส่งแผนที่ผ่าน schema/DAG validation และเลือก worker จาก pool ที่กำหนด; workers ทำทีละงานใน project เดียวกัน
- มี saved conversations, native session continuation, run history, stop/retry/steering และ checkpoint recovery
- มีทีม/session picker และแกน `SessionManager` ที่แยกจาก React/Ink แล้ว
- มี stdio bridge ให้ UI ที่มี Node host ควบคุม sessions และตอบ trust/tool requests ได้
- มี source-only bundles, checksum trust, OCI images, registry transport, catalogs และ team locks
- มีการตรวจ archive/path/checksum และแยก source ที่ export ออกจาก app session state

หลักฐานการรันที่บันทึกไว้ใน [TESTING.md](TESTING.md) คือ 49 automated tests, live OpenCode/Codex flow และ local OCI registry flow ส่วน [wordstats benchmark](benchmarks/wordstats-2026-10-16.md) เป็นงาน coding หนึ่งงาน ทั้งหมดเป็นหลักฐานเดิมที่อ่านประกอบการตรวจ ไม่ได้รันทดสอบใหม่ครั้งนี้

## 3. ช่องว่างเทียบกับ Mission OS

สถานะ “มีบางส่วน” หมายถึงมีแนวคิดหรือกลไกใกล้เคียง แต่ยังไม่ผ่าน contract ของ Mission OS

| ส่วน | สถานะ | สิ่งที่พบ / สิ่งที่ต้องเพิ่ม |
|---|---|---|
| เลือก agent profiles / roles | มีสำหรับ CLI | ใช้แนวคิดต่อได้ แต่ Mission MVP ไม่จำเป็นต้องเลือกหลาย native harness |
| Task dependencies | มีบางส่วน | ปัจจุบันเป็น DAG จาก LLM; ต้องเพิ่ม workshop graph และ field/artifact readsets ที่ประกาศชัด |
| Mission schema | ยังไม่มี | ต้องมี topic/audience/date/time/attendees/budget/venue และ validation ตาม domain |
| Intake ไฟล์ | ยังไม่มีใน flow นี้ | อัปโหลด `.md/.txt/.csv`, validate headers/types/limits, เก็บไฟล์เป็นรุ่น แล้วให้ผู้ใช้ยืนยัน facts |
| Snapshot และ revision | มีเฉพาะ file-diff snapshots | ต้องเพิ่ม immutable input versions, selected-field hashes และ run/generation; snapshot เดิมไม่ได้เป็นแหล่งข้อมูล immutable ที่ worker อ่าน |
| Dependency invalidation | ยังไม่มี | Steering ปัจจุบันหยุด pending tasks แล้ว replan; ยังไม่รู้ว่าเปลี่ยน 60→80 แล้ว agenda ใดใช้ต่อได้ |
| Output artifacts / provenance | มีข้อความและไฟล์ที่เปลี่ยน | ต้องมี budget/agenda/event artifacts ที่มี version, input/output hashes, source provenance และชุดที่สอดคล้องกัน |
| Deterministic checks | ยังไม่มีสำหรับ Mission | ต้องคำนวณงบ/ความจุและตรวจ canonical facts ด้วยโค้ด; task completed ปัจจุบันหมายถึง worker ตอบกลับ ไม่ใช่ business checks ผ่าน |
| Structured decisions | มี native questions | ต้องมีตัวเลือกจาก venues.csv พร้อมราคาผลกระทบ และ operation ที่อัปเดต Mission revision จริง |
| Durable runner | มี local checkpoint/abort | ต้องมี DB claim/lease/attempt, commit guard, stop_epoch และ bounded retries; process lock เดิมทดแทนไม่ได้ |
| Approval / publish | มี trust/tool permissions | ต้องสร้าง business approval ผูก exact revision+bundle และ publish transaction; การยอมให้รันเครื่องมือไม่ใช่ยินยอมเปิดรับสมัคร |
| Draft / public version | ยังไม่มี | ต้องแยก draft กับ published pointer; แก้ draft แล้วหน้า public รุ่นเดิมยังอยู่จนอนุมัติใหม่ |
| Owner accounts / storage | ยังไม่มี | ต้องมี Auth, DB, private files, RLS/grants และตรวจ owner ฝั่ง server |
| Public event / registrations | ยังไม่มี | Renderer, signed-in owner export, idempotent receipt, atomic seat capacity และ signup/public read limits |
| Quota / cost controls | ยังไม่มี ledger | ต้อง reserve quota แบบ atomic ระดับ project/Mission/revision และนับ failed/retry/stale attempts ตามนโยบาย |
| U-Bot / ElevenLabs | ยังไม่พบ integration | ต้องตรวจสิทธิ์และต่อจริง; audio ต้องอ้าง canonical script/version และไม่สร้างใหม่ทุกครั้งที่คนกดฟัง |
| Web UX / deployment | ยังไม่มี | ไม่พบ web app/build, Supabase migrations/functions หรือ Cloudflare deployment config ใน source ที่ตรวจ |
| Mission acceptance evidence | ยังไม่มี | Coding benchmark และ native adapter tests ไม่ครอบคลุม workshop, approval, signup หรือ tenant isolation |

### จุดที่ชื่อคล้ายกันแต่ contract ต่างกัน

1. **Session ≠ Mission revision:** เก็บ chat กลับมาเปิดได้ ไม่ได้แปลว่าทุก output ผูก input รุ่นเดียวกัน
2. **Task acceptance text ≠ evaluator:** `engine.ts` ส่ง acceptance เข้า prompt แต่ไม่ได้บังคับตรวจงบ/ความจุด้วยโค้ดก่อน completed
3. **File diff ≠ artifact provenance:** การรู้ว่าไฟล์ใดถูกแก้ ไม่พอจะพิสูจน์ว่า event/budget/audio ตรงกัน
4. **Checksum trust ≠ publishing approval:** trust อนุญาตรัน profile; publish ต้องเป็นการตัดสินใจแยกของคนต่อ bundle ที่ตรวจแล้ว
5. **Profile OCI image ≠ Mission delivery bundle:** อย่างแรกแจก setup ของ agent; อย่างหลังรวมผลงานของ Mission ห้ามใช้ identity/approval ชุดเดียวกันโดยไม่มี domain model รองรับ
6. **Local JSON lock ≠ DB transaction:** `src/storage.ts` ล็อก process ต่อ state directory ไม่ได้ serialize publish กับการสมัครที่นั่งสุดท้าย

หลักฐานสำคัญ: `src/schema.ts:9` (profiles), `src/schema.ts:32` (tasks), `src/engine.ts:238` (submit/steering), `src/engine.ts:302` (dispatch/completion), `src/workspace.ts:17` (diff snapshot), `src/storage.ts:13` (lock), `src/protocol.ts:8` (stdio methods)

## 4. อะไรควรเก็บ ใช้เป็นแบบอย่าง และพักไว้

### เก็บของเดิม

- เก็บ CLI, adapters, profiles, image/registry features และหลักฐานการรันเดิม ไม่ต้องลบเพื่อเริ่ม Mission OS
- เก็บการแยก core กับ UI และรูปแบบ error/state ที่ส่งต่อให้ UI ได้
- ใช้ประสบการณ์ schema validation, checkpoints, bounded file handling และ run trace เป็นแนวทาง

### ถ้าทำ Mission OS ต้องเพิ่มชั้น domain

- เพิ่ม Mission contracts, deterministic tools และ cloud storage/runner แยกขอบเขตจาก generic coding engine
- เลือก provider/API ที่ทีมมีสิทธิ์และเรียกจาก server ได้จริงสำหรับ MVP; native login บนเครื่องพัฒนาไม่ได้ยืนยันสิทธิ์หรือการรันบน Edge
- ใช้ fixed workshop tasks ตามเอกสารก่อน ไม่ต้องพา arbitrary planner, OCI registry หรือ multi-harness routing เข้า critical path
- อย่าเชื่อม `src/engine.ts` เข้ากับ Supabase Edge ตรง ๆ: มันใช้ Node/native processes และ local filesystem การย้ายนี้ไม่ใช่เปลี่ยน URL adapter

### ถ้ายังทำ CLI ต่อ

- UI ใหม่เชื่อม `core.ts` ใน Node host หรือ `serve --stdio` ได้ทันที โดยต้องถือ project/state lock และ shutdown อย่างถูกต้อง
- Browser ล้วนเชื่อม stdio ไม่ได้ ต้องมี desktop/local host หรือออกแบบ network API เพิ่ม พร้อม authentication; ยังไม่มี remote service นี้
- เลือกเส้นทางนี้ได้ แต่ต้องอธิบายว่าเป็น local agent workspace และยังไม่ตรง hosted Mission flow ของเอกสารใหม่

## 5. ข้อแตกต่างระหว่างเอกสารที่ต้องรับรู้ก่อนประเมินความพร้อม

- `final-review.md` บอกว่าไม่พบ source ในบริบทที่เอกสารนั้นถูกเขียน; โฟลเดอร์นี้มี source และ test evidence แล้ว จึงใช้ประโยคดังกล่าวประเมิน repo ปัจจุบันตรง ๆ ไม่ได้
- README ปัจจุบันบรรทัด 211 ยังกล่าวว่ามีสอง adapters และ Codex ยังไม่ทำ แต่ `src/codex.ts`, `docs/CODEX.md` และ live test evidence ยืนยันว่ามีแล้ว นี่เป็นงานปรับเอกสาร ไม่ใช่งานสร้าง adapter ใหม่
- เอกสารใช้สมมติฐานสี่คน/หกชั่วโมง ไม่ใช่ประมาณเวลาที่ตรวจจากความเร็วทีมจริง โดยเฉพาะ runner races, authorization และ signup concurrency ยังมีงานใหม่หลายชั้น
- Rubric ใน `final.md` ใช้ App execution 40 / Practicality 40 / UX 10 / Innovation & ecosystem 5 / U-Bot 5 ต่างจากข้อความแรกของแชทที่ใช้ Idea 40 และ ElevenLabs 5 ต้องยืนยันเกณฑ์ฉบับที่ทีมจะส่งก่อนล็อก pitch ไม่เดาคะแนนจากฟีเจอร์

## 6. งาน CLI ที่ยังขาด และชุดงานที่ส่งต่อ UI ได้

นี่คือ backlog ของ **Subharness เดิม** แยกจากสิ่งที่จำเป็นต่อ Mission OS

| ชุดงาน | งาน / เงื่อนไขรับงาน | ความสำคัญต่อ CLI | ต่อ Mission demo |
|---|---|---|---|
| CLI-01 เอกสารและขอบเขต | แก้ adapter count/Codex status, บอก local/sequential/runtime prerequisites ให้ตรง source | ควรทำก่อนส่งต่อ | ช่วยไม่ให้ทีมเข้าใจผิด |
| CLI-02 UI handoff | ให้เพื่อนทำ profile/team picker, session list, chat/task/run view, inspector และ trust/tool request view โดยใช้ `core.ts`/stdio; state มาจาก engine และ request ต้องตอบด้วย requestId | พร้อมเริ่มได้บน Node host | ยังไม่ใช่ Mission UI |
| CLI-03 Runtime installer | ถ้าจะทำ pull→run บนเครื่องใหม่ได้เอง ต้องมี managed install cache, install lock, exact-version verification, interrupted-install recovery; ตอนนี้ให้ผู้ใช้ติดตั้ง native harness เอง | จำเป็นต่อ promise auto-install เดิม | ไม่จำเป็นถ้าใช้ server AI API |
| CLI-04 Codex components | รองรับ packaged plugins ให้โหลดได้จริง และ UI สำหรับ structured MCP forms; ตอนนี้ plugin bundle ถูกปฏิเสธและ forms ถูก decline ชัดเจน | ช่องว่างของ profile portability | พักได้ |
| CLI-05 External dependencies | กำหนด source/revision resolution และ lock/installation สำหรับ external deps; image lock ปัจจุบันเน้นไฟล์ที่ฝังอยู่ ไม่ใช่ dependency installer | จำเป็นเมื่อจะรองรับ deps ภายนอก | พักได้ |
| CLI-06 Hosted Hub | ถ้าจะกลับสัญญา Agentpack เดิม ต้องมี hosted index/accounts/namespace ownership/publish authorization; ORAS กับ catalog files ไม่ใช่ Public Hub service | งานผลิตภัณฑ์อีกชุด | อยู่นอก Mission MVP ตามเอกสาร |
| CLI-07 Isolation / concurrency | ปัจจุบัน shared project และ sequential workers; ถ้าจะ parallel ต้องมี workspace isolation, merge/conflict policy และ lock ที่ไม่เลี่ยงได้ด้วย state root อื่น | ทำเมื่อจะรองรับ parallel | ไม่ใช่ข้อจำเป็นของกราฟ sequential |
| CLI-08 Live readiness | Windows/macOS/Linux launch/cancel/path spaces, hosted registry auth, fresh machine setup; Claude ต้องแก้ native login แล้วทดสอบจริง | ต้องทำก่อนอ้างรองรับครบ | ไม่แทน Mission E2E |
| CLI-09 Reproducibility / evaluation | ระบุ native config/provider aliases ที่อยู่นอก source lock; หากอ้างความเร็ว/คุณภาพให้เพิ่ม trials และวัด calls/cost/variance | ต้องมีหลักฐานก่อนอ้างผล | ใช้ benchmark ใหม่ตาม domain |

Pi, recursive orchestration, background daemon และ arbitrary mid-session profile changes ยังไม่ใช่ขอบเขตที่ทำแล้ว ไม่จำเป็นต้องเพิ่มเพื่อปิดงาน OpenCode/Codex ที่ผู้ใช้เลือกไว้ก่อนหน้า

### ขอบเขตให้เพื่อนที่ทำ UI ของ CLI เดิม

- อ่าน `docs/UI_PROTOCOL.md`, `docs/ARCHITECTURE.md`, `src/core.ts` และ `src/protocol.ts` ก่อนสร้าง data model ใหม่
- ส่งต่อ screens: เลือกทีม → session list/new → chat/tasks → file diff/run inspector → active permission/question → error/retry/stop
- ต้องแสดง busy/stopped/failed และ source trust ตามจริง; permission card ใช้รายละเอียดจาก adapter ไม่สร้างการอนุมัติกว้างแทนผู้ใช้
- การสลับ session ระหว่างงานต้องเคารพ guard ของ manager; session ที่ resume ใช้ configuration เดิมที่ล็อกไว้
- UI owner ไม่ต้องเขียน planner/adapters/image store ใหม่; core owner รับผิดชอบ API additions ที่จำเป็นจริง

## 7. แบ่งงาน Mission OS เป็นสี่ชุดที่ทำขนานกันได้

จำนวนคนเป็นสมมติฐานจากเอกสาร ไม่ใช่การจองคนหรือรับประกันเวลา ด้านล่างคือขอบเขตส่งต่อ ไม่ได้สร้างงานหรือส่งข้อความให้ใครในการตรวจครั้งนี้

### A — Mission backend / runtime

**รับผิดชอบ:** เจ้าของสัญญาข้อมูล, DB/migrations, Auth/RLS/grants, immutable inputs, task claim/lease, commit guards, revision/generation/stop_epoch, artifact storage และ quota reservations

- ออก contract ร่วมกับ B ก่อนให้ C/D ต่อ UI; แยก execution state ออกจาก published bundle
- รองรับ create/get/update with expectedRevision/start/cancel และ events ที่อ่านได้โดยไม่เรียก AI ใหม่
- Hash readsets และ reuse เฉพาะ artifact ที่ยังตรง; ไม่ให้ late worker เขียนทับ draft ปัจจุบัน
- งาน server จำกัด tools ตาม Mission ไม่ส่ง shell/native coding runtime ไปเป็น public backend
- รองรับ quota ledger และ bounded retries; สิ่งที่ถูกส่งให้ provider แล้วต้องไม่หายจากการนับเพียงเพราะผู้ใช้กด stop
- รับผิดชอบ publish/signup transactions ร่วมกับ D; D เป็นเจ้าของ public API/UI ไม่ควรต่างคนต่างเขียน transaction คนละแบบ

**รับงานเมื่อ:** reload ได้ Mission เดิม, stale/expired/stopped results commit ไม่ได้, owner B อ่าน A ไม่ได้ และ browser ปลอม completed/checks/publish state ไม่ได้

### B — Domain tools / AI / U-Bot

**รับผิดชอบ:** schema ของข้อมูล workshop, CSV parsing, input confirmation, deterministic budget/capacity/venue tools, prompts, output validation และ U-Bot integration

- แยก tasks `intake`, `budget_capacity`, `agenda`, `event_content`, `validate_bundle` พร้อม readsets ที่ A ใช้ได้
- ไม่ให้ AI แต่งห้อง/ราคา/ความจุ หรือเป็นผู้ตัดสินว่า checks ผ่าน
- Structured blocker ส่งตัวเลือกจากข้อมูลจริงพร้อมผลกระทบ; ข้อมูลขาดให้ถาม fields ที่ขาด
- รองรับ brief อย่างน้อยสองหัวข้อและ incomplete-input case เพื่อแสดงว่า AI ไม่ได้คืน fixture เดิม
- ตรวจรูปแบบ U-Bot request/response และสิทธิ์ก่อนอ้างว่า integration พร้อม; error ต้องแสดงตามจริง

**รับงานเมื่อ:** A/60 = 10,800; A/80 ติดความจุ; B/80 = 14,400; เปลี่ยนค่าห้อง B เป็น 10,000 แล้วรวม 16,400 ติดงบ และกรณีไม่มีห้องที่ผ่านไม่สร้างตัวเลือกปลอม

### C — Workspace UX/UI

**รับผิดชอบ:** create/intake confirmation, workspace files/outputs/workers, conflict choices, change preview, review/approval และ error/accessibility flow

- ตัดสินใจจาก Mission state/API ของ A และ schemas ของ B; ไม่ใช้ Task ของ CLI เป็น Mission schema โดยตรง
- แยกให้เห็น current facts, draft status และ published version; ไม่แสดงเปอร์เซ็นต์ที่ไม่ได้คำนวณจากงานจริง
- หลังเปลี่ยนข้อมูล แสดงสิ่งที่ต้องทำใหม่/ใช้ต่อได้/ยังรอ และแสดง source ของตัวเลือก
- ปุ่ม publish ต้องบอกผลชัด “อนุมัติและเปิดรับสมัคร”; แนบ exact bundle/revision และรองรับ 409 reload/review ใหม่
- มี empty/loading/needs_input/failed/retry/stopped/stale และ unauthorized states
- Keyboard focus, zoom, contrast, readable status และ mobile layout; ทดสอบกับผู้จัดจริง 2–3 คนเมื่อ flow ต่อได้

**รับงานเมื่อ:** ผู้ใช้เริ่มด้วย fixture จริง ยืนยันข้อมูล เปิด output เปลี่ยน 60→80 เลือก B ดู diff และส่งอนุมัติถูก bundle ได้ โดยไม่ต้องพิมพ์คำสั่ง CLI

### D — Public event / registrations / deployment / partner audio

**รับผิดชอบ:** static hosting shell ตั้งแต่ต้น, published renderer, mobile signup/receipt, owner count/CSV, final URL และ release evidence

- Public endpoint คืน allowlist ของ published fields เท่านั้น; ไม่คืน brief/งบภายใน/รายชื่อผู้สมัคร
- Signup ใช้ client_request_id และ seenBundleId; retry เดิมคืน receipt เดิมก่อนตรวจว่ารอบนี้เต็มหรือ bundle เปลี่ยน
- ร่วม A ทำ atomic cap checks และ publish guard; ลด capacity ต่ำกว่าจำนวนผู้สมัครไม่ได้
- CSV ให้เฉพาะ owner และป้องกันสูตรจากค่าที่ผู้ใช้กรอก; UI แสดงสำเร็จหลัง DB commit
- ถ้าสิทธิ์พร้อม ต่อ ElevenLabs จาก canonical script ที่ตรวจแล้ว เก็บ audio artifact/hash และ text alternative; ไม่ regenerate ต่อ view
- เตรียม URL/repo/deck/run evidence ให้ตรง release และลองมือถือคนละ network โดยปิด local dev server

**รับงานเมื่อ:** สแกน QR แล้วสมัครจากมือถือได้ มี receipt/count/CSV จริง, concurrent last seat รับได้หนึ่งคน, draft edit ไม่เปลี่ยนหน้า public จนอนุมัติรุ่นใหม่

### QA เป็นงานร่วม ไม่ใช่คนที่ห้า

A รับ race/authorization/caps; B รับสูตร/input/AI correctness; C รับ UX/errors/usability; D รับ publish/signup/mobile/deployment แต่ละชุดต้องส่ง evidence ของส่วนตัวเองก่อนรวม ไม่โยนทุกอย่างให้คน deploy ตอนท้าย

## 8. Handoff ให้ UX/UI เริ่มได้ทันที

ถ้าทำ Mission OS ให้ส่ง brief นี้พร้อม mock API contract และ fixtures; mock ใช้พัฒนา UI ได้ แต่ demo/evidence ต้องระบุและเปลี่ยนไปใช้ API จริง

| หน้าจอ | UI ต้องแสดง | API / ข้อมูลที่รอ |
|---|---|---|
| My Missions / create | เป้าหมาย, files, example-data action, validation errors | createMission, list/get, upload/parse result |
| Confirm facts | fields ที่อ่านได้/ยังขาด, source filename/version | canonical schema และ updateMission(expectedRevision) |
| Workspace | ซ้าย files; กลาง budget/agenda/event previews; ขวา workers/blockers; draft/public badges | tasks, artifact refs, source refs, events, current revision |
| Conflict / edit | 80 คนกับห้อง A, ห้อง B และงบ, affected/reused outputs | structured choices และ calculated impact จาก backend |
| Review / publish | current checks, bundle diff, expected revision, clear approval action | prepare/validate bundle, approveAndPublish |
| Public mobile / receipt | canonical event, capacity, nickname, success/full/stale/error, optional audio | published projection, submitRegistration, receipt |

**อย่าส่งเพื่อนแค่ภาพสามคอลัมน์:** ต้องส่ง field names, status enum, source/version identifiers, request/error shapes, expected-revision behavior และตัวอย่างข้อมูลครบหนึ่ง flow ด้วย ไม่เช่นนั้น UI จะสร้าง state ปลอมซ้ำกับ backend

## 9. Contracts และไฟล์ที่ควรตกลงก่อนแยกทำ

เส้นทางต่อไปนี้เป็นข้อเสนอสำหรับงานใหม่ ยังไม่ได้สร้าง module หรือย้าย source ในการตรวจนี้:

```text
src/                       CLI เดิม เก็บไว้ตามเดิม
mission/                   Mission domain types/schema/readsets/tools (A+B)
web/                       Web workspace และ public event (C+D)
supabase/migrations/        Schema, constraints, grants/RLS, atomic RPCs (A)
supabase/functions/         Mission API, runner, public API (A+D)
fixtures/workshop/         Brief/venues/costs และ expected outputs (B)
docs/                      API examples, evidence, setup instructions (ร่วมกัน)
```

ไม่ต้องเปลี่ยนทั้ง repo เป็น monorepoก่อนส่ง flow แรก แต่ต้องกำหนด import boundary และ schema กลางที่ browser/server ใช้ได้ หากเลือก Supabase Edge ให้ระวัง Node-specific imports ใน CLI

Contract ขั้นต่ำที่ต้องตกลง:

1. **Mission:** canonical inputs + revision/run/generation/stop_epoch + execution state + publishedBundleId
2. **Task:** key/readset/inputHash/status/attempt/claim/lease และ artifact refs; backend เป็นเจ้าของ state transitions
3. **Artifact:** kind/version/inputHash/outputHash/source provenance + content/schema; แยก structured facts จาก AI narrative
4. **Bundle:** immutable artifact manifest/checks + exact revision; public projection ใช้ชุดที่อนุมัติแล้ว
5. **Requests:** expectedRevision สำหรับ edit/publish, request ID สำหรับ signup, consistent error/required_user_action/retryable shape
6. **Security/cost:** owner มาจาก auth, tool scope มาจาก server, public field allowlist, quota reservation ก่อน dispatch

`publish` เป็น human-triggered operation; model ไม่มีสิทธิ์ประกาศผ่าน checks หรือสลับ published pointer เอง ไม่จำเป็นต้องขยาย stdio protocol เดิมให้รับทุก domain operation ตั้งแต่วันแรก

## 10. ลำดับรวมงานและเกณฑ์ปิดแต่ละช่วง

| ช่วง | สิ่งที่ต้องเห็น | งานที่ทำขนานได้ |
|---|---|---|
| 1 Contract + fixtures + access | Schema ร่วม, fixture คำนวณได้, provider smoke call, รู้ว่า U-Bot/audio ใช้สิทธิ์ใด | C วาง screens; D เปิด URL shell |
| 2 Vertical flow | Create → real AI/tools → persist artifacts → checks → preview → publish → mobile signup/receipt | A+B ทำ execution; C+D ต่อผลจริง |
| 3 จุดเด่นของสินค้า | เปลี่ยน 60→80 → capacity blocker → เลือก B → เฉพาะ outputs ที่เกี่ยวข้อง stale → review/publish ใหม่ | ทำ diff/decision UI พร้อม readsets |
| 4 Correctness / access / budget | Late result, stop, stale approval, two owners, lost response, last seat, caps ผ่าน | ทุกคนรับ tests ตาม owner |
| 5 Release evidence | URL จริง, fixture อีกหัวข้อ, ผู้จัดลอง, cost/call trace, integrations ที่เรียกจริง, deck ตรงรุ่น | Freeze scope และซ้อม flow |

หลักฐานขั้นต่ำที่ควรผูกกับ acceptance ใน `final-review.md`:

- T01–T07: สูตร, capacity, source changes, alternative brief และ invalid/missing inputs
- T08–T12: generation/lease/stop guards, exact approval และ old public version
- T13–T16: signup idempotency, conflicting payload, concurrent last seat และลด capacity
- T17–T22: owner isolation, direct-write forgery, prompt injection boundaries, quota, provider failures, XSS/CSV
- T23/T27/T28: persistence, keyboard/mobile errors และ deployed flow; T24 ต้องมีเฉพาะเมื่ออ้างทำงานต่อหลังปิดแท็บ
- T25–T26: audio freshness/cached playback เมื่อเลือกทำ ElevenLabs

**ควรพัก:** Pi/Claude expansion, managed native installs, hosted image Hub, multi-provider routing, arbitrary graph, parallel workers, desktop shell, VM, full history explorer และ Cron ถ้ายังไม่ผ่าน แกน Mission ไม่ต้องรอรายการเหล่านี้ แต่ต้องรักษา input validation/authorization/approval/signup correctness

## 11. คำแนะนำสำหรับก้าวถัดไป

ถ้าตัดสินใจยึด `final.md` เป็นเป้าหมาย ให้เริ่มที่ **Mission contract + workshop fixtures + deterministic budget/capacity tools + API examples** แล้วส่งชุด UX/UI ข้อ 8 ให้เพื่อน จากนั้นทำ vertical flow จนสมัครจากมือถือสำเร็จ ก่อนขยาย agent orchestration

ถ้ายังคงสินค้า CLI เดิม ให้เริ่ม **CLI-01/CLI-02** และส่ง `UI_PROTOCOL.md` ให้เพื่อนโดยระบุ Node host ที่ใช้ชัดเจน งานนี้เดินต่อจากแกนเดิมได้ ส่วน Mission OS เป็นขอบเขตใหม่ที่ต้องเลือกเพิ่ม ไม่ใช่งาน UI ที่ซ่อนอยู่

ไม่ประเมินความเสร็จเป็นเปอร์เซ็นต์รวม เพราะของที่ทำดีแล้วส่วนหนึ่งอยู่นอก Mission MVP และของที่ขาดบางส่วนเป็น security/transaction gates ที่นับเทียบจำนวนหน้าจอไม่ได้

## 12. ข้อจำกัดของการตรวจ

- ตรวจจาก source, package/scripts, เอกสารใน repo และไฟล์อ้างอิงสองไฟล์ ไม่แก้ implementation, ไม่รัน tests/benchmark/model calls ใหม่ และไม่ deploy
- ผล tests/benchmark ที่กล่าวถึงเป็นผลที่ repo บันทึกไว้ ไม่ใช่การรับรองว่ารันผ่านซ้ำในวันนี้
- ไม่ได้ตรวจบัญชี/API access/credits/hosting limits/เงื่อนไข partner หรือ rubric ออนไลน์ใหม่ ข้อมูลบริการและกติกาในไฟล์แนบถือเป็นข้อความของแผนที่ต้องยืนยันก่อนใช้จริง
- ยังไม่มีหลักฐาน Mission business flow ใน source ที่ตรวจ ห้ามนำ live coding/registry checks เดิมไปอ้างว่า Mission OS พร้อมเดโม
