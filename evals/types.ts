export interface EvalCase {
  name: string;
  prompt: string;
  /** Files to create in the temp directory before running the agent */
  setupFiles?: Record<string, string>;
  /** Shell command to verify the result. Runs in the temp dir. Exit 0 = pass. */
  verify: string;
}

export interface EvalResult {
  name: string;
  passed: boolean;
  durationMs: number;
  error?: string;
}
