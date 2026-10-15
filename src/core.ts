// UI hosts use this module without importing React/Ink or the executable entry point.
export { SessionManager, type CreateSession, type ProfileChoice } from './application.js';
export { Engine, sessionSchema, configurationSchema, runSchema, type Session, type View, type Run, type PendingRequest } from './engine.js';
export { profileSchema, type Profile, type LoadedProfile } from './schema.js';
export { serveStdio, requestSchema } from './protocol.js';
export { acquireLock } from './storage.js';
