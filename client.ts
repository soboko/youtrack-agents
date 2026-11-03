/** Compatibility entry point for the YouTrack provider API. */
export {YouTrackClient, createClient} from './src/youtrack/client.ts';
export {YouTrackError} from './src/youtrack/transport.ts';
export type {CollectionPage} from './src/youtrack/transport.ts';
export type {NamedComment} from './src/youtrack/client.ts';
export {loadConfig, configFiles, CONFIG_FILES, DEFAULT_BASE_URL, DEFAULT_PROJECT} from './src/config.ts';
export type {Config} from './src/config.ts';
export type {
  ClientOptions,
  ProjectField,
  IssueFieldValue,
  Issue,
  Comment,
  WorkItem,
  CreateIssueInput,
} from './src/youtrack/types.ts';
export {parseTokens, formatTokens} from './src/youtrack/tokens.ts';
