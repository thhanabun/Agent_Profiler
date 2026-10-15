# ส่งต่อเพื่อน 1 — UX/UI ของ Mission OS

## เป้าหมายของงานคุณ

ทำเว็บที่ผู้จัด workshop ใช้ตั้งแต่สร้าง Mission ไปจนตรวจผลงาน แก้ข้อขัดแย้ง อนุมัติเปิดรับสมัคร และมีหน้าสมัครที่อ่านง่ายบนมือถือ

ทีมแบ่งสามคน: **คุณทำ UX/UI, เพื่อนอีกคนทำ Backend/API + DB, เจ้าของโปรเจกต์ทำ Core/AI** รวมถึง orchestrator, domain tools, dependency tracking และ U-Bot อย่าใช้ coding-session schema แทน Mission schema

รอบนี้รับงานบน local environment ก่อน งาน deploy/hosting/โดเมนอยู่ในรอบถัดไป ไม่ใช่เงื่อนไขรับงานของเพื่อนทั้งสองคน

## เริ่มงานจาก GitHub

Clone repo ลงเครื่องของตัวเอง แล้วสร้าง branch ของ UX/UI จาก `main`:

```sh
git clone https://github.com/thhanabun/Agent_Profiler.git
cd Agent_Profiler
git switch main
git pull --ff-only origin main
git switch -c feat/mission-ux-ui
npm ci
```

ใช้ branch นี้ทำงานทั้งหมดของคุณ อย่าทำ commit บน `main` และอย่าใช้ branch ร่วมกับ Backend

### สิ่งที่ต้อง implement ใน branch นี้

1. ย้าย template ปัจจุบันเป็น **React + TypeScript + Vite + Tailwind CSS + React Router** ตาม stack ด้านล่าง; คง `missionApi` boundary และ fixture เพื่อ preview ได้
2. สร้าง routes `/missions`, `/missions/:id`, `/events/:slug`; ทำ My Missions/create/intake confirmation และ Supabase login states
3. ทำ workspace: files/source versions, budget/agenda/event previews, task/decision states, draft revision และ published version
4. ทำ flow แก้ 60→80 และเลือกห้องจาก decision ที่ backend ส่งมา พร้อม error เมื่อ revision เปลี่ยน
5. ทำ review/diff ของ bundle และ public event/signup/receipt states; ต่อ access token กับ API client โดยไม่ใส่ server key ใน browser
6. ทำ responsive/mobile, keyboard/focus, labels, validation errors และ loading/empty/failed/stale states

ไฟล์หลักที่คุณเป็นเจ้าของคือ `web/**`, `package.json` และ `package-lock.json` สำหรับ frontend dependencies/scripts หากต้องเปลี่ยน `mission/contracts.ts` ให้ตกลงกับ Backend และเจ้าของ Core ก่อน เพราะเป็น contract กลาง

### ส่งงานกลับ

```sh
npm run typecheck:mission
npm run web:build
git status --short
git add web/ package.json package-lock.json
git commit -m "Build Mission workspace UI"
git push -u origin feat/mission-ux-ui
```

เปิด Pull Request จาก `feat/mission-ux-ui` เข้า `main` สรุปหน้าที่ทำ API ที่ต่อแล้ว และ states ที่ยังใช้ fixture; แนบภาพหน้าจอถ้าช่วยรีวิวได้ อย่าอ้างว่า flow จริงทำงานถ้ายังไม่ได้ต่อ API

## Stack ที่ใช้ทำต่อ

| ส่วน | Stack ที่เลือก | หน้าที่ |
|---|---|---|
| Web application | React + TypeScript | Components ของ create/workspace/review/public page |
| Build / dev server | Vite, React TypeScript template | Local dev พร้อม hot reload และ browser build |
| Styling | Tailwind CSS ผ่าน Vite plugin | Layout สามคอลัมน์, responsive, typography และ focus states |
| Routing | React Router | `/missions`, `/missions/:id`, `/events/:slug` |
| UI state | React hooks | Form values, selected artifact, pending decisions และ loading/error states |
| API transport | Native `fetch` ผ่าน `web/src/api.ts` | เรียก backend ตาม MissionApi และแปลง ApiResult/errors |
| Authentication | Supabase JavaScript client | Login/session/access token; เริ่ม email/password บน local ตาม backend |
| Validation | Zod + contracts กลาง | Validate form/response shapes ที่ตกลงร่วมกัน; server ต้อง validate ซ้ำ |
| Development | Node.js 24+ และ npm | สอดคล้องกับ runtime ของ repo เดิม |

**สถานะ:** ตารางนี้คือ stack เป้าหมายสำหรับเพื่อนทำต่อ โครงเว็บปัจจุบันยังเป็น HTML/CSS + browser TypeScript ยังไม่ได้ติดตั้ง ReactDOM, Vite, Tailwind, React Router หรือ Supabase client ในงานเว็บ ส่วน React/TypeScript/Zod ที่ root มีอยู่เพื่อ CLI แล้ว

งานตั้งต้นของ UX/UI คือย้าย template ใน `web/` เป็น React/Vite โดยคง MissionApi/fixtures/contracts เดิม จากนั้นตั้ง npm scripts และ lock dependency versions ให้ชัด ใช้ React/ReactDOM รุ่นที่เข้ากัน และตรวจ compatibility กับ dependencies ใน repo ก่อนเลือกเวอร์ชัน ไม่เพิ่มเลขเวอร์ชันที่ยังไม่ได้ติดตั้งลงเอกสารว่าใช้แล้ว

อ้างอิง setup: [Vite React TypeScript template](https://vite.dev/guide/), [Tailwind Vite integration](https://tailwindcss.com/docs/installation/using-vite)

## สถานะที่รับต่อ

| ส่วน | มีแล้ว | ข้อจำกัด |
|---|---|---|
| CLI เดิม | Profiles, OpenCode/Codex orchestration, sessions, image sharing, TUI และ stdio bridge | เป็น local coding workflow ไม่ใช่ Mission backend |
| Mission contract | `mission/contracts.ts`: inputs/status/task/artifact/bundle/public projection และ MissionApi interface | TypeScript types เท่านั้น ยังไม่มี runtime schema validation |
| ข้อมูลตัวอย่าง | `fixtures/workshop/brief.md`, `venues.csv`, `costs.csv`, `example.ts` | ตัวอย่าง UI เขียนมือ ไม่มี AI/DB/checks ที่รันจริง |
| UI template | Create form, workspace สามคอลัมน์, review placeholder, public mobile preview | ยังไม่มี routing, login, upload, editable fields หรือ real artifacts |
| API boundary | `web/src/api.ts` มี methods ตรง MissionApi | ทุก method throw NOT_IMPLEMENTED ไม่มี fake success |
| Backend template | มี SQL foundation และ Edge Function stubs | ยังไม่ deploy และ endpoints คืน 501 |

สิ่งที่เห็นบนหน้า template ไม่ใช่ผลการรัน การกด “แสดงข้อมูลตัวอย่าง” โหลด fixture ในหน่วยความจำ ไม่ persist หรือ publish อะไร

## เปิดโครงหน้าเว็บ

จาก root โปรเจกต์ หลังติดตั้ง dependencies เดิมด้วย `npm ci`:

```sh
npm run web:build
npm run web:serve
```

เปิด `http://127.0.0.1:5173` แล้วกด Ctrl+C เพื่อหยุด นี่เป็น local static preview ไม่มี hot reload; เมื่อแก้ TypeScript ให้ build ใหม่

คำสั่งข้างบนใช้กับ scaffold ปัจจุบันที่เป็น HTML/CSS + browser TypeScript ไฟล์ `web/tsconfig.json` แยกจาก CLI เมื่อย้ายเป็น React/Vite ตาม stack ที่เลือก ให้ปรับ scripts/entry points และคำสั่งในส่วนนี้ให้ตรงกับที่รันได้จริง

Preview server ใช้ explicit route allowlist ใน `web/serve.mjs` เมื่อเพิ่ม JavaScript module ที่ browser import ให้เพิ่ม route ด้วย หรือเปลี่ยนเป็น dev server ของ framework ที่เลือก

## ไฟล์ที่คุณเป็นเจ้าของ

```text
web/index.html             หน้าจอและ semantic structure
web/styles.css             Layout, responsive, focus และ visual design
web/src/main.ts            Startup, sample state และ create-form boundary
web/src/workspace.ts       Render current Mission/files/tasks
web/src/public-event.ts    Render public allowlisted event
web/src/api.ts             ร่วม backend เปลี่ยน stub เป็น authenticated HTTP client
```

อย่า import `src/engine.ts` หรือ native harness adapters เข้า browser ส่วน `mission/contracts.ts` เป็นไฟล์ร่วม ให้ตกลงการเปลี่ยนกับอีกสองคนก่อน ไม่ต้องแก้ DB migration หรือ task commit logic เพื่อให้ UI ดูสำเร็จ

## งานที่ต้องทำต่อ ตามลำดับ

### 0. ตั้ง frontend stack

- [ ] ย้าย `web/` เป็น React + TypeScript + Vite โดยเก็บ source/fixtures ที่มีไว้ใช้อ้างอิง
- [ ] ตั้ง Tailwind และแยก page/components จาก HTML template
- [ ] ตั้ง React Router ตาม routes ที่กำหนด และแยก public route ออกจาก owner workspace
- [ ] ต่อ Supabase auth session กับ fetch client โดยแชร์ API contract กับ backend
- [ ] อัปเดต scripts, dependency lock และวิธีรัน local; ขั้นนี้ยังไม่ต้องตั้ง hosting

### 1. Create / intake confirmation

- [ ] My Missions/list, new Mission และ login/logout states
- [ ] ใส่ goal, เลือกไฟล์จริง และแสดง error ของไฟล์ที่ไม่ผ่าน
- [ ] ปุ่มใช้ตัวอย่างส่งไฟล์ fixture ผ่าน intake จริงเมื่อ backend พร้อม ไม่ใส่ outputs สำเร็จรูป
- [ ] หน้ายืนยัน topic/audience/date/time/attendees/budget/venue พร้อมข้อมูลที่ยังขาดและแหล่งอ้างอิง
- [ ] Inputs จากแบบฟอร์มต้องผ่าน schema ฝั่ง server อีกครั้ง ไม่เชื่อเฉพาะ browser validation

### 2. Workspace

- [ ] ซ้าย: files/source/version; กลาง: budget/agenda/event previews; ขวา: tasks/decisions
- [ ] ใช้ artifact schema ที่ Core ส่งให้ ไม่ render `content: unknown` เป็น HTML ตามใจโมเดล
- [ ] แสดง draft revision และ published version แยกกัน
- [ ] มี states: empty/loading/running/needs_input/failed/retry/stopped/stale/unauthorized
- [ ] Status มาจาก API; polling ขณะ active ไม่สร้าง AI calls และไม่แต่ง progress percentage

### 3. เปลี่ยนข้อมูลและแก้ข้อขัดแย้ง

- [ ] เปลี่ยน 60→80 แล้วเห็นห้อง A รับได้ 60 พร้อมทางเลือกห้อง B จากข้อมูลจริง
- [ ] แสดงงบของตัวเลือกและ outputs ที่ต้องอัปเดต/ใช้ต่อได้
- [ ] ส่ง expectedRevision ทุกครั้งที่แก้ Mission; เมื่อ conflict ให้ refresh และอธิบายว่าอะไรเปลี่ยน
- [ ] ยังไม่มี decision-submit/upload API ใน interface: ตกลง request shape กับ Core/backend ก่อนทำ interaction จริง

### 4. Review / publish และ public UI

- [ ] Render checks/diff ของ exact bundle, ปุ่ม “อนุมัติและเปิดรับสมัคร” และ pending/error states
- [ ] ส่ง bundleId + expectedRevision; ห้ามถือว่ากดแล้วสำเร็จทันที
- [ ] แยก public route ที่โหลด PublishedEvent เท่านั้น ไม่ส่ง MissionState ลง public page
- [ ] สมัคร: nickname, submitting, receipt, full, bundle changed และ retry states
- [ ] เก็บ clientRequestId เดิมไว้ตลอดการ retry คำขอสมัครเดิม; payload ใหม่ต้องใช้ ID ใหม่
- [ ] แสดง receipt หลัง server ยืนยัน commit; owner เห็นจำนวนสมัครและดาวน์โหลด CSV ผ่าน API
- [ ] Audio เป็นงานเสริมเมื่อ Core/backend ต่อสิทธิ์และ artifact แล้ว ต้องมีข้อความทดแทน

### 5. UX / accessibility

- [ ] ใช้ keyboard ได้ครบ, focus หลัง error/modal ถูกต้อง, label/error ผูก fields
- [ ] รองรับมือถือและ browser zoom โดยไม่บังปุ่มหรือข้อมูลจำเป็น
- [ ] Escape ข้อความที่มาจากไฟล์/AI/ผู้ใช้; template ปัจจุบันใช้ textContent
- [ ] คนจัด workshop ทดลอง flow ได้โดยไม่ต้องบอกทุกคลิก บันทึกจุดติดและเวลาที่ใช้

## API ที่ต้องตกลงกับเพื่อน backend

ใช้ชื่อ methods ใน `MissionApi` เป็นหลัก: list/create/get/update/start/cancel/approveAndPublish/getPublishedEvent/submitRegistration/exportRegistrations

- Wire format: `ApiResult<T>` และ error.code ที่แยก REVISION_CONFLICT / BUNDLE_CHANGED / CAPACITY_FULL / IDEMPOTENCY_CONFLICT
- Backend รับผิดชอบ JWT/owner authorization; UI client ต้องแนบ access token โดยไม่ใส่ service credentials
- JSON ใช้ camelCase ตาม contract; DB เป็น snake_case ให้ backend เป็นคน map
- ตกลงเพิ่ม upload/confirmation/decision contracts และ kind-specific artifact schemas ก่อนต่อหน้าที่เกี่ยวข้อง
- เขียน response fixtures สำหรับ error/loading ได้ แต่ต้องติดป้าย development sample และไม่อ้างว่าเป็น live integration

## เงื่อนไขรับงาน

เริ่มจาก fixture จริง → ยืนยันข้อมูล → เห็น outputs จาก API → เปลี่ยน 60 เป็น 80 → เลือกห้อง B → ดู checks/diff → อนุมัติ → เปิด public page → สมัครและเห็น receipt จริง โดยแสดง errors/retry ได้ ทดสอบบน local frontend + local Supabase และเปิด public route จาก browser session ที่ไม่ได้ login เจ้าของได้

UI shell เสร็จแยกจาก flow จริงเสร็จ การย้ายข้อความ fixture ลงหน้าสวยไม่ถือว่าผ่าน acceptance

## สิ่งที่ต้องรอจากอีกสองคน

- Backend: endpoint routes, local Supabase URL, auth integration, response examples และ access errors
- Core: runtime schemas, extracted facts, artifacts, decisions, affected/reused outputs, checks และ U-Bot behavior
- อย่ารอทั้งหมดค่อยเริ่ม: ทำ layout/state/error views จาก fixtures ก่อน แล้วรวม API ตั้งแต่ vertical flow แรก

## สิ่งที่ยังไม่รับรอง

โครงนี้ยังไม่มี browser usability/accessibility test, public hosting หรือ Mission E2E ที่ผ่านจริง ส่วน native CLI tests เดิมไม่ได้ครอบคลุมเว็บนี้

Deploy และการทดสอบจากมือถือผ่าน public URL เป็นงานภายหลัง ไม่ต้องทำในรอบส่งต่องานนี้
