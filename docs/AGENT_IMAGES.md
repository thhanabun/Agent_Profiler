# Agent images และ Hub: ทิศทางสินค้า

สถานะ: research วันที่ 2026-10-15 และเริ่ม implement MVP แล้ว ดู [คู่มือใช้งานจริง](IMAGES.md) และ [ผลทดสอบ](TESTING.md) เพื่อแยกส่วนที่ทำได้จากเป้าหมายระยะถัดไป

## ประสบการณ์ที่ต้องการ

ค้นหา setup ของคนอื่น → ตรวจส่วนประกอบ → pull image → เปิดใช้ด้วยบัญชีของตัวเอง → ปรับแต่งจาก base → build/push เป็น image ของตัวเอง → แชร์ image หรือทีมให้คนอื่นใช้ต่อ

CLI/TUI เป็นหน้าจอหลักทั้งหมด: ซ้าย flow, กลางแชต, ขวารายละเอียด image/งาน/diff การมี registry backend ไม่ได้หมายถึงต้องทำเว็บ frontend

เป้าหมายคือให้คนแชร์ setup ที่ประกอบไว้แล้วได้ง่าย โดยรู้แน่นอนว่าได้ส่วนประกอบเวอร์ชันไหน Orchestrator ที่มีอยู่ใช้ images เหล่านี้เป็นผู้ทำงานในแชตเดียว

## สิ่งที่ Hermes มีแล้ว

- [Profile distributions](https://hermes-agent.nousresearch.com/docs/user-guide/profile-distributions) แจกทั้ง agent ผ่าน Git พร้อม persona/config/skills/plugins/MCP และแยก credentials กับ runtime state ออกจาก distribution ได้แล้ว มี export/import อีกทางด้วย
- [Skills Hub](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills) ค้นหาและติดตั้ง skills จากหลายแหล่ง
- [Kanban](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban) แบ่งงานและ route ไปยัง profiles ตาม description พร้อม model settings ของแต่ละ profile
- [OpenCode skill](https://hermes-agent.nousresearch.com/docs/user-guide/skills/bundled/autonomous-ai-agents/autonomous-ai-agents-opencode) เรียก native OpenCode worker ได้แล้ว และมี [agent-batch plugin](https://hermes-agent.nousresearch.com/docs/plugins/agent-batch) สำหรับงาน coding หลายงาน

ดังนั้น export/import, marketplace ของ skills และการ delegate ข้าม CLI เป็นสิ่งที่ทับซ้อนอยู่แล้ว จุดต่างที่เสนอต่อไปนี้เป็นการเลือกออกแบบสินค้า ไม่ใช่ข้อสรุปว่าไม่มีเครื่องมืออื่นทำได้

## นำแนวคิด Docker มาใช้ตรงไหน

| แนวคิด | Agentpack/WorkerDeck ที่เสนอ |
| --- | --- |
| Build recipe | `profile.json` และ source ที่แก้ด้วย editor ได้ ไม่เพิ่มภาษา Agentfile ใน MVP |
| Image | artifact ที่แก้ไม่ได้หลัง build พร้อม resolved manifest และ lockfile |
| Tag / digest | ชื่ออ่านง่ายสำหรับค้นหา; ทุก run ล็อก digest ของเนื้อหาที่ resolve จริง |
| FROM | ต่อยอด base image ของ harness เดียวกัน แล้วเพิ่ม skill/plugin หรือเปลี่ยน default model |
| Container / instance | native session ที่สร้างจาก image; state และ credentials อยู่ในเครื่องผู้ใช้ |
| Hub | ค้นหา ตรวจ dependencies อ่าน README/ที่มา แล้ว pull/push ผ่าน CLI |
| Compose | team manifest ระบุ orchestrator และ worker images; lock ทุกตัวเป็น digest แล้วให้ orchestrator เลือกงานเอง |

Image identity กับ instance state ต้องแยกกัน: คนสองคนใช้ image เดียวกันได้ แต่มีบัญชี, memory และ native sessions คนละชุด การกลับไปใช้ profile เดิมในแชตเดิม resume instance เดิม; การเปิดใหม่สร้าง instance ใหม่

## ขอบเขตของ image

หนึ่ง image ผูกกับ native harness เดียว ประกอบด้วย:

- harness version และ adapter version ที่รองรับ;
- model/provider reference และ settings ที่รองรับ โดยระบุชัดว่าเป็น snapshot ID หรือ alias ที่เปลี่ยนปลายทางได้;
- instructions, skills และ native plugin sources;
- resolved dependency versions/revisions/checksums รวมถึง parent digest ถ้ามี;
- platform/prerequisites, env variable names และ integrations ที่ต้อง authenticate;
- capabilities สำหรับให้ orchestrator route งาน และ README/source metadata สำหรับให้คนตรวจ

ไม่บรรจุ remote model weights, API keys, OAuth tokens, user memory หรือ conversation history ตัว image ใน MVP เป็น OCI artifact สำหรับ native runner ไม่ใช่ container filesystem และไม่สร้าง OS sandbox ให้เอง

สิ่งที่ทำซ้ำได้คือเนื้อหา setup และ dependency identity ที่ล็อกไว้ ไม่รับประกันคำตอบ AI เหมือนเดิมทุกครั้ง provider aliases, remote services, OS และ project/user config ยังมีผล ต้องแสดง overlays ที่ใช้จริงและหยุดเมื่อ runtime/dependency ที่ต้องล็อกไม่ตรง แทนการแอบใช้เวอร์ชันอื่น

## ความต่างที่ผู้ใช้สัมผัสได้

1. **ใช้ setup ของคนอื่นทั้งชุด:** ค้นหา UI specialist, ดู native harness/model/skills/plugins/prerequisites ในหน้ารายละเอียดเดียว แล้ว pull/run
2. **ต่อยอด base image:** เพิ่ม skill ของแบรนด์ตัวเองโดยเก็บ parent digest และแสดง diff จากต้นทาง build ออกมาเป็นชื่อของตัวเองได้ การสืบทอดใน MVP มี parent เดียวและต้องเป็น harness เดียวกัน; dependency/file ชนกันต้องให้ผู้สร้างเลือกแก้
3. **แชร์ทั้งทีม:** ส่ง team manifest กับ lockfileให้เพื่อน แล้วใช้ทีม Builder/Designer ชุดเดียวกันจาก CLI โดย orchestrator จัดงานให้เอง ไม่ต้องให้เพื่อนไปประกอบทุก profile ใหม่
4. **รู้ว่าอะไรเปลี่ยน:** แสดงความต่างของ model, skills, plugin revisions และ runtime requirements ระหว่าง image versions ก่อนอัปเดต เวอร์ชันเดิมยังถูกเรียกด้วย digest ได้ โดยไม่ย้อนคืนไฟล์โปรเจกต์หรือรับประกัน native-session migration

## วงจรใช้งานเป้าหมาย

คำสั่งด้านล่างมีใน CLI แล้ว การ push/pull ต้องติดตั้ง ORAS และมีสิทธิ์ของ registry ที่เลือก:

```sh
workerdeck search "frontend"
workerdeck inspect community/ui:1.0.0
workerdeck pull community/ui:1.0.0
workerdeck run community/ui:1.0.0 --cwd ./project

workerdeck fork community/ui:1.0.0 --to ./my-ui
# Edit profile.json and add a local brand skill.
workerdeck build ./my-ui --tag thana/ui:1.0.0
workerdeck push thana/ui:1.0.0

workerdeck team run ./team.json --cwd ./project
```

ชื่อคำสั่ง CLI คือ `workerdeck`; ไฟล์ profile bundle ยังคงใช้นามสกุล `.agentpack`

## Registry ที่ทำได้โดยไม่สร้าง blob storage ใหม่

[Docker Hub รองรับ OCI artifacts](https://docs.docker.com/docker-hub/repos/manage/hub-images/oci-artifacts/) และ [ORAS มี push/pull สำหรับ artifacts](https://oras.land/docs/how_to_guides/pushing_and_pulling/) จึงเสนอให้ใช้ OCI registry เก็บ manifest/bundle จริง โดยเริ่มจาก registry ที่มีอยู่แล้วและให้ CLI ติดต่อผ่าน ORAS ตรวจ auth/registry compatibility ก่อนเลือกปลายทางจริง

แนวทางนี้ใช้ Docker Hub/GHCR เป็น storage transport ได้ แต่ไม่ได้ทำให้ custom artifact ใช้ `docker run` ได้ และไม่ทำให้ทุก registry มี full-text search ให้อัตโนมัติ Hub discovery ยังต้องมี metadata index สำหรับชื่อ, harness, tags, source และ prerequisites ซึ่งแสดงใน TUI ได้

Tag อาจเปลี่ยนปลายทางได้ตาม registry policy; CLI ต้อง resolve และบันทึก digest เสมอ ไม่อ้างว่า tag ทุกตัว immutable ดู [Docker digest pinning](https://docs.docker.com/reference/cli/docker/image/pull/) และ [tag immutability](https://docs.docker.com/docker-hub/repos/manage/hub-images/immutable-tags/)

## ลำดับ MVP

1. **Build/inspect/run image ในเครื่อง:** ใช้ bundle validation เดิม เพิ่ม exact runtime/dependency lock และ content-addressed store รองรับ parent เดียวสำหรับ derive และใช้ adapters สองตัวเดิม
2. **Push/pull จริง:** ส่ง artifact ผ่าน OCI registry ที่เลือก ตรวจ digest/archive ก่อนติดตั้ง เก็บ local auth แยก ใช้ trust ตาม resolved content ก่อน execute
3. **Hub ใน terminal:** catalog metadata และ search/filter; หน้า image แสดงส่วนประกอบ, source, parent, prerequisites และสถานะการตรวจที่มีหลักฐาน ไม่เรียกทุกแพ็กว่า verified
4. **แชร์ทีม:** team manifest + digest lock เชื่อมเข้ากับ engine เดิมในแชตสามช่อง ไม่มี orchestrator framework อีกชุด

เดโมหลัก: เครื่อง/โฟลเดอร์ผู้สร้าง build และ push UI image → ผู้รับ pull/run ด้วยบัญชีของตน → fork เพิ่ม brand skill → build/push เป็นชื่อใหม่ → ใช้ image นี้ในทีม Builder/Designer และส่งงานกลับในแชตเดิม

ตัดออกจากรอบนี้: web frontend, container runtime, การย้าย live conversation ข้าม image เวอร์ชัน, parallel worktrees, automatic online image selection และ Pi adapter (Codex ถูกเพิ่มตามคำขอล่าสุดแล้ว)

## เทียบกับโค้ดปัจจุบัน

มีแล้ว: CLI/TUI, local profiles, source bundle export/import พร้อม file checksums, trust, orchestrator, native sessions, สาม adapters (OpenCode/Codex/Claude), OCI image build/inspect/run/diff, fork พร้อม parent digest, ORAS push/pull, shared catalog search และ team lock/pull/run

MVP ล็อก harness/adapter SDK version, platform และไฟล์ source ที่บรรจุในแพ็ก; ยังไม่ resolve dependencies ภายนอกหรือติดตั้ง runtime ให้อัตโนมัติ การ derive เป็นสำเนา source เต็มที่อ้าง parent digest ยังไม่มี lazy filesystem layers คำว่า `profile.lock.json` ยังเป็น file integrity hashes ส่วน runtime requirements อยู่ใน OCI image config

OpenCode ↔ Codex ผ่าน live handoff, native resume และ Codex planning แล้ว ดู [ผลทดสอบ](TESTING.md) ส่วน Codex bundled plugins ยังไม่รองรับ

ยังไม่มี hosted public catalog/account service; ใช้ไฟล์/HTTPS catalog และ OCI registry ที่เลือกได้ Claude live test ยังต้อง refresh OAuth ส่วน `setRawMode EPERM` ตอนปิด Windows TUI แก้ด้วยการ retry cleanup เฉพาะ error นี้หนึ่งครั้งแล้ว โดย `/quit` และ Ctrl+C ผ่านการทดสอบเปิด terminal จริงและออกด้วย code 0
