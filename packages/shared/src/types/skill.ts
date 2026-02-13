export type SkillStatus = 'enabled' | 'disabled';

export interface SkillConfig {
  requiredSecrets?: string[];
  pythonDependencies?: string[];
}

export interface SkillMetadata {
  name: string;
  description: string;
  version: string;
  author: string;
  builtIn: boolean;
}

export interface Skill {
  metadata: SkillMetadata;
  status: SkillStatus;
  filePath: string;
  loadedAt: string;
  config?: SkillConfig;
  hasTools: boolean;
  hasPrompt: boolean;
  secretKeys?: string[];
}
