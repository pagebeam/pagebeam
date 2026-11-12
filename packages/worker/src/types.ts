export interface Viewport { name: string; width: number; height: number; scale: number }
export interface Job {
  id: string;
  url: string;
  viewports: Viewport[];
  fullPage: boolean;
  waitFor: string;
  format: 'png' | 'jpeg';
  uploads: Record<string, { url: string; headers: Record<string, string> }>;
}
export type Reason = 'private_address' | 'timeout' | 'navigation_failed';
export class CaptureFailure extends Error {
  constructor(readonly reason: Reason) { super(reason); }
}
export interface CaptureResult {
  takenAt: string;
  images: { viewport: string; width: number; height: number; bytes: Buffer }[];
}
