# ส่งต่อเพื่อน 2 — Backend/API + Database

## เป้าหมายของงานคุณ

ทำ backend ที่บันทึก Mission และ outputs จริง คุมสิทธิ์เจ้าของ เปิดเผยเฉพาะข้อมูลที่อนุมัติแล้ว และรับสมัครอย่างถูกต้อง โดยให้ frontend ต่อใช้งานบน local environment ได้ก่อน

ทีมแบ่งสามคน: **คุณทำ backend/DB/API, เพื่อนอีกคนทำ UI ทั้ง workspace/public, เจ้าของโปรเจกต์ทำ Core/AI** คุณไม่ต้องเขียน native harness adapter หรือ prompt ใหม่ แต่รับผิดชอบ authorization และ atomic state transitions ร่วมกับ Core

รอบนี้ยังไม่ทำ deploy/hosting/โดเมน และไม่ต้องสร้าง cloud project เพื่อให้ผ่านเงื่อนไขรับงาน

## เริ่มงานจาก GitHub

Clone repo ลงเครื่องของตัวเอง แล้วสร้าง branch ของ Backend จาก `main`:

```sh
git clone https://github.com/thhanabun/Agent_Profiler.git
cd Agent_Profiler
git switch main
git pull --ff-only origin main
git switch -c feat/mission-backend-local
```

ใช้ branch นี้ทำงานของ Backend อย่าทำ commit บน `main` และอย่าใช้ branch ร่วมกับ UX/UI; งานรอบนี้ใช้ Supabase local ไม่ deploy

### สิ่งที่ต้อง implement ใน branch นี้

1. ตั้ง Supabase CLI/local stack (`supabase init` เมื่อยังไม่มี `config.toml`, แล้ว `supabase start`); ห้ามใช้ `db reset` กับข้อมูลที่ต้องเก็บ
2. ตรวจและใช้ migration ใน `supabase/migrations/`; ทำให้ owner อ่านงานตัวเองได้ ขณะที่ข้อมูล private และ child tables ต้องผ่าน authorization ฝั่ง server
3. ทำ JWT verification, Zod/request validation และ mission routes ตามตารางในเอกสารนี้; สร้าง API examples ให้เพื่อน UI ใช้
4. ทำ upload/download ใน private storage พร้อมตรวจ owner, path, MIME/size/hash และให้ migration/DB สร้าง file revisions ที่อ่านย้อนหลังได้
5. ทำ expectedRevision, task claims/leases, cancel/late-result guards และ atomic artifact/task commit ร่วมกับเจ้าของ Core
6. ทำ publish และ signup transactions: exact bundle, idempotent receipt, stale bundle, capacity/last-seat race และ owner-only CSV
7. ทำ local owner/API/public flow ให้ UI ต่อได้; **ยังไม่ทำ hosting, public URL, domain หรือ deploy cloud functions**

ไฟล์หลักที่คุณเป็นเจ้าของคือ `supabase/**`, `.env.example` ภายใน `supabase/` และเอกสารวิธีรัน local หากต้องเปลี่ยน `mission/contracts.ts`, `web/src/api.ts` หรือ root package manifests ให้ตกลงกับอีกสองคนก่อน การต่อ model provider/domain tools เป็นงานร่วมกับเจ้าของ Core; ตัด U-Bot ออกจากขอบเขตเพราะไม่มีระบบให้เชื่อม

### ส่งงานกลับ

```sh
supabase start
supabase status
supabase test db
git status --short
git add supabase/
git commit -m "Build local Mission API and database"
git push -u origin feat/mission-backend-local
```

เปิด Pull Request จาก `feat/mission-backend-local` เข้า `main` ระบุ migration/วิธีรัน local, endpoints ที่ทำจริง, DB tests ที่ผ่าน และ API ที่ยังเป็น 501 ห้ามแนบ `.env`, keys, Supabase access tokens หรือข้อมูลสมัครจริง

## Stack ที่ใช้ทำต่อ

| ส่วน | Stack ที่เลือก | หน้าที่ |
|---|---|---|
| Backend platform | Supabase | รวม Auth, PostgreSQL, Storage และ Edge Functions |
| Database | PostgreSQL + SQL migrations | Missions/revisions/tasks/artifacts/bundles/registrations และ constraints |
| Transactions | PostgreSQL functions/RPCs | Claim/complete/cancel/publish/signup แบบ atomic และตรวจ revision/lease |
| API / runner | Supabase Edge Functions, Deno + TypeScript | Owner API, internal runner และ public event API |
| Database/Auth client | Supabase JavaScript client | Verify user และเรียก DB/Storage; server credentials อยู่เฉพาะ backend |
| Authentication | Supabase Auth | เริ่ม email/password สำหรับ local; API ตรวจ verified identity และ owner |
| File storage | Supabase Storage private bucket `mission-files` | เก็บ input file versions พร้อม authorized upload/download |
| Validation | Zod + contracts กลาง | Runtime validation ของ request/output ร่วมกับ Core และ UI |
| Local development | Supabase CLI + Docker Desktop | รัน DB/Auth/Storage/Functions บนเครื่องก่อน |
| Shared tooling | Node.js 24+ และ npm | ใช้กับ repo/CLI/frontend; Edge handlers ใช้ Deno runtime |

**สถานะ:** มีเพียง SQL และ Edge Function stubs ยังไม่มี Supabase client/Zod validation/config ของ backend ที่ต่อใช้งานจริง ตารางนี้คือ stack ที่เลือกให้ทำต่อ ให้ pin dependencies/import versions เมื่อเริ่มติดตั้ง และ commit lock/config ที่เหมาะสมโดยไม่ใส่ secrets

Frontend ใช้ **React + TypeScript + Vite + Tailwind CSS + React Router** และเรียก MissionApi ผ่าน fetch; คุย wire contract กับเพื่อน UI ก่อนเปลี่ยน fields/statuses

รูปแบบ local ที่ต้องได้: `React/Vite → local Edge Functions → local PostgreSQL/Storage/Auth` ส่วน runner เรียก Core/provider ที่ทีมมีสิทธิ์เมื่อ integration พร้อม การรัน infrastructure บนเครื่องไม่ได้ทำให้ model calls เป็น offline หรือไม่มีค่าใช้จ่าย

อ้างอิง: [Supabase local development](https://supabase.com/docs/guides/local-development), [Edge Functions / TypeScript runtime](https://supabase.com/docs/guides/functions)

## สิ่งที่มีแล้ว

| ส่วน | ไฟล์ | สถานะจริง |
|---|---|---|
| Contract กลาง | `mission/contracts.ts` | Types + method names; ยังต้องเพิ่ม runtime schemas |
| DB foundation | `supabase/migrations/202610160001_mission_template.sql` | DDL template 7 tables, FKs/checks, RLS/grants, private bucket; ยังไม่ได้ apply |
| Owner read ตัวอย่าง | policy บน missions | อนุญาต authenticated owner SELECT เฉพาะ missions; child tables ยัง server-only |
| Owner API stub | `supabase/functions/mission-api/index.ts` | คืน 501 ทุกคำขอ ไม่มี routing/auth/business operations |
| Runner stub | `supabase/functions/runner/index.ts` | คืน 501 ไม่มี model call/claim/commit |
| Public API stub | `supabase/functions/public-event/index.ts` | คืน 501 ยังไม่เปิดเผยข้อมูลหรือรับสมัคร |
| Error envelope | `supabase/functions/_shared/not-implemented.ts` | `{ ok: false, error: ... }` ไม่ส่ง fake success |
| Server env example | `supabase/.env.example` | Placeholder เท่านั้น ไม่มี keys/config/account |
| UI boundary | `web/src/api.ts` | ตรง MissionApi แต่ยัง throw NOT_IMPLEMENTED |
| Fixtures | `fixtures/workshop/` | Source examples + expected arithmetic; ไม่ใช่ DB seed หรือผลตรวจจริง |

**ยังไม่มี** Supabase project/config.toml, migrations ที่รันผ่าน, login, deployed functions, RPCs, provider integration, quota ledger, events, signup correctness หรือ live hosting

## ขอบเขตไฟล์

```text
supabase/migrations/            DB, grants/RLS และ transactional RPCs
supabase/functions/mission-api/ Owner-scoped API + storage actions
supabase/functions/runner/      ร่วม Core ทำ claim/dispatch/guarded completion
supabase/functions/public-event/Published projection + signup
supabase/functions/_shared/     Auth, validation, DB mapping, response helpers
supabase/.env.example           Server-only configuration names
web/src/api.ts                 ร่วม UI ทำ transport/token/error integration
mission/contracts.ts           สัญญาร่วม เปลี่ยนแล้วแจ้งทั้งทีม
```

## 1. ตั้ง development environment และ DB

- [ ] ติดตั้ง Supabase CLI และ Docker Desktop แล้วรัน `supabase init` เมื่อยังไม่มี config; ตั้ง local stack และบันทึกวิธี start/stop
- [ ] ใช้ `supabase start` และอ่าน URL/keys จาก `supabase status`; ให้ UI ใช้ค่าของ local stack เท่านั้นในรอบนี้
- [ ] ตรวจ migration ในไฟล์ก่อน apply ห้ามใช้ reset กับ DB ที่มีข้อมูลที่ต้องเก็บ
- [ ] Migration นี้สร้างตารางและ bucket ชื่อใหม่ ไม่รองรับชนกับของเดิม; ใช้ dev project ที่ตรวจแล้ว
- [ ] เก็บ URL/server credentials ใน server environment; `.env.example` ไม่ถูกโหลดอัตโนมัติ
- [ ] เพิ่ม DB tests สำหรับ schema/RLS/transactions ก่อนอ้างว่าพร้อม ยังไม่มีการรัน DB ใน template รอบนี้
- [ ] Browser/public ได้เฉพาะ owner SELECT บน missions ตาม policy; child reads/writes ต้องผ่าน API ที่ตรวจ owner
- [ ] service_role ข้าม RLS ได้ ทุก handler ที่ใช้ต้องตรวจ owner จาก verified identity ไม่เชื่อ owner_id จาก body
- [ ] Private bucket ยังไม่มี storage.objects policies; ทำ authorized upload/download พร้อมตรวจ policy เดิมของ project

ตารางตั้งต้น: missions, mission_revisions, mission_files, mission_tasks, mission_artifacts, mission_bundles, mission_registrations

สิ่งที่มีเพียง columns ยังไม่ใช่ logic: revision/input snapshots ยังไม่มี enforcement ว่าแก้ทับไม่ได้, claim/lease ยังไม่ทำงาน, updated_at ยังไม่มี update mechanism และ constraints ยังไม่ตรวจ canonical JSON ทั้งหมด ต้องเพิ่ม RPCs/validation โดยไม่เปิด browser writes กว้าง

## 2. Owner API / storage

เริ่มจาก HTTP routes ที่ map ชื่อใน MissionApi (ชื่อ routes ด้านล่างเป็นข้อเสนอ ยังไม่ได้ implement):

| Function | Route / operation | กติกา |
|---|---|---|
| mission-api | GET/POST `/missions`, GET `/missions/:id` | verified user และ owner-only |
| mission-api | PATCH `/missions/:id` | expectedRevision, validate canonical inputs, สร้าง immutable revision |
| mission-api | POST `/missions/:id/start` | ตรวจ revision, quota และ dispatch ที่ Core รองรับ |
| mission-api | POST `/missions/:id/cancel` | expectedRevision + expectedStopEpoch และ atomic cancellation |
| mission-api | POST `/missions/:id/publish` | human owner, exact bundleId/revision, checks ปัจจุบัน |
| mission-api | GET `/missions/:id/registrations.csv` | owner-only, neutralize CSV formulas |
| public-event | GET `/:slug` | allowlisted published fields เท่านั้น |
| public-event | POST `/:slug/registrations` | nickname + clientRequestId + seenBundleId, transaction/rate limit |
| runner | POST internal operation | internal credential ที่ตกลง ไม่เปิดให้ visitor ส่งผลสำเร็จเอง |

เพิ่ม slug/public projection ที่ DB/API ตามที่ตกลง ตอนนี้ migration ยังไม่มี slug column/table ใช้งานจริง

- [ ] Runtime schemas สำหรับ bodies/params/provider outputs รวม integer bounds/date/time และ CSV headers
- [ ] CamelCase wire contract ↔ snake_case DB mapping
- [ ] จำกัด methods/body/file size, UTF-8 text, `.md/.txt/.csv` 200,000 bytes ต่อไฟล์ และขนาดรวมก่อนส่ง AI
- [ ] ตกลง upload/confirm/decision APIs เพิ่มกับ UI/Core; ใน MissionApi ยังไม่มี operations เหล่านี้
- [ ] Storage paths ต้อง derive จาก owner/mission/revision ฝั่ง server และตรวจ bytes/hash หลัง upload ก่อนใช้งาน
- [ ] JWT verification, CORS origin allowlist, consistent ApiResult errors และ rate limits
- [ ] Public endpoint ไม่คืน source brief, internal budget, registration lists หรือ task claim tokens

## 3. ขอบเขตร่วมกับ Core/AI

**Core ส่งให้:** intake/output runtime schemas, canonical facts, fixed task graph/readsets, model-provider boundary, domain tool results และ deterministic artifact checks

ความคืบหน้าบน branch `agent`: `mission/domain.ts` ตรวจ WorkshopInputs/CSV/งบ/ความจุและวางแผน invalidation; `mission/artifacts.ts` ตรวจหลักฐาน intake, schemas ของ budget/agenda/event และผลเช็ก output; `mission/agent.ts` หยุดก่อนเรียกโมเดลเมื่อ budget/capacity ไม่ผ่าน และใช้ provider callback เมื่อผ่าน มี automated tests สำหรับ acceptance cases แล้ว แต่ยังไม่มี model-provider adapter หรือการเรียก runner จริง Backend ต้องตรวจ request ฝั่ง Edge และบังคับ readset/commit guards ใน DB

**คุณบังคับที่ DB/API:** ownership, quota admission, immutable snapshots, revision/run/generation/stop_epoch, lease/claim, atomic artifact+task completion และ publish/signup rules

- [ ] Claim task แบบ atomic พร้อม token/lease/attempt; reserve quota ก่อน provider dispatch
- [ ] Completion transaction ตรวจ claim token, lease, generation, stop_epoch, snapshot/input hash แล้ว insert artifact/update task/events ใน transaction เดียว
- [ ] Edit/cancel ทำให้ late outputs เขียนทับ current draft ไม่ได้; ไม่ลบ usage ของ calls ที่ส่งไปแล้ว
- [ ] Add events + provider_attempts/quota ledger migrations; foundation ยังไม่มีสามส่วนนี้
- [ ] กำหนด retries/timeouts/caps จริงของบัญชี และ internal auth ก่อนเปิด runner
- [ ] อย่ารัน Node/native CLI engine ใน Edge ตรง ๆ; native login บนเครื่องพัฒนาไม่ใช่ server credential

## 4. Publish / signup: ส่วนที่ต้องเป็น transaction

- [ ] Publish ตรวจ owner, expectedRevision, exact bundle, server-computed checks และ artifact freshness
- [ ] Draft edit ไม่แก้ public pointer จนอนุมัติรุ่นใหม่
- [ ] Signup กับ publish ใช้ lock ของ event/Mission เดียวกัน: capacity ลดต่ำกว่าผู้สมัครเดิมไม่ได้
- [ ] Signup หา receipt ของ `(mission_id, client_request_id)` ก่อนเช็ก bundle/capacity ล่าสุด; payload เดิมคืน receipt เดิมแม้เต็มแล้ว
- [ ] Key เดิมแต่ nickname/payload ต่างคืน IDEMPOTENCY_CONFLICT; กำหนด normalization ก่อนเปรียบเทียบ
- [ ] Fresh signup ที่เห็น bundle เก่าคืน BUNDLE_CHANGED; concurrent last seat รับได้หนึ่งคน
- [ ] Count ทุก registration ของ Mission ไม่ reset ตาม bundle; success หลัง commit เท่านั้น
- [ ] จำกัด request rate และ export เฉพาะ owner; public visitors ไม่อ่านตารางตรง

Unique constraint ใน migration ช่วยกัน request ซ้ำ แต่ **ยังไม่ใช่** idempotent receipt logic หรือ capacity enforcement

## 5. Local integration

- [ ] ส่ง local API URL, auth setup, env variable names และตัวอย่าง request/response ให้เพื่อน UI
- [ ] Frontend ใช้ Supabase public configuration กับ user access token; server credentials/provider keys อยู่ฝั่ง backend
- [ ] ตั้ง CORS allowlist ให้ตรง origin ของ Vite ที่ใช้จริง และทดสอบ owner/public routes แยก session
- [ ] ทำวิธีรัน local DB + Functions + frontend ที่ทำตามได้ ห้าม reset DB ที่มีข้อมูลต้องเก็บโดยไม่ตรวจ
- [ ] ไม่ต้องทำ U-Bot integration; ไม่มีระบบ/API ให้เชื่อม ส่วน ElevenLabs/audio ยังเป็นงานเสริมแยกจาก Core flow
- [ ] Audio ผูก source script/bundle hash และ cached playback; อย่า regenerate ต่อ page view
- [ ] ถ้ายังไม่มี scheduler ที่พิสูจน์แล้ว ให้สื่อว่า resume เมื่อกลับมา ห้ามอ้างว่าปิดแท็บแล้วทำต่อแน่นอน

## ภายหลัง — Deployment (พักไว้ ยังไม่ใช่งานรอบนี้)

- [ ] วาง static web build บน hosting ที่ทีมเลือก; ตอนนี้ไม่มี Pages/Vercel config หรือ live URL
- [ ] รอ frontend ย้ายเป็น React/Vite และยืนยัน build output/scripts ก่อนตั้ง hosting; scaffold ปัจจุบันยังใช้ TypeScript compiler + static preview
- [ ] `web/serve.mjs` เป็น loopback preview ไม่ใช่ production API/server และไม่ต้อง deploy มัน
- [ ] Deploy function + DB แบบแยก environment; owner endpoints คง authentication ส่วน public endpointsต้อง validate published-only behavior ก่อนเปิด

อ้างอิงที่ใช้วาง foundation: [Supabase RLS/grants](https://supabase.com/docs/guides/database/postgres/row-level-security), [Edge Functions](https://supabase.com/docs/guides/functions/quickstart), [Storage access control](https://supabase.com/docs/guides/storage/security/access-control) ยังไม่ได้ยืนยัน account/hosting quota ของทีม

## เงื่อนไขรับงาน

1. Owner A สร้างงาน/reload ได้; B อ่าน/เขียนไฟล์และ outputs ของ A ไม่ได้
2. UI เปลี่ยนข้อมูลได้ด้วย expectedRevision และผลจาก worker เก่าถูกปฏิเสธ
3. Publish ที่ถูก revision เท่านั้น; draft ใหม่ไม่เปลี่ยน public รุ่นเดิม
4. Public route บน local สมัครจาก browser session ที่ไม่ใช่เจ้าของได้จริง คืน receipt, count และ owner CSV ตรง DB
5. Lost response/retry, full event, duplicate key ต่าง payload และ concurrent last seat ผ่าน
6. ไม่มี key ใน browser, reads ไม่เรียก AI ใหม่ และ caps ไม่เลี่ยงได้ด้วยการสร้าง session/revision
7. เพื่อน UI ทำตามวิธีรัน local แล้วต่อ API ได้ โดยไม่ต้องพึ่ง deployed URL

## เริ่มทำอะไรก่อน

ตกลง contracts กับ Core/UI → DB/Auth + create/get → outputs persistence → public publish/signup → revision/runner guards และ critical tests โดยรวม vertical flow ตั้งแต่ต้น ไม่รอวันท้ายค่อยต่อ UI

โครงนี้ยังไม่ผ่าน migration execution, Edge/Deno check, authorization/race tests หรือ deployment; อย่าใช้เป็นหลักฐานว่า backend พร้อม production
