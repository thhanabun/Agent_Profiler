import React, { useEffect, useState } from 'react';
import { Box, Text, useApp, useInput, useWindowSize } from 'ink';
import { App } from './ui.js';
import { SessionManager, type ProfileChoice } from './application.js';
import { modelFor } from './adapters.js';
import { redact, type Session } from './engine.js';
import { exitWithRestoreRetry } from './terminal.js';

export function WorkspaceApp({ manager, initialTitle }: { manager: SessionManager; initialTitle?: string }) {
  const { exit } = useApp();
  const size = useWindowSize();
  const [engine, setEngine] = useState(manager.active);
  const [screen, setScreen] = useState<'team' | 'sessions' | undefined>(manager.active ? undefined : 'team');
  const [choices, setChoices] = useState<ProfileChoice[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [step, setStep] = useState<'orchestrator' | 'workers'>('orchestrator');
  const [orchestrator, setOrchestrator] = useState<ProfileChoice>();
  const [workers, setWorkers] = useState<string[]>([]);
  const [title, setTitle] = useState<string | undefined>(initialTitle);
  const [cursor, setCursor] = useState(0);
  const [loading, setLoading] = useState(!manager.active);
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState('');
  const close = () => exitWithRestoreRetry(() => exit());
  const navigate = (kind: 'team' | 'sessions', nextTitle?: string) => {
    if (manager.active?.state.busy || manager.active?.state.request) throw new Error('Use /stop and wait for the active session before switching.');
    setTitle(nextTitle); setStep('orchestrator'); setLoading(true); setScreen(kind); setCursor(0); setError('');
  };
  useEffect(() => {
    if (!screen) return;
    let stale = false;
    setLoading(true); setError('');
    const load = async () => {
      if (screen === 'sessions') {
        await manager.active?.flush();
        const saved = (await manager.list()).filter(entry => entry.session.demo === Boolean(manager.options.demo)).map(entry => entry.session);
        if (!stale) { setSessions(saved); setCursor(0); }
      } else {
        const catalog = await manager.choices();
        if (stale) return;
        setChoices(catalog);
        const config = manager.active?.state.session.configuration;
        const match = (choice: ProfileChoice, id: string | undefined) => {
          if (choice.profile.manifest.id !== id) return false;
          const source = config?.profiles.find(profile => profile.id === id)?.source;
          if (source?.kind === 'image') return choice.profile.image?.digest === source.digest;
          return !choice.profile.image && (!source || choice.profile.checksum === source.checksum);
        };
        const index = catalog.findIndex(choice => match(choice, config?.orchestratorProfileId ?? 'orchestrator'));
        setCursor(Math.max(0, index));
        const ids = config?.workerProfileIds ?? ['implement', 'codex'];
        setWorkers(ids.map(id => catalog.find(choice => match(choice, id))?.reference).filter((ref): ref is string => Boolean(ref)));
      }
    };
    void load().catch(error => { if (!stale) setError(String(error)); }).finally(() => { if (!stale) setLoading(false); });
    return () => { stale = true; };
  }, [screen]);
  const entries = screen === 'sessions' ? sessions : step === 'workers' ? choices.filter(choice => choice.profile.manifest.id !== orchestrator?.profile.manifest.id) : choices;
  const selected = entries[cursor];
  const switchTo = async (work: () => Promise<NonNullable<typeof engine>>) => {
    setChanging(true); setError('');
    try { setEngine(await work()); setScreen(undefined); }
    catch (error) { setError(redact(error instanceof Error ? error.message : String(error))); }
    finally { setChanging(false); }
  };
  useInput((input, key) => {
    if (!screen) return;
    if (key.ctrl && input === 'c') { close(); return; }
    if (changing) return;
    if (key.escape) {
      if (screen === 'team' && step === 'workers') { setStep('orchestrator'); setCursor(Math.max(0, choices.findIndex(choice => choice.reference === orchestrator?.reference))); }
      else if (engine) setScreen(undefined);
      else if (screen === 'sessions') { setScreen('team'); setStep('orchestrator'); }
      else close();
      return;
    }
    if (loading) return;
    if (input === 's' && screen === 'team' && step === 'orchestrator') { navigate('sessions'); return; }
    if (key.upArrow || key.downArrow) { setCursor(previous => Math.max(0, Math.min(entries.length - 1, previous + (key.upArrow ? -1 : 1)))); return; }
    if (screen === 'sessions') {
      if (key.return && selected) void switchTo(() => manager.open((selected as Session).id));
      return;
    }
    if (step === 'orchestrator' && key.return && selected) {
      const choice = selected as ProfileChoice;
      setOrchestrator(choice);
      setWorkers(previous => previous.filter(ref => choices.find(choice => choice.reference === ref)?.profile.manifest.id !== choice.profile.manifest.id));
      setStep('workers'); setCursor(0); return;
    }
    if (step === 'workers' && input === ' ' && selected) {
      const choice = selected as ProfileChoice;
      setWorkers(previous => previous.includes(choice.reference) ? previous.filter(ref => ref !== choice.reference)
        : [...previous.filter(ref => choices.find(entry => entry.reference === ref)?.profile.manifest.id !== choice.profile.manifest.id), choice.reference]);
    }
    if (step === 'workers' && key.return && orchestrator) void switchTo(() => manager.create({ title, orchestrator: orchestrator.reference, workers }));
  }, { isActive: Boolean(screen) });
  if (!screen && engine) return <App key={engine.state.session.id} engine={engine} onNavigate={navigate} />;
  const rows = Math.max(3, Math.floor((size.rows - 11) / 2));
  const start = Math.max(0, cursor - rows + 1);
  const mode = manager.options.demo ? 'SIMULATION' : 'LIVE';
  const choice = screen === 'team' ? selected as ProfileChoice | undefined : undefined;
  return <Box flexDirection="column" paddingX={1} width={Math.max(30, size.columns)}>
    <Text bold color="cyan">WORKERDECK · {screen === 'sessions' ? 'SAVED SESSIONS' : 'NEW SESSION / TEAM'} · {mode}</Text>
    <Text dimColor wrap="truncate">{redact(manager.options.cwd)}</Text>
    <Text>{screen === 'sessions' ? 'Select a saved session to open. Work resumes only when you send /resume or a message.'
      : step === 'orchestrator' ? '1/2 · Choose the orchestrator profile' : `2/2 · Choose workers · Orchestrator: @${orchestrator?.profile.manifest.id}`}</Text>
    <Text dimColor>{screen === 'sessions' ? '↑↓ select · Enter open · Esc back'
      : step === 'orchestrator' ? '↑↓ select · Enter next · S saved sessions · Esc cancel'
        : '↑↓ select · Space toggle · Enter create · Esc back'}</Text>
    <Box flexDirection="column" marginY={1}>
      {loading ? <Text>Loading…</Text> : !entries.length ? <Text dimColor>{screen === 'sessions' ? 'No saved sessions in this mode.' : 'No profiles found.'}</Text>
        : entries.slice(start, start + rows).map((entry, offset) => {
          const active = cursor === start + offset;
          if (screen === 'sessions') {
            const session = entry as Session;
            return <Box key={session.id} flexDirection="column"><Text inverse={active} color={active ? 'cyan' : undefined} wrap="truncate">{active ? '›' : ' '} {redact(session.title)}{session.id === engine?.state.session.id ? ' · current' : ''}</Text><Text dimColor wrap="truncate">  {redact(session.updatedAt ?? session.createdAt ?? '')} · {session.id}</Text></Box>;
          }
          const item = entry as ProfileChoice;
          return <Box key={item.reference} flexDirection="column"><Text inverse={active} color={active ? 'cyan' : undefined} wrap="truncate">{active ? '›' : ' '} {step === 'workers' ? workers.includes(item.reference) ? '[x] ' : '[ ] ' : ''}@{item.profile.manifest.id} · {item.profile.manifest.harness} / {redact(modelFor(item.profile) ?? 'native default')}</Text><Text dimColor wrap="truncate">  {redact(item.reference)}</Text></Box>;
        })}
    </Box>
    {choice && <Text dimColor wrap="truncate">{redact(choice.profile.manifest.description)} · Skills: {choice.profile.manifest.skills.length} · Plugins: {choice.profile.manifest.plugins.length}</Text>}
    {screen === 'team' && step === 'workers' && <Text color="cyan">{workers.length ? `${workers.length} workers selected` : 'Chat only · no worker tasks available'} · {title ?? 'New session'}</Text>}
    <Text color={error ? 'red' : 'gray'} wrap="truncate">{error || (changing ? 'Opening session…' : engine ? 'The current chat stays saved. Team selection starts a new session.' : 'Choose a team. Work starts when you send a message.')}</Text>
  </Box>;
}
