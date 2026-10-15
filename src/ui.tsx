import React, { useEffect, useState } from 'react';
import { Box, Text, useApp, useInput, useWindowSize } from 'ink';
import wrapAnsi from 'wrap-ansi';
import { Engine, redact, type View } from './engine.js';
import { missingEnv, modelFor } from './adapters.js';
import type { Task } from './schema.js';
import { exitWithRestoreRetry } from './terminal.js';

const colors: Record<Task['status'], string> = { pending: 'gray', running: 'cyan', completed: 'green', failed: 'red', stopped: 'yellow' };
const symbols: Record<Task['status'], string> = { pending: '○', running: '▶', completed: '✓', failed: '×', stopped: '■' };
const clean = (value: string) => redact(value).replaceAll('\r', '');

function Panel({ title, width, height, active, children }: { title: string; width: number; height: number; active: boolean; children: React.ReactNode }) {
  return <Box width={width} height={height} flexDirection="column" borderStyle="round" borderColor={active ? 'cyan' : 'gray'} paddingX={1} overflow="hidden">
    <Text bold color={active ? 'cyan' : 'white'}>{title}</Text>
    <Text dimColor>{'─'.repeat(Math.max(0, width - 4))}</Text>
    {children}
  </Box>;
}

function Clip({ value, lines, width, scroll = 0, fromStart = false }: { value: string; lines: number; width: number; scroll?: number; fromStart?: boolean }) {
  const rows = wrapAnsi(clean(value), width, { hard: true, trim: false }).split('\n');
  if (fromStart) return <Text>{rows.slice(scroll, scroll + lines).join('\n')}</Text>;
  const end = Math.max(lines, rows.length - scroll);
  return <Text>{rows.slice(Math.max(0, end - lines), end).join('\n')}</Text>;
}

export function App({ engine, onNavigate }: { engine: Engine; onNavigate?: (kind: 'team' | 'sessions', title?: string) => void }) {
  const { exit } = useApp();
  const size = useWindowSize();
  const [view, setView] = useState<View>({ ...engine.state });
  const [input, setInput] = useState('');
  const [cursor, setCursor] = useState(0);
  const [focus, setFocus] = useState(1);
  const [selected, setSelected] = useState(0);
  const [scroll, setScroll] = useState(0);
  const [inspector, setInspector] = useState<'task' | 'diff' | 'profiles' | 'runs' | 'help'>('task');
  const [compactInspector, setCompactInspector] = useState(false);
  const [localError, setLocalError] = useState('');
  const [closing, setClosing] = useState(false);
  const tasks = view.session.tasks;
  const active = tasks.findIndex(task => task.id === view.activeTask);
  const task = tasks[selected] ?? tasks[active] ?? tasks.at(-1);

  useEffect(() => {
    const change = (next: View) => setView({ ...next });
    engine.on('change', change);
    return () => { engine.off('change', change); };
  }, [engine]);
  useEffect(() => { if (active >= 0) setSelected(active); }, [active]);
  useEffect(() => { if (closing && !view.busy) void engine.flush().then(() => exitWithRestoreRetry(() => exit())).catch(error => { setLocalError(String(error)); exit(error); }); }, [closing, view.busy]);

  const perform = (work: () => void | Promise<void>) => {
    setLocalError('');
    Promise.resolve().then(work).catch(error => setLocalError(clean(error instanceof Error ? error.message : String(error))));
  };
  const submit = (value: string) => {
    const text = value.trim();
    if (!text) return;
    if (view.request) { const requestId = view.request.id; perform(() => engine.answer(text, requestId)); return; }
    const [command, ...args] = text.split(/\s+/);
    if (!text.startsWith('/')) { setScroll(0); setCompactInspector(false); perform(() => engine.submit(text)); return; }
    switch (command) {
      case '/new': case '/team': case '/sessions':
        perform(() => { if (!onNavigate) throw new Error('Session navigation requires the workspace CLI host.'); onNavigate(command === '/sessions' ? 'sessions' : 'team', args.join(' ') || undefined); }); break;
      case '/stop': engine.stop(); break;
      case '/pause': engine.pause(); break;
      case '/resume': perform(() => engine.resume()); break;
      case '/retry': perform(() => engine.retry(args[0])); break;
      case '/assign': perform(() => engine.assign(args[0] ?? '', args[1] ?? '')); break;
      case '/memory': perform(() => engine.showMemory()); setCompactInspector(false); break;
      case '/remember': perform(() => engine.remember(args.join(' '))); break;
      case '/forget': perform(() => engine.forget(args[0] ?? '')); break;
      case '/persona': engine.showPersona(); setCompactInspector(false); break;
      case '/rename': perform(() => engine.rename(args.join(' '))); break;
      case '/runs': setInspector('runs'); setScroll(0); setCompactInspector(true); break;
      case '/profiles': setInspector('profiles'); setScroll(0); setCompactInspector(true); break;
      case '/diff': setInspector('diff'); setScroll(0); setCompactInspector(true); break;
      case '/task': {
        const index = args[0] ? tasks.findIndex(task => task.id === args[0]) : selected;
        if (index < 0) { setLocalError('Unknown task ID.'); break; }
        setSelected(index); setInspector('task'); setScroll(0); setCompactInspector(true); break;
      }
      case '/help': setInspector('help'); setScroll(0); setCompactInspector(true); break;
      case '/chat': setCompactInspector(false); setScroll(0); break;
      case '/quit': case '/exit': engine.stop(); setClosing(true); break;
      default: setLocalError(`Unknown command: ${command}. Type /help.`);
    }
  };

  useInput((value, key) => {
    if (closing) return;
    if (key.ctrl && value === 'c') {
      if (view.busy) { engine.stop(); setLocalError('Stopping. Press Ctrl+C again after the task stops to exit.'); }
      else setClosing(true);
      return;
    }
    if (key.tab) { setFocus(previous => (previous + (key.shift ? 2 : 1)) % 3); setScroll(0); return; }
    if (key.escape) { if (view.request) { const requestId = view.request.id; perform(() => engine.answer('no', requestId)); } else { setInput(''); setCursor(0); setFocus(1); setCompactInspector(false); } return; }
    const inspecting = focus === 2 || (size.columns < 105 && compactInspector && !view.request);
    if (key.pageUp) { setScroll(previous => inspecting ? Math.max(0, previous - 8) : previous + 8); return; }
    if (key.pageDown) { setScroll(previous => inspecting ? previous + 8 : Math.max(0, previous - 8)); return; }
    if (focus === 0 && (key.upArrow || key.downArrow)) {
      setSelected(previous => Math.max(0, Math.min(tasks.length - 1, previous + (key.upArrow ? -1 : 1))));
      setScroll(0); return;
    }
    if (key.ctrl && value === 'd') { setInspector(previous => previous === 'diff' ? 'task' : 'diff'); setCompactInspector(true); setScroll(0); return; }
    if (key.return) { const text = input; setInput(''); setCursor(0); submit(text); return; }
    const characters = Array.from(input);
    if (key.leftArrow) { setCursor(previous => Math.max(0, previous - 1)); return; }
    if (key.rightArrow) { setCursor(previous => Math.min(characters.length, previous + 1)); return; }
    if (key.ctrl && value === 'a') { setCursor(0); return; }
    if (key.ctrl && value === 'e') { setCursor(characters.length); return; }
    if (key.delete) { characters.splice(cursor, 1); setInput(characters.join('')); return; }
    if (key.backspace) {
      if (cursor > 0) { characters.splice(cursor - 1, 1); setInput(characters.join('')); setCursor(cursor - 1); }
      return;
    }
    if (!key.ctrl && !key.meta && value) {
      const inserted = Array.from(clean(value).replaceAll('\n', ' '));
      characters.splice(cursor, 0, ...inserted);
      if (characters.length <= 16000) { setInput(characters.join('')); setCursor(cursor + inserted.length); setFocus(1); }
    }
  });

  const columns = Math.max(30, size.columns);
  const wide = columns >= 105;
  const medium = columns >= 76;
  const leftWidth = wide ? Math.max(24, Math.floor(columns * .23)) : medium ? 23 : 0;
  const rightWidth = wide ? Math.floor(columns * .29) : 0;
  const chatWidth = columns - leftWidth - rightWidth;
  const height = Math.max(7, size.rows - 7);
  const contentLines = Math.max(3, height - 4);
  const chat = view.session.messages.map(message => {
    const label = message.role === 'user' ? 'YOU' : message.profileId ? `@${message.profileId}` : message.role.toUpperCase();
    return `${label}${message.taskId ? ` / ${message.taskId}` : ''}\n${message.text}`;
  }).join('\n\n') || (view.session.selection?.directProfileId
    ? `Chat with @${view.session.selection.directProfileId}. This session uses the image/profile you selected directly.\n\n/profiles · inspect the image and native runtime\n/help · keyboard shortcuts and commands`
    : 'Tell the orchestrator what to build. It chooses the profiles and runs their native harnesses.\n\nExample: Build a booking interface with an API, then refine its mobile layout.\n\n/new · choose a team\n/sessions · open saved chats\n/profiles · inspect the available team\n/help · keyboard shortcuts and commands');
  const live = view.busy && view.output ? `\n\n@${tasks.find(item => item.id === view.activeTask)?.profileId ?? engine.orchestratorProfileId ?? 'worker'} · LIVE\n${view.output}` : '';
  const requestText = view.request ? `\n\n${view.request.kind.toUpperCase()} · ${view.request.title}\n${view.request.detail}\n\n${view.request.kind === 'question' ? 'Type your answer below.' : 'Type yes to allow once, or no to deny.'}` : '';
  let detail = task ? `${task.title}\n${task.id}\n\nPROFILE\n@${task.profileId}\n\nWHY THIS PROFILE\n${task.reason}\n\nTASK\n${task.goal}\n\nDONE WHEN\n${task.acceptance.map(item => `• ${item}`).join('\n')}\n\nDEPENDS ON\n${task.dependsOn.join(', ') || 'none'}\n\nFILES\n${task.changedFiles?.join('\n') || 'No recorded changes yet.'}\n\n${task.error ?? task.result ?? ''}` : 'The orchestrator will choose profiles and add tasks here.';
  if (inspector === 'diff') detail = task ? view.session.diffs[task.id] ?? 'No diff captured yet.' : 'Select a task to inspect its diff.';
  if (inspector === 'profiles') detail = engine.profiles.map(profile => `@${profile.manifest.id} · ${engine.roleFor(profile.manifest.id)}\n${profile.manifest.name}\n${profile.manifest.harness} / ${modelFor(profile) ?? 'native default'}\n${profile.image ? `Image: ${profile.image.digest}\nRuntime: ${profile.image.runtimeVersion} / ${profile.image.platform}-${profile.image.arch}\n${profile.image.parent ? `Base: ${profile.image.parent}\n` : ''}` : ''}${profile.manifest.description}\nSkills: ${profile.manifest.skills.join(', ') || 'none'}\nPlugins: ${profile.manifest.plugins.join(', ') || 'none'}\n${view.availability[profile.manifest.id]?.reason ?? missingEnv(profile).map(key => `Missing: ${key}`).join('\n')}`).join('\n\n');
  if (inspector === 'runs') detail = view.session.runs.map(run => `${run.role} @${run.profileId} · ${run.status}\n${run.harness} / ${run.model ?? 'native default'}\n${run.startedAt}\nNative session: ${run.nativeSessionId ?? 'not started'}\n${run.error ?? ''}`).join('\n\n') || 'No harness runs yet.';
  if (inspector === 'help') detail = '/new [title] · choose a team for a new session\n/team · team picker for a new session\n/sessions · open saved chats\n/rename <title> · name this session\n/runs · harness history\n/pause · pause after current task\n/resume · continue pending work\n/stop · interrupt active harness\n/retry [task-id] · retry stopped/failed work\n/assign <task-id> <profile-id> · override pending work\n/profiles · inspect team\n/task [id] · inspect a task\n/diff · selected task changes\n/memory · list project memory\n/remember <text> · save a preference\n/forget <id> · delete a memory\n/persona · show editable persona path\n/quit · stop and save\n\nTab · change pane\n↑ / ↓ · select task in left pane\nPgUp / PgDn · scroll focused content\nCtrl+D · toggle task/diff\nCtrl+C · stop; exit when idle\nEsc · clear input / deny request\n\nSend a message while busy to steer the next task boundary.';
  const inputChars = Array.from(input);
  const visibleStart = Math.max(0, cursor - Math.max(10, columns - 12));
  const before = inputChars.slice(visibleStart, cursor).join('');
  const underCursor = inputChars[cursor] ?? ' ';
  const after = inputChars.slice(cursor + 1, visibleStart + columns - 8).join('');

  return <Box flexDirection="column" height={Math.max(14, size.rows)} width={columns}>
    <Box justifyContent="space-between"><Text bold color="cyan"> SUBHARNESS <Text dimColor>native specialists, one thread</Text></Text><Text color={view.session.demo ? 'yellow' : 'green'}>{view.session.demo ? 'SIMULATION · no model calls' : 'LIVE'} </Text></Box>
    <Text dimColor wrap="truncate"> {clean(view.session.cwd)} · {clean(view.session.title)} · {view.status} · session {view.session.id}</Text>
    <Box flexDirection="row" height={height}>
      {leftWidth > 0 && <Panel title={`FLOW · ${tasks.filter(item => item.status === 'completed').length}/${tasks.length}`} width={leftWidth} height={height} active={focus === 0}>
        {tasks.length === 0 ? <Text dimColor>Waiting for a goal</Text> : tasks.slice(Math.max(0, selected - Math.floor(contentLines / 6)), Math.max(0, selected - Math.floor(contentLines / 6)) + Math.floor(contentLines / 3)).map(item => <Box key={item.id} flexDirection="column" marginBottom={1}>
          <Text color={colors[item.status]} inverse={task?.id === item.id} wrap="truncate">{symbols[item.status]} {clean(item.title)}</Text>
          <Text dimColor wrap="truncate"> @{item.profileId} · {item.id}</Text>
        </Box>)}
      </Panel>}
      <Panel title={view.request ? `CHAT · ${view.request.kind.toUpperCase()}` : 'CONVERSATION'} width={chatWidth} height={height} active={focus === 1 || Boolean(view.request)}>
        <Clip value={!wide && compactInspector && !view.request ? detail : chat + live + requestText} lines={contentLines} width={Math.max(12, chatWidth - 5)} scroll={focus === 1 ? scroll : 0} fromStart={!wide && compactInspector && !view.request} />
      </Panel>
      {rightWidth > 0 && <Panel title={`INSPECT · ${inspector.toUpperCase()}`} width={rightWidth} height={height} active={focus === 2}>
        <Clip value={detail} lines={contentLines} width={Math.max(12, rightWidth - 5)} scroll={focus === 2 ? scroll : 0} fromStart />
      </Panel>}
    </Box>
    <Text color={localError || view.error ? 'red' : view.request ? 'yellow' : 'cyan'} wrap="truncate"> {clean(localError || view.error || (closing ? 'Saving and closing…' : view.phase))}</Text>
    <Box borderStyle="single" borderColor={view.request ? 'yellow' : 'cyan'} paddingX={1} height={3}>
      <Text color="cyan">{view.request ? '? ' : '› '}</Text><Text>{before}<Text inverse>{underCursor}</Text>{after}</Text>
    </Box>
    <Text dimColor wrap="truncate"> Tab panes · ↑↓ tasks · PgUp/PgDn scroll · /help · Ctrl+C stop/exit</Text>
  </Box>;
}
