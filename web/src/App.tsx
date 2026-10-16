import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useWorkerDeck } from './useWorkerDeck.js';

type WorkerDeck = ReturnType<typeof useWorkerDeck>;
type Profile = WorkerDeck['profiles'][number];
type View = NonNullable<WorkerDeck['view']>;
type Request = NonNullable<View['request']>;
type Team = { mode: 'team' | 'direct'; direct: string; orchestrator: string; workers: string[] };
type InspectorTab = 'tasks' | 'runs' | 'profiles' | 'diffs';
type Translate = (en: string, th: string) => string;

const paths: Record<string, string> = {
  spark: 'm12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3z',
  chat: 'M21 4H3v14h5l4 4v-4h9z M7 9h10 M7 13h6',
  folder: 'M3 7V4h6l2 3h10v13H3z',
  plus: 'M12 4v16 M4 12h16',
  arrow: 'M12 20V4 m-6 6 6-6 6 6',
  close: 'm5 5 14 14 M19 5 5 19',
  chevron: 'm8 10 4 4 4-4',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2',
  panel: 'M3 4h18v16H3z M15 4v16',
  stop: 'M6 6h12v12H6z',
  pause: 'M8 5v14 M16 5v14',
  play: 'm8 4 12 8-12 8z',
  retry: 'M3 10a9 9 0 1 1 1 8 M3 3v7h7',
  edit: 'm15 3 6 6-12 12H3v-6z M12 6l6 6',
  check: 'm5 12 4 4L20 5',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 7v6h4',
  file: 'M14 2H5v20h14V7z M14 2v6h5 M8 12h8 M8 16h6',
  menu: 'M4 6h16 M4 12h16 M4 18h16',
};

function Icon({ name }: { name: string }) {
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] || paths.file} /></svg>;
}

function Dialog({ title, children, onClose, t, className = '' }: { title: string; children: ReactNode; onClose: () => void; t: Translate; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    return () => { dialog?.close(); previous?.focus(); };
  }, []);
  return <dialog ref={ref} className={`app-dialog ${className}`} aria-labelledby={titleId} onCancel={onClose}>
    <header className="dialog-header"><h2 id={titleId}>{title}</h2><button type="button" className="icon-btn" onClick={onClose} aria-label={t('Close dialog', 'ปิดหน้าต่าง')}><Icon name="close" /></button></header>
    {children}
  </dialog>;
}

function chooseDefault(profiles: Profile[]): Team {
  const local = (id: string) => profiles.find(p => p.reference === id) || profiles.find(p => p.id === id);
  const orchestrator = local('orchestrator');
  const workers = ['implement', 'ui'].map(local).filter((p): p is Profile => Boolean(p));
  const direct = local('codex') || profiles[0];
  return orchestrator && workers.length ? { mode: 'team', orchestrator: orchestrator.reference, workers: workers.map(p => p.reference), direct: direct?.reference || '' }
    : { mode: 'direct', direct: direct?.reference || '', orchestrator: orchestrator?.reference || '', workers: [] };
}

function refsFor(team: Team): string[] {
  return team.mode === 'direct' ? (team.direct ? [team.direct] : []) : [...new Set([team.orchestrator, ...team.workers].filter(Boolean))];
}

function timeLabel(value: string, language: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(language === 'th' ? 'th-TH' : 'en-GB', { hour: '2-digit', minute: '2-digit' }).format(date);
}

function RequestCard({ request, pending, respond, t }: { request: Request; pending: boolean; respond: (answer: string) => void; t: Translate }) {
  const [answer, setAnswer] = useState('');
  const answerId = useId();
  return <section className="request-card" aria-labelledby={`request-${request.id}`}>
    <div className="request-kind">{request.kind === 'question' ? t('Your answer is needed', 'รอคำตอบจากคุณ') : request.kind === 'trust' ? t('Profile trust request', 'คำขอให้เชื่อถือโปรไฟล์') : t('Permission request', 'คำขออนุญาต')}</div>
    <h2 className="request-title" id={`request-${request.id}`} tabIndex={-1}>{request.title}</h2>
    <pre className="request-detail">{request.detail}</pre>
    <details className="request-identity"><summary>{t('Request details', 'รายละเอียดคำขอ')}</summary><code className="request-id">{request.id}</code></details>
    {request.kind === 'question' ? <form className="request-answer" onSubmit={event => { event.preventDefault(); if (answer.trim()) respond(answer.trim()); }}>
      <label className="field-label" htmlFor={answerId}>{t('Your answer', 'คำตอบของคุณ')}</label>
      <textarea id={answerId} value={answer} onChange={event => setAnswer(event.target.value)} maxLength={16000} rows={3} required disabled={pending} />
      <button className="btn btn-primary" type="submit" disabled={pending || !answer.trim()}>{t('Send answer', 'ส่งคำตอบ')}</button>
    </form> : <div className="request-actions">
      <button type="button" className="btn btn-secondary" disabled={pending} onClick={() => respond('no')}>{request.kind === 'trust' ? t('Do not trust', 'ไม่เชื่อถือ') : t('Deny', 'ไม่อนุญาต')}</button>
      <button type="button" className="btn btn-primary" disabled={pending} onClick={() => respond('yes')}>{request.kind === 'trust' ? t('Trust this profile', 'เชื่อถือโปรไฟล์นี้') : t('Allow this request', 'อนุญาตคำขอนี้')}</button>
    </div>}
  </section>;
}

export default function App() {
  const workerdeck = useWorkerDeck();
  const { bootstrap, connection, view, sessions, profiles, readiness, error, pending, requiresToken, connectToken, isCurrentHost, clearError, refresh, checkProfiles, create, open, submit, command } = workerdeck;
  const [language, setLanguage] = useState<'en' | 'th'>(() => { try { return (localStorage.getItem('workerdeck-language') ?? localStorage.getItem('subharness-language')) === 'th' ? 'th' : 'en'; } catch { return 'en'; } });
  const t: Translate = (en, th) => language === 'th' ? th : en;
  const [sidebar, setSidebar] = useState(false);
  const [newChat, setNewChat] = useState(false);
  const [draft, setDraft] = useState('');
  const [context, setContext] = useState('');
  const [contextDraft, setContextDraft] = useState('');
  const [contextOpen, setContextOpen] = useState(false);
  const [team, setTeam] = useState<Team | null>(null);
  const [pickerTeam, setPickerTeam] = useState<Team | null>(null);
  const [teamOpen, setTeamOpen] = useState(false);
  const [inspector, setInspector] = useState<InspectorTab | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [localError, setLocalError] = useState('');
  const [sending, setSending] = useState(false);
  const [checking, setChecking] = useState(false);
  const [tokenDraft, setTokenDraft] = useState('');
  const [authDismissed, setAuthDismissed] = useState(false);
  const [followOutput, setFollowOutput] = useState(true);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const defaults = useMemo(() => chooseDefault(profiles), [profiles]);
  const selectedTeam = team || defaults;
  const activeTeam = pickerTeam || selectedTeam;
  const busy = Boolean(view?.busy || view?.request);
  const isNew = newChat && !busy;
  const current = isNew ? null : view;
  const connected = connection === 'connected' && Boolean(bootstrap?.ready);
  const demo = bootstrap?.mode === 'demo';
  const project = bootstrap?.project;
  const profileName = (reference: string) => profiles.find(p => p.reference === reference)?.name || reference;
  const selectedRefs = refsFor(selectedTeam);
  const config = current?.session.configuration;
  const currentTeamLabel = config ? config.directProfileId || t('Agent team', 'ทีมเอเจนต์') : selectedTeam.mode === 'direct' ? profileName(selectedTeam.direct) || t('Choose a profile', 'เลือกโปรไฟล์') : t('Small team', 'ทีมเล็ก');
  const canRetry = Boolean(current && !current.busy && (current.session.needsPlan || current.session.tasks.some(task => ['failed', 'stopped'].includes(task.status) && !task.error?.startsWith('Superseded'))));
  const statusText = (status: string) => ({ idle: t('Ready', 'พร้อม'), planning: t('Planning', 'กำลังวางแผน'), running: t('Working', 'กำลังทำงาน'), waiting: t('Waiting for your response', 'รอคำตอบจากคุณ'), stopping: t('Stopping', 'กำลังหยุด'), stopped: t('Stopped', 'หยุดแล้ว'), paused: t('Paused', 'พักงานแล้ว'), error: t('Needs attention', 'มีเรื่องที่ต้องตรวจสอบ'), pending: t('Pending', 'รอทำงาน'), completed: t('Completed', 'เสร็จแล้ว'), failed: t('Failed', 'ไม่สำเร็จ') })[status] || status;

  useEffect(() => { document.documentElement.lang = language; try { localStorage.setItem('workerdeck-language', language); } catch { /* Language preference is optional. */ } }, [language]);
  useEffect(() => {
    if (!requiresToken) return;
    setAuthDismissed(false); setSidebar(false); setTeamOpen(false); setInspector(null); setContextOpen(false); setRenaming(false);
  }, [requiresToken]);
  useEffect(() => {
    if (!sidebar) return;
    const navigation = document.getElementById('chat-sidebar');
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    navigation?.querySelector('button')?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setSidebar(false); return; }
      if (event.key !== 'Tab' || !matchMedia('(max-width: 760px)').matches || !navigation) return;
      const controls = [...navigation.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && (document.activeElement === first || !navigation.contains(document.activeElement))) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !navigation.contains(document.activeElement))) {
        event.preventDefault(); first?.focus();
      }
    };
    document.addEventListener('keydown', keyboard);
    return () => { document.removeEventListener('keydown', keyboard); if (opener?.isConnected) opener.focus(); };
  }, [sidebar]);
  useEffect(() => { if (followOutput) endRef.current?.scrollIntoView({ block: 'end' }); }, [current?.session.messages.length, current?.output, current?.request?.id, followOutput]);
  useEffect(() => {
    if (view?.busy || view?.request) setNewChat(false);
    if (!view?.request) return;
    setFollowOutput(true); setSidebar(false); setInspector(null); setTeamOpen(false); setContextOpen(false); setRenaming(false);
    const timer = setTimeout(() => document.getElementById(`request-${view.request!.id}`)?.focus(), 0);
    return () => clearTimeout(timer);
  }, [view?.request?.id, view?.busy]);

  const act = async (operation: () => Promise<unknown>) => {
    setLocalError(''); clearError();
    try { await operation(); } catch (cause) { setLocalError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const startNew = () => {
    if (busy || pending || sending) { setLocalError(t('Stop the current work before starting another chat.', 'หยุดงานปัจจุบันก่อนเริ่มแชตใหม่')); return; }
    setNewChat(true); setDraft(''); setContext(''); setSidebar(false); setLocalError(''); clearError();
    setTimeout(() => composerRef.current?.focus(), 0);
  };
  const openSession = async (id: string) => {
    if (busy) return;
    await act(async () => { await open(id); setNewChat(false); setSidebar(false); setDraft(''); setContext(''); setFollowOutput(true); });
  };
  const showTeam = () => { setPickerTeam(selectedTeam); setTeamOpen(true); };
  const chooseOrchestrator = (reference: string) => {
    const profileId = profiles.find(profile => profile.reference === reference)?.id;
    setPickerTeam({ ...activeTeam, orchestrator: reference,
      workers: activeTeam.workers.filter(worker => profiles.find(profile => profile.reference === worker)?.id !== profileId) });
  };
  const checkSelected = async (refs: string[]) => { setChecking(true); try { return await checkProfiles(refs); } finally { setChecking(false); } };
  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!draft.trim() || sending || pending || !connected || !bootstrap || current?.request) return;
    const expectedHost = bootstrap;
    const hostChangedMessage = t('The local host or project changed while sending. Your draft was kept. Review the current project and send again.', 'โฮสต์หรือโปรเจกต์ในเครื่องเปลี่ยนระหว่างส่ง ระบบเก็บข้อความร่างไว้แล้ว ตรวจโปรเจกต์ปัจจุบันแล้วส่งใหม่');
    const assertCurrentHost = () => {
      if (!isCurrentHost(expectedHost)) throw new Error(hostChangedMessage);
    };
    const text = context.trim() ? `${draft.trim()}\n\n${t('Additional task context:', 'บริบทเพิ่มเติมของงาน:')}\n${context.trim()}` : draft.trim();
    if (text.length > 16000) { setLocalError(t('Keep the message and added context within 16,000 characters.', 'ข้อความและบริบทเพิ่มเติมรวมกันต้องไม่เกิน 16,000 ตัวอักษร')); return; }
    setSending(true); setLocalError(''); clearError();
    try {
      assertCurrentHost();
      if (isNew || !view) {
        if (!selectedRefs.length || (selectedTeam.mode === 'team' && (!selectedTeam.orchestrator || !selectedTeam.workers.length))) { setTeamOpen(true); throw new Error(t('Choose a profile or a team before sending.', 'เลือกโปรไฟล์หรือทีมก่อนส่งข้อความ')); }
        const results = await checkSelected(selectedRefs);
        assertCurrentHost();
        if (!demo && results.some(result => !result.available)) { setPickerTeam(selectedTeam); setTeamOpen(true); throw new Error(t('The selected profiles need local setup. Review the readiness checks, resolve the blockers, and try again.', 'โปรไฟล์ที่เลือกต้องตั้งค่าในเครื่อง ตรวจผลความพร้อม แก้สิ่งที่ติดขัด แล้วลองอีกครั้ง')); }
        const title = draft.trim().split('\n')[0]!.slice(0, 120);
        await create(selectedTeam.mode === 'direct' ? { title, direct: selectedTeam.direct } : { title, orchestrator: selectedTeam.orchestrator, workers: selectedTeam.workers });
        assertCurrentHost();
        setNewChat(false);
      }
      await submit(text);
      assertCurrentHost();
      setDraft(''); setContext(''); setFollowOutput(true);
      setTimeout(() => composerRef.current?.focus(), 0);
    } catch (cause) { setLocalError(!isCurrentHost(expectedHost) ? hostChangedMessage : cause instanceof Error ? cause.message : String(cause)); }
    finally { setSending(false); }
  };
  const request = current?.request;
  const onRespond = (answer: string) => { if (request) void act(() => command('request.respond', { requestId: request.id, answer })); };
  const visibleError = localError || error;
  const pickerRefs = config ? config.profiles.map(profile => profile.source.kind === 'image' ? profile.source.digest
    : profiles.find(choice => choice.id === profile.id && choice.checksum === (profile.source.kind === 'local' ? profile.source.checksum : ''))?.reference || profile.source.path) : refsFor(activeTeam);

  const composer = <form className="chat-composer" onSubmit={event => void send(event)}>
    {context && <div className="attachment-list"><span className="attachment-chip"><Icon name="file" /><span>{t('Task context added', 'เพิ่มบริบทของงานแล้ว')}</span><button type="button" className="icon-btn" onClick={() => setContext('')} aria-label={t('Remove task context', 'ลบบริบทของงาน')}><Icon name="close" /></button></span></div>}
    <label className="sr-only" htmlFor="workerdeck-message">{t('Your message', 'ข้อความของคุณ')}</label>
    <textarea id="workerdeck-message" ref={composerRef} rows={2} value={draft} maxLength={16000} onChange={event => setDraft(event.target.value)} placeholder={request ? t('Respond to the request above first…', 'ตอบคำขอด้านบนก่อน…') : t('Describe what you’d like to do…', 'พิมพ์สิ่งที่อยากทำ…')} disabled={sending || Boolean(request)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} aria-describedby="composer-hint" />
    <div className="composer-tools"><div className="composer-left"><button type="button" className="icon-btn" disabled={sending} onClick={() => { setContextDraft(context); setContextOpen(true); }} aria-label={t('Add task context', 'เพิ่มบริบทของงาน')} title={t('Add task context', 'เพิ่มบริบทของงาน')}><Icon name="plus" /></button><button type="button" className="team-button" onClick={showTeam} aria-haspopup="dialog" disabled={sending}><Icon name="spark" /><span>{currentTeamLabel}</span><Icon name="chevron" /></button></div><button type="submit" className="send-button" disabled={!draft.trim() || sending || pending || !connected || Boolean(request)} aria-label={sending ? t('Sending', 'กำลังส่ง') : current?.busy ? t('Send direction for the next task', 'ส่งแนวทางสำหรับงานถัดไป') : t('Send message', 'ส่งข้อความ')}><Icon name={sending ? 'clock' : 'arrow'} /></button></div>
  </form>;

  return <div className={`workerdeck-app ${sidebar ? 'sidebar-open' : ''} ${current ? 'has-messages' : ''}`}>
    <nav className="app-dock" aria-label={t('Workspace dock', 'Dock พื้นที่ทำงาน')}>
      <button className="dock-brand" type="button" onClick={startNew} disabled={busy || pending || sending} aria-label={t('New chat', 'แชตใหม่')}><span className="workerdeck-mark" aria-hidden="true">✳</span></button><i />
      <button type="button" className="dock-workspace active" onClick={() => setSidebar(value => !value)} aria-expanded={sidebar} aria-controls="chat-sidebar" aria-label={t('Conversations', 'บทสนทนา')}>{project?.name.slice(0, 1).toUpperCase() || 'S'}</button>
      <button type="button" className="dock-button" onClick={() => setSidebar(value => !value)} aria-label={t('Toggle conversations', 'เปิดหรือปิดบทสนทนา')} aria-expanded={sidebar} aria-controls="chat-sidebar"><Icon name="chat" /></button>
      <button type="button" className="dock-button" onClick={() => setInspector('diffs')} aria-label={t('Changed files and diffs', 'ไฟล์ที่เปลี่ยนและผลต่าง')}><Icon name="folder" /></button>
      <span className="dock-fill" /><button type="button" className="dock-button" onClick={showTeam} aria-label={t('Profiles and setup', 'โปรไฟล์และการตั้งค่า')}><Icon name="settings" /></button>
    </nav>
    {sidebar && <aside id="chat-sidebar" className="chat-sidebar is-open"><header><strong>{t('Conversations', 'บทสนทนา')}</strong><button type="button" className="icon-btn" onClick={() => setSidebar(false)} aria-label={t('Close navigation', 'ปิดเมนู')}><Icon name="close" /></button></header><button type="button" className="new-chat" onClick={startNew} disabled={busy || pending || sending}><Icon name="plus" />{t('New chat', 'แชตใหม่')}</button>{busy && <p className="sidebar-note" role="status">{t('Stop the current work before switching chats.', 'หยุดงานปัจจุบันก่อนเปลี่ยนแชต')}</p>}<div className="history-group"><span>{t('Saved chats', 'แชตที่บันทึกไว้')}</span>{sessions.length ? sessions.map(session => <button type="button" key={session.id} className={current?.session.id === session.id ? 'active' : ''} disabled={busy || pending || sending || !connected} onClick={() => void openSession(session.id)}><Icon name="chat" /><span>{session.title}</span>{session.demo && <small>{t('Demo', 'จำลอง')}</small>}</button>) : <p className="empty-state">{t('Your conversations will appear here.', 'บทสนทนาของคุณจะแสดงที่นี่')}</p>}</div><footer><Icon name="folder" /><span>{project?.name || t('Local project', 'โปรเจกต์ในเครื่อง')}<small>{t('One local project', 'โปรเจกต์เดียวในเครื่อง')}</small></span></footer></aside>}
    <main className="chat-main">
      <header className="chat-topbar"><div className="header-left"><button type="button" className="icon-btn mobile-menu" onClick={() => setSidebar(value => !value)} aria-label={t('Toggle navigation', 'เปิดหรือปิดเมนู')} aria-expanded={sidebar} aria-controls="chat-sidebar"><Icon name="menu" /></button><span className="project-breadcrumb"><span className="project-label" title={project?.cwd}><Icon name="folder" /><span>{project?.name || t('Loading project…', 'กำลังโหลดโปรเจกต์…')}</span></span><span>/</span><strong>{current?.session.title || t('New conversation', 'บทสนทนาใหม่')}</strong></span>{current && <button type="button" className="icon-btn" onClick={() => { setTitleDraft(current.session.title); setRenaming(true); }} aria-label={t('Rename conversation', 'เปลี่ยนชื่อบทสนทนา')}><Icon name="edit" /></button>}</div><div className="header-actions"><span className={`connection-status connection-${connection}`} role="status">{connection === 'connected' ? t('Connected', 'เชื่อมต่อแล้ว') : connection === 'connecting' ? t('Connecting', 'กำลังเชื่อมต่อ') : connection === 'reconnecting' ? t('Reconnecting', 'กำลังเชื่อมต่อใหม่') : t('Offline', 'ไม่ได้เชื่อมต่อ')}</span><button type="button" className="language-button" onClick={() => setLanguage(value => value === 'en' ? 'th' : 'en')} aria-label={t('Switch to Thai', 'เปลี่ยนเป็นภาษาอังกฤษ')}>{language === 'en' ? 'TH' : 'EN'}</button><button type="button" className="icon-btn" onClick={() => setInspector('tasks')} aria-label={t('Session inspector', 'รายละเอียดเซสชัน')}><Icon name="panel" /></button><button type="button" className="icon-btn" onClick={startNew} disabled={busy || pending || sending} aria-label={t('New chat', 'แชตใหม่')}><Icon name="plus" /></button></div></header>
      {demo && <div className="demo-banner" role="status"><strong>{t('SIMULATION', 'โหมดจำลอง')}</strong><span>{t('Offline demo responses. No native agent runs or project edits.', 'คำตอบตัวอย่างแบบออฟไลน์ ไม่มีการเรียกเอเจนต์จริงหรือแก้ไฟล์โปรเจกต์')}</span></div>}
      {visibleError && <div className="error-banner" role="alert"><span>{visibleError}</span><button type="button" className="icon-btn" onClick={() => { setLocalError(''); clearError(); }} aria-label={t('Dismiss error', 'ปิดข้อความผิดพลาด')}><Icon name="close" /></button></div>}
      {(!connected && connection !== 'connecting') && <div className="connection-banner" role="status"><span>{t('The local host connection is interrupted. Your draft is still here.', 'การเชื่อมต่อกับโฮสต์ในเครื่องขัดข้อง ข้อความร่างของคุณยังอยู่')}</span><button type="button" className="btn btn-secondary" onClick={() => requiresToken ? setAuthDismissed(false) : void act(refresh)} disabled={pending}>{requiresToken ? t('Connect to host', 'เชื่อมต่อโฮสต์') : t('Retry connection', 'ลองเชื่อมต่อใหม่')}</button></div>}
      {current?.error && <div className="runtime-error" role="alert">{current.error}</div>}
      <div className="conversation-layout"><div className="conversation">
        {!current ? <div className="center-start"><div className="start-inner"><div className="welcome-block"><div className="project-eyebrow"><span className="project-label"><Icon name="folder" /><span>{project?.name || t('Your project', 'โปรเจกต์ของคุณ')}</span></span><span>{t('CURRENT PROJECT', 'โปรเจกต์ปัจจุบัน')}</span></div><h1>{t('Let’s move this project forward.', 'มาทำโปรเจกต์นี้ต่อกัน')}</h1><p>{t('Tell WorkerDeck what you want to do next.', 'บอก WorkerDeck ว่าอยากทำอะไรต่อ')}</p></div>{composer}<div className="starter-links"><button type="button" onClick={() => { setDraft(t('Help me plan the next change in this project.', 'ช่วยวางแผนการเปลี่ยนแปลงถัดไปในโปรเจกต์นี้')); composerRef.current?.focus(); }}><Icon name="chat" />{t('Plan a task', 'วางแผนงาน')}</button><button type="button" onClick={() => { setContextDraft(context); setContextOpen(true); }}><Icon name="file" />{t('Add context', 'เพิ่มบริบท')}</button></div><div className="quiet-hint" id="composer-hint">{checking ? t('Checking local profile readiness…', 'กำลังตรวจความพร้อมของโปรไฟล์ในเครื่อง…') : t('Enter to send · Shift + Enter for a new line', 'Enter เพื่อส่ง · Shift + Enter เพื่อขึ้นบรรทัดใหม่')}</div></div></div> : <>
          <div ref={scrollRef} className="chat-scroll" onScroll={event => { const el = event.currentTarget; setFollowOutput(el.scrollHeight - el.scrollTop - el.clientHeight < 100); }}><section className="message-list" aria-label={t('Conversation', 'บทสนทนา')}>{current.session.messages.map(message => <article className={`message-row ${message.role === 'user' ? 'user-message' : message.role === 'system' ? 'system-message' : 'assistant-message'}`} key={message.id}>{message.role !== 'user' && <span className="workerdeck-mark" aria-hidden="true">{message.role === 'system' ? '·' : '✳'}</span>}<div className="message-body"><div className="message-author">{message.role === 'user' ? t('You', 'คุณ') : message.role === 'system' ? t('Session', 'เซสชัน') : message.profileId || 'WorkerDeck'}<time dateTime={message.time}>{timeLabel(message.time, language)}</time>{message.taskId && <small>{message.taskId}</small>}</div><div className="message-text">{message.text}</div></div></article>)}</section>{current.busy && current.output && <section className="streaming-output assistant-message" aria-label={t('Current streamed output', 'ผลลัพธ์ที่กำลังส่งมา')}><span className="workerdeck-mark" aria-hidden="true">✳</span><div className="message-body"><div className="message-author">{current.session.runs.find(run => run.id === current.activeRunId)?.profileId || 'WorkerDeck'}<small>{t('Working', 'กำลังทำงาน')}</small></div><pre className="message-text">{current.output}</pre></div></section>}{request && <RequestCard key={request.id} request={request} pending={pending || !connected} respond={onRespond} t={t} />}<div ref={endRef} /></div>
          <div className="composer-zone"><div className="runtime-controls"><span className={`session-live-status status-${current.status}`} role="status" aria-live="polite">{statusText(current.status)}{current.activeTask && <small> · {current.session.tasks.find(task => task.id === current.activeTask)?.title || current.activeTask}</small>}</span><div>{!followOutput && <button type="button" className="text-btn" onClick={() => { setFollowOutput(true); endRef.current?.scrollIntoView({ block: 'end' }); }}>{t('Latest', 'ล่าสุด')}</button>}{current.busy && <><button type="button" className="control-button" disabled={!connected || current.paused || current.status === 'stopping'} onClick={() => void act(() => command('session.pause'))}><Icon name="pause" />{current.paused ? t('Pause requested', 'ขอพักงานแล้ว') : t('Pause', 'พักงาน')}</button><button type="button" className="control-button" disabled={!connected || current.status === 'stopping'} onClick={() => void act(() => command('session.stop'))}><Icon name="stop" />{t('Stop', 'หยุด')}</button></>}{!current.busy && current.paused && <button type="button" className="control-button" disabled={!connected || pending} onClick={() => void act(() => command('session.resume'))}><Icon name="play" />{t('Resume', 'ทำต่อ')}</button>}{canRetry && <button type="button" className="control-button" disabled={!connected || pending} onClick={() => void act(() => command('session.retry'))}><Icon name="retry" />{t('Retry', 'ลองอีกครั้ง')}</button>}<button type="button" className="control-button" onClick={() => setInspector('tasks')}><Icon name="panel" />{t('Details', 'รายละเอียด')}</button></div></div>{composer}<div className="quiet-hint" id="composer-hint">{request ? t('Use the request card to answer. Chat cannot grant permission.', 'ตอบผ่านการ์ดคำขอ ช่องแชตไม่สามารถอนุญาตแทนได้') : current.busy ? t('New direction is queued for the next task boundary.', 'แนวทางใหม่จะเข้าคิวสำหรับช่วงต่องานถัดไป') : t('Enter to send · Shift + Enter for a new line', 'Enter เพื่อส่ง · Shift + Enter เพื่อขึ้นบรรทัดใหม่')}</div></div>
        </>}
      </div></div>
    </main>
    {sidebar && <button type="button" className="nav-backdrop" onClick={() => setSidebar(false)} aria-label={t('Close navigation', 'ปิดเมนู')} />}
    {requiresToken && !authDismissed && <Dialog title={t('Connect your workspace', 'เชื่อมต่อพื้นที่ทำงาน')} onClose={() => setAuthDismissed(true)} t={t} className="connection-token-dialog"><form onSubmit={event => { event.preventDefault(); if (tokenDraft.trim()) { setLocalError(''); clearError(); connectToken(tokenDraft.trim()); setTokenDraft(''); } }}><div className="dialog-body"><p className="dialog-note">{t('Paste the access token shown in the terminal when the local host starts. It stays in memory for this tab.', 'วางโทเคนที่แสดงใน terminal ตอนเริ่มโฮสต์ โทเคนจะอยู่ในหน่วยความจำของแท็บนี้')}</p><label className="field-label" htmlFor="host-token">{t('Connection token', 'โทเคนเชื่อมต่อ')}</label><input id="host-token" className="text-field" type="password" autoComplete="off" autoFocus value={tokenDraft} onChange={event => setTokenDraft(event.target.value)} maxLength={1024} required /></div><div className="dialog-actions"><button className="btn btn-primary" type="submit" disabled={!tokenDraft.trim()}>{t('Connect', 'เชื่อมต่อ')}</button></div></form></Dialog>}
    {contextOpen && <Dialog title={t('Add task context', 'เพิ่มบริบทของงาน')} onClose={() => setContextOpen(false)} t={t} className="context-dialog"><form onSubmit={event => { event.preventDefault(); setContext(contextDraft.trim()); setContextOpen(false); composerRef.current?.focus(); }}><div className="dialog-body"><p className="dialog-note">{t('Paste relevant details, an excerpt, or project-relative file names. This is added as text to your next message.', 'วางรายละเอียด ข้อความบางส่วน หรือชื่อไฟล์ภายในโปรเจกต์ ข้อมูลนี้จะเพิ่มเป็นข้อความในแชตถัดไป')}</p><label className="field-label" htmlFor="task-context">{t('Context', 'บริบท')}</label><textarea id="task-context" className="text-field" value={contextDraft} onChange={event => setContextDraft(event.target.value)} rows={8} maxLength={12000} /><p className="quiet-note">{t('The agent works in the local project shown above. Files are not uploaded through this interface.', 'เอเจนต์ทำงานในโปรเจกต์ในเครื่องที่แสดงด้านบน หน้านี้ไม่ได้อัปโหลดไฟล์')}</p></div><div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setContextOpen(false)}>{t('Cancel', 'ยกเลิก')}</button><button type="submit" className="btn btn-primary">{t('Add context', 'เพิ่มบริบท')}</button></div></form></Dialog>}
    {teamOpen && <Dialog title={t('Who works with you?', 'ให้ใครช่วยทำงาน')} onClose={() => setTeamOpen(false)} t={t} className="profile-picker"><div className="dialog-body">
      {config ? <><p className="dialog-note">{t('This conversation keeps its saved profile selection. Start a new chat to choose a different team.', 'บทสนทนานี้ใช้โปรไฟล์ที่บันทึกไว้ เริ่มแชตใหม่หากต้องการเลือกทีมอื่น')}</p>{config.profiles.map(profile => <div className="profile-card" key={profile.id}><strong>{profile.id}</strong><small>{profile.harness}{profile.model ? ` · ${profile.model}` : ''}</small></div>)}</> : <><fieldset className="mode-options"><legend>{t('Execution mode', 'รูปแบบการทำงาน')}</legend><label><input type="radio" name="team-mode" checked={activeTeam.mode === 'team'} onChange={() => setPickerTeam({ ...activeTeam, mode: 'team' })} />{t('Small team', 'ทีมเล็ก')}</label><label><input type="radio" name="team-mode" checked={activeTeam.mode === 'direct'} onChange={() => setPickerTeam({ ...activeTeam, mode: 'direct' })} />{t('One profile', 'โปรไฟล์เดียว')}</label></fieldset>{activeTeam.mode === 'direct' ? <><label className="field-label" htmlFor="direct-profile">{t('Assistant profile', 'โปรไฟล์ผู้ช่วย')}</label><select id="direct-profile" className="text-field" value={activeTeam.direct} onChange={event => setPickerTeam({ ...activeTeam, direct: event.target.value })}><option value="">{t('Choose a profile', 'เลือกโปรไฟล์')}</option>{profiles.map(profile => <option key={profile.reference} value={profile.reference}>{profile.name} · {profile.harness}{profile.image ? ' · image' : ''}</option>)}</select></> : <><label className="field-label" htmlFor="orchestrator-profile">{t('Orchestrator', 'ผู้วางแผนและประสานงาน')}</label><select id="orchestrator-profile" className="text-field" value={activeTeam.orchestrator} onChange={event => chooseOrchestrator(event.target.value)}><option value="">{t('Choose an orchestrator', 'เลือกผู้ประสานงาน')}</option>{profiles.map(profile => <option key={profile.reference} value={profile.reference}>{profile.name} · {profile.harness}</option>)}</select><fieldset className="worker-options"><legend>{t('Workers', 'ผู้ทำงาน')}</legend>{profiles.filter(profile => profile.reference !== activeTeam.orchestrator && profile.id !== profiles.find(p => p.reference === activeTeam.orchestrator)?.id).map(profile => <label className="profile-option" key={profile.reference}><input type="checkbox" checked={activeTeam.workers.includes(profile.reference)} onChange={event => setPickerTeam({ ...activeTeam, workers: event.target.checked ? [...activeTeam.workers.filter(ref => profiles.find(p => p.reference === ref)?.id !== profile.id), profile.reference] : activeTeam.workers.filter(ref => ref !== profile.reference) })} /><span><strong>{profile.name}</strong><small>{profile.harness} · {profile.id}</small></span></label>)}</fieldset></>}{!profiles.length && <p className="empty-state">{t('No profiles are available from the local host. Refresh after configuring profiles locally.', 'โฮสต์ในเครื่องยังไม่มีโปรไฟล์ ตั้งค่าโปรไฟล์ในเครื่องแล้วโหลดใหม่')}</p>}</>}
      <div className="readiness-list"><div className="widget-head"><h3>{t('Local readiness', 'ความพร้อมในเครื่อง')}</h3><button type="button" className="text-btn" disabled={checking || pending || !connected || !pickerRefs.length} onClick={() => void act(() => checkSelected(pickerRefs))}>{checking ? t('Checking…', 'กำลังตรวจ…') : t('Check profiles', 'ตรวจโปรไฟล์')}</button></div>{demo && <p className="quiet-note">{t('Simulation can run even when native setup is blocked. Live sessions require ready profiles.', 'โหมดจำลองทำงานได้แม้เอเจนต์จริงยังไม่พร้อม เซสชันจริงต้องใช้โปรไฟล์ที่พร้อม')}</p>}{pickerRefs.map(reference => { const result = readiness[reference]; return <section className={`readiness-item ${result?.available ? 'is-ready' : result ? 'is-blocked' : 'is-unchecked'}`} key={reference}><h4>{profileName(reference)}</h4>{result ? <><p>{result.reason}</p>{result.checks.map((check, index) => <div className={`readiness-check check-${check.status}`} key={`${check.kind}-${index}`}><strong>{check.status === 'passed' ? t('Passed', 'ผ่าน') : check.status === 'blocked' ? t('Blocked', 'ติดขัด') : t('Unverified', 'ยังไม่ยืนยัน')} · {check.kind}</strong><p>{check.reason}</p>{check.action && <p className="readiness-action">{check.action}</p>}</div>)}</> : <p>{t('Not checked yet. The first message checks readiness before starting.', 'ยังไม่ตรวจ ระบบจะตรวจความพร้อมก่อนเริ่มข้อความแรก')}</p>}</section>; })}</div>
    </div><div className="dialog-actions">{config ? <button type="button" className="btn btn-primary" onClick={() => setTeamOpen(false)}>{t('Done', 'เสร็จแล้ว')}</button> : <><button type="button" className="btn btn-secondary" onClick={() => setTeamOpen(false)}>{t('Cancel', 'ยกเลิก')}</button><button type="button" className="btn btn-primary" disabled={checking || !pickerRefs.length || (activeTeam.mode === 'team' && (!activeTeam.orchestrator || !activeTeam.workers.length))} onClick={() => { setTeam(activeTeam); setTeamOpen(false); composerRef.current?.focus(); }}>{t('Use this setup', 'ใช้การตั้งค่านี้')}</button></>}</div></Dialog>}
    {renaming && current && <Dialog title={t('Rename conversation', 'เปลี่ยนชื่อบทสนทนา')} t={t} onClose={() => setRenaming(false)}><form onSubmit={event => { event.preventDefault(); void act(async () => { await command('session.rename', { title: titleDraft.trim() }); setRenaming(false); }); }}><div className="dialog-body"><label className="field-label" htmlFor="session-title">{t('Conversation title', 'ชื่อบทสนทนา')}</label><input id="session-title" className="text-field" value={titleDraft} onChange={event => setTitleDraft(event.target.value)} maxLength={160} required /></div><div className="dialog-actions"><button type="submit" className="btn btn-primary" disabled={pending || !titleDraft.trim()}>{t('Save title', 'บันทึกชื่อ')}</button></div></form></Dialog>}
    {inspector && <Dialog title={t('Session details', 'รายละเอียดเซสชัน')} onClose={() => setInspector(null)} t={t} className="inspector-dialog"><div className="inspector-tabs" role="tablist" aria-label={t('Inspector sections', 'หมวดรายละเอียดเซสชัน')}>{(['tasks', 'runs', 'profiles', 'diffs'] as const).map((tab, index, tabs) => <button type="button" key={tab} role="tab" id={`tab-${tab}`} aria-selected={inspector === tab} aria-controls={`panel-${tab}`} tabIndex={inspector === tab ? 0 : -1} onClick={() => setInspector(tab)} onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[3] : tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]!; setInspector(next); document.getElementById(`tab-${next}`)?.focus(); } }}>{tab === 'tasks' ? t('Tasks', 'งาน') : tab === 'runs' ? t('Runs', 'การเรียกเอเจนต์') : tab === 'profiles' ? t('Profiles', 'โปรไฟล์') : t('File diffs', 'ผลต่างไฟล์')}</button>)}</div><div className="inspector-content dialog-body" role="tabpanel" id={`panel-${inspector}`} aria-labelledby={`tab-${inspector}`} tabIndex={0}>
      <div className="project-location"><span className="field-label">{t('Local project · read-only', 'โปรเจกต์ในเครื่อง · อ่านอย่างเดียว')}</span><code>{project?.cwd || t('Waiting for local host', 'รอโฮสต์ในเครื่อง')}</code></div>
      {inspector === 'tasks' && (current?.session.tasks.length ? <div className="task-list">{current.session.tasks.map(task => <article className="task-card" key={task.id}><div className="task-meta"><span className={`task-status status-${task.status}`}>{statusText(task.status)}</span><code>{task.id}</code></div><h3>{task.title}</h3><p>{task.goal}</p><small>{t('Assigned to', 'ผู้รับผิดชอบ')} {task.profileId}{task.dependsOn.length ? ` · ${t('Depends on', 'ขึ้นกับ')} ${task.dependsOn.join(', ')}` : ''}</small><details><summary>{t('Acceptance criteria', 'เกณฑ์รับงาน')}</summary><ul>{task.acceptance.map((item, index) => <li key={index}>{item}</li>)}</ul></details>{task.error && <pre className="task-error">{task.error}</pre>}{task.result && <details><summary>{t('Task output', 'ผลลัพธ์ของงาน')}</summary><pre className="task-result">{task.result}</pre></details>}{Boolean(task.changedFiles?.length) && <p className="changed-files">{t('Changed files', 'ไฟล์ที่เปลี่ยน')}: {task.changedFiles?.join(', ')}</p>}<div className="task-actions">{task.status === 'pending' && config && <label>{t('Assign worker', 'มอบหมายงาน')}<select aria-label={`${t('Worker for', 'ผู้ทำงานสำหรับ')} ${task.title}`} value={task.profileId} disabled={pending || !connected} onChange={event => void act(() => command('session.assign', { taskId: task.id, profileId: event.target.value }))}>{config.workerProfileIds.map(id => <option key={id} value={id}>{id}</option>)}</select></label>}{['failed', 'stopped'].includes(task.status) && !task.error?.startsWith('Superseded') && <button type="button" className="btn btn-secondary" disabled={current.busy || pending || !connected} onClick={() => void act(() => command('session.retry', { taskId: task.id }))}>{t('Retry this task', 'ลองงานนี้อีกครั้ง')}</button>}</div></article>)}</div> : <p className="empty-state">{t('Tasks appear when the agent creates a plan. Direct-profile conversations may not have a task plan.', 'งานจะแสดงเมื่อเอเจนต์สร้างแผน บทสนทนากับโปรไฟล์เดียวอาจไม่มีแผนงาน')}</p>)}
      {inspector === 'runs' && (current?.session.runs.length ? <div className="run-list">{current.session.runs.map(run => <article className="run-card" key={run.id}><div className="task-meta"><strong>{run.profileId}</strong><span>{statusText(run.status)}</span></div><p>{run.harness}{run.model ? ` · ${run.model}` : ''} · {run.role}</p><small>{timeLabel(run.startedAt, language)}{run.endedAt ? ` → ${timeLabel(run.endedAt, language)}` : ''}</small>{run.taskId && <p>{t('Task', 'งาน')}: {run.taskId}</p>}{run.error && <pre>{run.error}</pre>}<details><summary>{t('Run identity', 'รหัสการเรียกเอเจนต์')}</summary><code>{run.id}</code>{run.nativeSessionId && <p>{t('Native session', 'เซสชันเอเจนต์')}: {run.nativeSessionId}</p>}</details></article>)}</div> : <p className="empty-state">{t('No agent runs in this conversation yet.', 'บทสนทนานี้ยังไม่มีการเรียกเอเจนต์')}</p>)}
      {inspector === 'profiles' && <div className="profile-list">{config ? config.profiles.map(profile => <article className="profile-card" key={profile.id}><h3>{profile.id}</h3><p>{profile.harness}{profile.model ? ` · ${profile.model}` : ''}</p><small>{config.directProfileId === profile.id ? t('Direct profile', 'โปรไฟล์ที่คุยโดยตรง') : config.orchestratorProfileId === profile.id ? t('Orchestrator', 'ผู้ประสานงาน') : t('Worker', 'ผู้ทำงาน')}</small>{current?.availability[profile.id] && <p>{current.availability[profile.id]?.reason}</p>}<details><summary>{t('Source identity', 'ข้อมูลต้นทางโปรไฟล์')}</summary><code>{profile.source.kind === 'image' ? profile.source.digest : profile.source.checksum}</code>{profile.source.kind === 'local' && <p>{profile.source.path}</p>}</details></article>) : profiles.map(profile => <article className="profile-card" key={profile.reference}><h3>{profile.name}</h3><p>{profile.description}</p><small>{profile.harness} · {profile.role}</small><code>{profile.reference}</code></article>)}{!config && !profiles.length && <p className="empty-state">{t('No profiles loaded.', 'ยังไม่มีโปรไฟล์')}</p>}</div>}
      {inspector === 'diffs' && (current && Object.keys(current.session.diffs).length ? <div className="diff-list">{Object.entries(current.session.diffs).map(([taskId, diff]) => <details className="diff-item" key={taskId} open><summary>{current.session.tasks.find(task => task.id === taskId)?.title || taskId}</summary><pre className="diff-content">{diff || t('No textual diff was recorded for this task.', 'งานนี้ไม่มีผลต่างข้อความที่บันทึกไว้')}</pre></details>)}</div> : <p className="empty-state">{t('File diffs appear after tasks change project files. No files are uploaded or generated by opening this panel.', 'ผลต่างไฟล์จะแสดงเมื่องานเปลี่ยนไฟล์โปรเจกต์ การเปิดแผงนี้ไม่ได้อัปโหลดหรือสร้างไฟล์')}</p>)}
    </div></Dialog>}
  </div>;
}
