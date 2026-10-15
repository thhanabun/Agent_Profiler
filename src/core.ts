// Programmatic Node clients use this module without importing React/Ink or CLI startup code.
export { SessionManager, type CreateSession, type ProfileChoice } from './application.js';
export { Engine, sessionSchema, configurationSchema, runSchema, type Session, type View, type Run, type PendingRequest } from './engine.js';
export { profileSchema, type Profile, type LoadedProfile } from './schema.js';
export { serveStdio } from './protocol.js';
export { requestSchema, parseRequest, methodSchemas, protocolMethods } from './contracts.js';
export type { ProtocolMethod, ProtocolRequest, ProtocolResults, ProtocolResponse, ProtocolEvent, ProtocolMessage, ProfileReadiness, ReadinessCheck } from './contracts.js';
export { acquireLock } from './storage.js';
