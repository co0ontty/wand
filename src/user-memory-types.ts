/** Single-owner, config-directory-local short-term memory. No credentials or raw tool output. */
export const USER_MEMORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const USER_MEMORY_MAX_EVENTS = 1000;
export const USER_MEMORY_TEXT_MAX_CHARS = 600;
export const USER_MEMORY_REFRESH_MS = 24 * 60 * 60 * 1000;
export const USER_MEMORY_CATEGORIES = ["communication", "workflow", "focus"] as const;
export type UserMemoryCategory = typeof USER_MEMORY_CATEGORIES[number];

export interface UserMemoryEvent {
  id: number;
  feature: string;
  text: string;
  createdAt: number;
}

export interface UserMemoryPreference {
  category: UserMemoryCategory;
  text: string;
  evidenceIds: number[];
}

export interface UserMemoryProfile {
  generatedAt: number;
  expiresAt: number;
  preferences: UserMemoryPreference[];
}

export interface UserMemoryState {
  enabled: boolean;
  revision: number;
  lastAttemptAt: number;
  sourceId: number;
  profile: UserMemoryProfile | null;
}

export interface UserMemoryView {
  enabled: boolean;
  retentionDays: number;
  eventCount: number;
  features: Array<{ feature: string; count: number }>;
  profile: UserMemoryProfile | null;
  refreshing: boolean;
  lastError?: string;
}
